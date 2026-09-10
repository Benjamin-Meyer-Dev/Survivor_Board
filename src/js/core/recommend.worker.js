/**
 * The season search, on its own thread.
 *
 * A module worker whose whole job is to call recommendPath and post the answer
 * back. The engine is pure and environment-free by design (core/recommend.js),
 * so there is nothing to adapt: the same code the scripts run and the same code
 * the main thread falls back to.
 *
 * One message in, one message out, each carrying the id the caller gave it -
 * results that are no longer wanted are dropped by the caller rather than
 * cancelled here, because a beam search has no safe place to stop half way and
 * finishing it costs less than the machinery to interrupt it would.
 *
 * Not part of the artifact bundle: an artifact is one document on a sandboxed
 * origin with no sibling files to load a worker from, so that build searches
 * inline (see scripts/build-artifact.mjs and worker-search.js).
 */

import { recommendPath } from "./recommend.js";

self.addEventListener("message", (event) => {
  const { id, request } = event.data ?? {};
  try {
    self.postMessage({ id, value: recommendPath(request) });
  } catch (error) {
    // The main thread searches this one inline instead. A message is the only
    // way to say so: an exception here would surface as a bare worker error
    // with no id on it, and the caller would have nothing to fail.
    self.postMessage({ id, error: error?.message ?? String(error) });
  }
});
