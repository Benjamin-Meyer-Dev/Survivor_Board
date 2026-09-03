/**
 * Shared store backed by the Claude Artifact `db` capability.
 *
 * Used only by the artifact build (see scripts/build-artifact.mjs). On GitHub
 * Pages `claude` is undefined and this resolves null, so store/index.js falls
 * through to Supabase. One codebase, three backends, chosen at runtime.
 */

import { emptyEntry } from "../core/plan.js";
import { scopeFor } from "../config.js";

export async function createArtifactStore(league) {
  if (typeof globalThis.claude?.use !== "function") return null;

  let db = null;
  try {
    db = await globalThis.claude.use("db");
  } catch {
    return null;
  }
  if (!db) return null;

  const doc = db.doc(scopeFor(league).doc);

  /** The capability has returned both shapes across contract versions. */
  const unwrap = (snapshot) => {
    if (!snapshot) return null;
    const value = typeof snapshot.data === "function" ? snapshot.data() : snapshot;
    return value && typeof value === "object" ? value : null;
  };

  return {
    kind: "artifact-db",
    shared: true,
    canWrite: true,

    async init() {
      try {
        return { ...emptyEntry(), ...(unwrap(await doc.get()) ?? {}) };
      } catch {
        return emptyEntry();
      }
    },

    subscribe(listener) {
      try {
        return doc.onSnapshot((snapshot) => {
          const value = unwrap(snapshot);
          if (value?.picks) listener({ ...emptyEntry(), ...value });
        });
      } catch {
        return () => {};
      }
    },

    async save(entry) {
      await doc.set({ ...entry, at: Date.now() });
    },
  };
}
