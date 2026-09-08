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
 * @param {string} code Which league's shared state to open. Every league has
 *   its own document, row and storage key, keyed by its code, so opening one
 *   never mixes it with another.
 */
export async function createStore(code) {
  for (const create of [createArtifactStore, createSupabaseStore]) {
    try {
      const store = await create(code);
      if (store) return store;
    } catch {
      /* try the next one */
    }
  }
  return createLocalStore(code);
}
