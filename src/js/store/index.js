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
import { createLocalStore, readLocalEntry } from "./local.js";
import { knownRow } from "./rows.js";

/**
 * A pool's board as it can be had without asking anybody: the row this session
 * already read (store/rows.js), or failing that this device's own copy.
 *
 * For work done ahead of a tap - planning every pool while the home page is
 * idle (warmPools in app.js) - where opening a store would mean a round trip
 * and a subscription for a board nobody has asked to see. It is a head start,
 * not a read: the store is still what a board opens on, and this being a
 * version behind only means the head start was for the wrong board and the
 * open searches for itself.
 *
 * @param {string} code
 * @param {string} kind
 * @returns {object} An entry, empty where nothing is known.
 */
export function knownEntry(code, kind) {
  return knownRow(code, kind)?.entry ?? readLocalEntry(code, kind);
}

/**
 * @param {string} code Which league's shared state to open.
 * @param {string} kind Which of that league's pools, as a kind id (see
 *   src/js/sports.js). Every pool has its own document, row and storage key,
 *   keyed by the league's code and the kind, so opening one never mixes it
 *   with another league's board or with the same league's other pools.
 * @param {{seed?:{entry:object, version:string|null}|null}} [options] The
 *   row as the app last saw it (store/rows.js), for a store that can open on
 *   it and check it behind the board; see createSupabaseStore.
 */
export async function createStore(code, kind, options = {}) {
  for (const create of [createArtifactStore, createSupabaseStore]) {
    try {
      const store = await create(code, kind, options);
      if (store) return store;
    } catch {
      /* try the next one */
    }
  }
  return createLocalStore(code, kind);
}
