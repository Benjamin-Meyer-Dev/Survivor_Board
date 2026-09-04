/**
 * Shared store backed by Supabase.
 *
 * One row in `entries` holds the whole pool entry as JSON. Realtime pushes
 * the row to every open device on change, which is what makes two phones
 * stay in sync. See supabase/schema.sql for the table and its RLS policy.
 *
 * The client library is loaded from the CDN on demand so the app has no
 * build step and no npm dependency at runtime.
 *
 * What reaches the board is gated by version, because rows do not arrive in
 * order. A poll can be answered with the row as it stood before a tap that
 * happened while the request was out; realtime can deliver the echo of one
 * save after the next one has gone. Either one, let through, puts the old
 * state back on screen for a beat before the right one lands again, and that
 * is how a lock read as lock, unlock, lock. The rules that stop it:
 *
 *   - a row carrying a version this device saved is our own echo, however
 *     late it comes back, and is dropped;
 *   - nothing is applied while one of our saves is on the wire, since that
 *     save decides what the row holds next;
 *   - a poll whose answer arrives after the version moved on is stale and is
 *     dropped, the next poll will ask again;
 *   - and, as before, a row with the version already on screen is not news.
 *
 * The poll is also the safety net for the rare change from another device
 * that commits during one of our saves: dropped from realtime, it is picked up
 * on the next tick.
 */

import { CONFIG, scopeFor } from "../config.js";
import { emptyEntry } from "../core/plan.js";

const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

/** How often to read the row directly, as a backstop for realtime. */
const POLL_MS = 1500;

/** How many of this device's own versions to remember for the echo check. */
const OWN_VERSIONS_KEPT = 50;

/**
 * A version as a number, so the two renderings of one instant compare equal.
 *
 * Ours goes out as JavaScript's ISO string (`...789Z`) and comes back, from
 * realtime and from a poll alike, in Postgres's rendering of a timestamptz
 * (`...789+00:00`). Compared as text they never matched, so every save's own
 * echo was let through as though it were someone else's change and the board
 * rendered twice for each tap. Anything that does not parse is kept as text.
 */
function versionKey(version) {
  if (!version) return null;
  const parsed = Date.parse(version);
  return Number.isNaN(parsed) ? version : parsed;
}

function sameVersion(a, b) {
  const [left, right] = [versionKey(a), versionKey(b)];
  return left !== null && left === right;
}

/**
 * @param {string} league Which pool's row to open.
 * @param {{client?: object}} [options] A ready client, for tests that cannot
 *   load the CDN. Production leaves this out and loads the library.
 */
export async function createSupabaseStore(league, { client: given } = {}) {
  const { url, publishableKey, table } = CONFIG.supabase;
  if (!given && (!url || !publishableKey)) return null;

  // One row per league, so the two pools never overwrite each other.
  const entryId = scopeFor(league).entryId;

  let client = given;
  if (!client) {
    let createClient;
    try {
      ({ createClient } = await import(/* @vite-ignore */ CDN));
    } catch {
      return null;
    }
    client = createClient(url, publishableKey, {
      auth: { persistSession: false },
    });
  }

  const listeners = new Set();
  const expectedDigest = CONFIG.passcode.digest;
  let canWrite = !expectedDigest;

  /** The version of the row the board is showing. */
  let lastVersion = null;
  /** Versions this device has saved, newest last. */
  const ownVersions = [];
  /** Saves on the wire right now. */
  let saving = 0;

  const isOwn = (version) => ownVersions.includes(versionKey(version));

  /**
   * Hand a row to a listener if it is news. `seenBefore` is the version that
   * was current when a poll asked for the row; a poll whose answer lands after
   * the version has moved on is out of date, whatever it says.
   */
  function publish(listener, row, seenBefore = lastVersion) {
    const entry = row?.entry;
    if (!entry || saving > 0) return;
    if (seenBefore !== lastVersion) return;
    if (isOwn(row.updated_at) || sameVersion(row.updated_at, lastVersion)) return;
    lastVersion = row.updated_at ?? lastVersion;
    listener({ ...emptyEntry(), ...entry });
  }

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
            publish(listener, payload.new);
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
        const seenBefore = lastVersion;
        try {
          const { data, error } = await client
            .from(table)
            .select("entry, updated_at")
            .eq("id", entryId)
            .maybeSingle();
          if (!error && data) publish(listener, data, seenBefore);
        } finally {
          polling = false;
        }
      };
      const pollTimer = setInterval(poll, POLL_MS);

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
      // realtime event before the upsert promise resolves, and remembering
      // the version is what lets that echo be recognised whenever it arrives.
      lastVersion = version;
      ownVersions.push(versionKey(version));
      if (ownVersions.length > OWN_VERSIONS_KEPT) ownVersions.shift();

      saving += 1;
      try {
        const { error } = await client
          .from(table)
          .upsert({ id: entryId, entry, updated_at: version });
        if (error) {
          lastVersion = previousVersion;
          throw error;
        }
      } finally {
        saving -= 1;
      }
    },
  };
}
