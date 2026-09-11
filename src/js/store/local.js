/**
 * Per-device fallback store. Used when Supabase is not configured, or when it
 * fails to load. Nothing here is shared between people - the home page and the
 * notices both say so - so a league code from this build opens nothing on
 * anyone else's phone.
 */

import { scopeFor } from "../config.js";
import { emptyEntry } from "../core/plan.js";

/**
 * This device's copy of a pool's board, whoever is going to use it.
 *
 * Read out here rather than inside the store, because the copy on the device
 * is also the head start something with no store in its hand wants: planning a
 * pool before anyone has opened it (warmPools in app.js) needs the entry and
 * nothing else, and opening a store for it would be a round trip and a
 * subscription for a board nobody is looking at.
 *
 * @param {string} code
 * @param {string} kind
 * @returns {object} An entry, empty where this device has none.
 */
export function readLocalEntry(code, kind) {
  const { storageKey: key, legacyStorageKey } = scopeFor(code, kind);
  try {
    // The keyed copy, or the one a league saved before it could hold more
    // than one pool: that board belongs to the one pool it had.
    const raw = localStorage.getItem(key) ?? localStorage.getItem(legacyStorageKey);
    return raw ? { ...emptyEntry(), ...JSON.parse(raw) } : emptyEntry();
  } catch {
    return emptyEntry();
  }
}

export function createLocalStore(code, kind) {
  const listeners = new Set();
  const { storageKey: key } = scopeFor(code, kind);

  const read = () => readLocalEntry(code, kind);

  return {
    kind: "local",
    shared: false,
    canWrite: true,

    async init() {
      return read();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Nothing is announced to listeners: there is no other device to hear
    // from, and echoing a save back to the board that made it only ever let a
    // quick second tap be overwritten by the first one's echo for a moment.
    async save(entry) {
      try {
        localStorage.setItem(key, JSON.stringify(entry));
      } catch {
        /* private mode, quota, or blocked storage - state stays in memory */
      }
    },
  };
}
