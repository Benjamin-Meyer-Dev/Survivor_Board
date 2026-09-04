/**
 * Shared store backed by Supabase.
 *
 * One row in `entries` holds the whole pool entry as JSON. Realtime pushes
 * the row to every open device on change, which is what makes two phones
 * stay in sync. See supabase/schema.sql for the table and its RLS policy.
 *
 * The client library is loaded from the CDN on demand so the app has no
 * build step and no npm dependency at runtime.
 */

import { CONFIG, scopeFor } from "../config.js";
import { emptyEntry } from "../core/plan.js";

const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

/**
 * Whether two `updated_at` values name the same instant.
 *
 * Ours goes out as JavaScript's ISO string (`...789Z`) and comes back, from
 * realtime and from a poll alike, in Postgres's rendering of a timestamptz
 * (`...789+00:00`). Compared as text they never matched, so every save's own
 * echo was let through as though it were someone else's change and the board
 * rendered twice for each tap. Anything that does not parse falls back to text.
 */
function sameVersion(a, b) {
  if (!a || !b) return false;
  const left = Date.parse(a);
  const right = Date.parse(b);
  return Number.isNaN(left) || Number.isNaN(right) ? a === b : left === right;
}

export async function createSupabaseStore(league) {
  const { url, publishableKey, table } = CONFIG.supabase;
  if (!url || !publishableKey) return null;

  // One row per league, so the two pools never overwrite each other.
  const entryId = scopeFor(league).entryId;

  let createClient;
  try {
    ({ createClient } = await import(/* @vite-ignore */ CDN));
  } catch {
    return null;
  }

  const client = createClient(url, publishableKey, {
    auth: { persistSession: false },
  });

  const listeners = new Set();
  const expectedDigest = CONFIG.passcode.digest;
  let canWrite = !expectedDigest;
  let lastVersion = null;

  return {
    kind: "supabase",
    shared: true,

    get canWrite() {
      return canWrite;
    },

    /** Unlock writes with the verified passcode digest; see core/passcode.js. */
    unlock(digest) {
      canWrite = !expectedDigest || digest === expectedDigest;
      return canWrite;
    },

    async init() {
      const { data, error } = await client
        .from(table)
        .select("entry, updated_at")
        .eq("id", entryId)
        .maybeSingle();

      if (error || !data) return emptyEntry();
      lastVersion = data.updated_at;
      return { ...emptyEntry(), ...data.entry };
    },

    subscribe(listener) {
      listeners.add(listener);

      const channel = client
        .channel(`entries:${entryId}`)
        .on(
          "postgres_changes",
          { event: "*", schema: "public", table, filter: `id=eq.${entryId}` },
          (payload) => {
            publish(payload.new);
          },
        )
        .subscribe((status) => {
          // A dropped websocket should not leave an open board stale until its
          // next reload. Poll immediately while the normal fallback continues.
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") poll();
        });

      let polling = false;
      const poll = async () => {
        if (polling) return;
        polling = true;
        try {
          const { data, error } = await client
            .from(table)
            .select("entry, updated_at")
            .eq("id", entryId)
            .maybeSingle();
          if (!error && data) publish(data);
        } finally {
          polling = false;
        }
      };
      const pollTimer = setInterval(poll, 1500);

      function publish(row) {
        const entry = row?.entry;
        if (!entry || sameVersion(row.updated_at, lastVersion)) return;
        lastVersion = row.updated_at ?? lastVersion;
        listener({ ...emptyEntry(), ...entry });
      }

      return () => {
        listeners.delete(listener);
        clearInterval(pollTimer);
        client.removeChannel(channel);
      };
    },

    async save(entry) {
      if (!canWrite) return;
      const previousVersion = lastVersion;
      const version = new Date().toISOString();

      // Mark this version before sending it. Supabase can deliver our own
      // realtime event before the upsert promise resolves; without this guard,
      // that echo causes a second board render for every local action.
      lastVersion = version;
      const { error } = await client
        .from(table)
        .upsert({ id: entryId, entry, updated_at: version });
      if (error) {
        lastVersion = previousVersion;
        throw error;
      }
    },
  };
}
