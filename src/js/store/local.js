/**
 * Per-device fallback store. Used when Supabase is not configured, or when it
 * fails to load. Nothing here is shared between people - the home page and the
 * notices both say so - so a league code from this build opens nothing on
 * anyone else's phone.
 */

import { scopeFor } from "../config.js";
import { emptyEntry } from "../core/plan.js";

export function createLocalStore(code, kind) {
  const listeners = new Set();
  const { storageKey: key, legacyStorageKey } = scopeFor(code, kind);

  function read() {
    try {
      // The keyed copy, or the one a league saved before it could hold more
      // than one pool: that board belongs to the one pool it had.
      const raw = localStorage.getItem(key) ?? localStorage.getItem(legacyStorageKey);
      return raw ? { ...emptyEntry(), ...JSON.parse(raw) } : emptyEntry();
    } catch {
      return emptyEntry();
    }
  }

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
