/**
 * Where the season search runs.
 *
 * The recommendation is a beam search over the whole remaining season, and it
 * is the one piece of this app that costs real time: a couple of hundred
 * milliseconds on a phone. Run on the main thread it stops everything - a CSS
 * animation caught part way through does not quietly continue, it stalls and
 * jumps to its end - and the whole of app.js's motion timing existed to keep
 * that freeze away from anything that was moving.
 *
 * So the search is a job that can be handed somewhere else. This module is the
 * seam: whoever can run one off the main thread installs a runner here, and
 * core/plan.js hands its searches over instead of doing them itself. Nothing is
 * installed by default, which is deliberate - the scripts and the validators
 * want the search inline, synchronous and identical to what the browser
 * computes, and they get exactly that by installing nothing.
 *
 * The engine itself stays pure (core/recommend.js). This only decides where it
 * is called.
 */

/** @type {((request:object) => Promise<object>)|null} */
let runner = null;

/** Who to tell when a handed-off search has landed. */
const listeners = new Set();

/**
 * Install - or, with null, remove - the way to run a search off the main
 * thread.
 *
 * @param {((request:object) => Promise<object>)|null} run Takes the plain
 *   request core/recommend.js's searchRequestFor produces and resolves with
 *   what recommendPath would have returned. Removing the runner is how a
 *   failure gets out of the way: the next build searches inline instead.
 */
export function setSearchRunner(run) {
  runner = run ?? null;
}

export function searchRunner() {
  return runner;
}

/**
 * Hear about searches that finish away from the main thread.
 *
 * A build that hands its search off comes back with the plan it has - a recent
 * one standing in, or none - and is painted like that. This is what says the
 * real answer has arrived and the board is worth building again.
 *
 * @param {() => void} listener
 * @returns {() => void} Stop listening.
 */
export function onSearchSettled(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Called by core/plan.js when a handed-off search resolves, fails or is dropped. */
export function announceSearchSettled() {
  for (const listener of [...listeners]) listener();
}
