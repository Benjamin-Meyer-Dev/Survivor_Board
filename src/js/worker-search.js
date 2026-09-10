/**
 * Hand the season search to a worker, where there is one to hand it to.
 *
 * The search takes a couple of hundred milliseconds on a phone and cannot be
 * interrupted, so on the main thread it is a freeze: whatever was animating
 * stalls and jumps, and every timing in app.js was arranged around keeping the
 * two apart. Off the main thread the freeze is somebody else's, and the board
 * can be dragged, scrolled and tapped straight through a re-plan.
 *
 * Best effort, and quiet about it. Three things can go wrong - no Worker at
 * all, a module worker the browser will not build, a worker file that cannot be
 * fetched (the artifact build has no sibling files) - and each one means the
 * same thing: search on the main thread, as the app always did. So a failure
 * takes the runner back out (core/search.js) rather than being reported.
 */

import { setSearchRunner } from "./core/search.js";

/** How long to give a search before deciding the worker is not coming back. */
const PATIENCE_MS = 20000;

/**
 * @returns {boolean} Whether searches will be handed off. False is not a
 *   failure: it means the board searches inline.
 */
export function useWorkerForSearch() {
  // An artifact is one document with no siblings to load a worker from, and it
  // says so by carrying its data inline.
  if (typeof Worker !== "function" || globalThis.SURVIVOR_DATA) return false;

  let worker;
  try {
    worker = new Worker(new URL("./core/recommend.worker.js", import.meta.url), {
      type: "module",
    });
  } catch {
    return false;
  }

  /** Searches on the wire, by the id they went out with. */
  const waiting = new Map();
  let next = 0;

  const settle = (id, settleWith) => {
    const pending = waiting.get(id);
    if (!pending) return;
    waiting.delete(id);
    clearTimeout(pending.timer);
    settleWith(pending);
  };

  /** The worker is no use. Fail everything on the wire and stand down. */
  const abandon = (reason) => {
    setSearchRunner(null);
    for (const id of [...waiting.keys()]) settle(id, (p) => p.reject(new Error(reason)));
    worker.terminate();
  };

  worker.addEventListener("message", (event) => {
    const { id, value, error } = event.data ?? {};
    settle(id, (pending) => (error ? pending.reject(new Error(error)) : pending.resolve(value)));
  });

  // A worker that cannot load its module reports it here, asynchronously, long
  // after the constructor returned happily.
  worker.addEventListener("error", () => abandon("The search worker stopped"));
  worker.addEventListener("messageerror", () => abandon("The search could not be sent"));

  setSearchRunner(
    (request) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(
          () => settle(id, (p) => p.reject(new Error("The search timed out"))),
          PATIENCE_MS,
        );
        waiting.set(id, { resolve, reject, timer });
        try {
          worker.postMessage({ id, request });
        } catch (error) {
          // Something in the request would not clone. Inline from here on.
          settle(id, (p) => p.reject(error));
          setSearchRunner(null);
        }
      }),
  );

  return true;
}
