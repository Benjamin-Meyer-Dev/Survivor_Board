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
 * @param {string} code Which league's shared state to open.
 * @param {string} kind Which of that league's pools, as a kind id (see
 *   src/js/sports.js). Every pool has its own document, row and storage key,
 *   keyed by the league's code and the kind, so opening one never mixes it
 *   with another league's board or with the same league's other pools.
 */
export async function createStore(code, kind) {
  for (const create of [createArtifactStore, createSupabaseStore]) {
    try {
      const store = await create(code, kind);
      if (store) return store;
    } catch {
      /* try the next one */
    }
  }
  return createLocalStore(code, kind);
}
