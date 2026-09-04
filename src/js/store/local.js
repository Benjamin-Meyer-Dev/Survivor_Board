/**
 * Per-device fallback store. Used when Supabase is not configured, or when
 * it fails to load. Nothing here is shared between people - the UI says so.
 */

import { scopeFor } from "../config.js";
import { emptyEntry } from "../core/plan.js";

export function createLocalStore(league) {
  const listeners = new Set();
  const key = scopeFor(league).storageKey;

  function read() {
    try {
      const raw = localStorage.getItem(key);
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
