/**
 * Store selection, most-shared first.
 *
 *   artifact db  - only present in the Claude artifact build
 *   supabase     - the GitHub Pages backend, when config.js has keys
 *   local        - per-device fallback, always works
 *
 * Callers get one interface either way and read `store.shared` to decide
 * whether to warn that changes stay on this device.
 */

import { createArtifactStore } from "./artifact.js";
import { createSupabaseStore } from "./supabase.js";
import { createLocalStore } from "./local.js";

/**
 * @param {string} league Which pool's entry to open. Each league has its own
 *   document, row and storage key, so switching never mixes the two boards.
 */
export async function createStore(league) {
  for (const create of [createArtifactStore, createSupabaseStore]) {
    try {
      const store = await create(league);
      if (store) return store;
    } catch {
      /* try the next one */
    }
  }
  return createLocalStore(league);
}
