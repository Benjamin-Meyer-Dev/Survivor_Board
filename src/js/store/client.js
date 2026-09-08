/**
 * The Supabase client, loaded once for the whole app.
 *
 * Two things need it - the league directory (store/directory.js) and a
 * league's own shared state (store/supabase.js) - and they must not each load
 * their own: two clients means two copies of the library over the network and
 * two realtime sockets to the same project.
 *
 * Loaded from the CDN on demand, so the app keeps its promise of no build step
 * and no runtime dependency to install. Pinned, because an unpinned major is a
 * silent upgrade on somebody's phone in the middle of a season.
 */

import { CONFIG } from "../config.js";

const CDN = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm";

let pending = null;

/**
 * @returns {Promise<object|null>} Null when there are no keys configured, or
 *   when the library cannot be fetched - both of which mean "run on the
 *   per-device store", not "fail".
 */
export function supabaseClient() {
  const { url, publishableKey } = CONFIG.supabase;
  if (!url || !publishableKey) return Promise.resolve(null);

  pending ??= import(/* @vite-ignore */ CDN)
    .then(({ createClient }) =>
      createClient(url, publishableKey, { auth: { persistSession: false } }),
    )
    .catch(() => null);

  return pending;
}

/**
 * Stand a client in, for the validators.
 *
 * The scripts cannot load the library from a CDN and must still exercise the
 * directory against something that behaves like a table. store/supabase.js
 * takes a ready client as an argument for the same reason; the directory has
 * no such argument to take, because nothing in the app would ever pass one.
 *
 * @param {object|null} client
 */
export function setSupabaseClient(client) {
  pending = client ? Promise.resolve(client) : null;
}

/** Whether this build has a backend at all, without loading it to find out. */
export function sharingAvailable() {
  return Boolean(CONFIG.supabase.url && CONFIG.supabase.publishableKey);
}
