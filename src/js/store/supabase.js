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
  let canWrite = !CONFIG.passcode;

  return {
    kind: "supabase",
    shared: true,

    get canWrite() {
      return canWrite;
    },

    /** Unlock writes with the pool passcode. */
    unlock(passcode) {
      canWrite = !CONFIG.passcode || passcode === CONFIG.passcode;
      return canWrite;
    },

    async init() {
      const { data, error } = await client
        .from(table)
        .select("entry")
        .eq("id", entryId)
        .maybeSingle();

      if (error || !data) return emptyEntry();
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
            const entry = payload.new?.entry;
            if (entry) listener({ ...emptyEntry(), ...entry });
          },
        )
        .subscribe();

      return () => {
        listeners.delete(listener);
        client.removeChannel(channel);
      };
    },

    async save(entry) {
      if (!canWrite) return;
      await client.from(table).upsert({ id: entryId, entry, updated_at: new Date().toISOString() });
    },
  };
}
