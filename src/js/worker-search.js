/**
 * Hand the season search to a worker, where there is one to hand it to.
 *
 * The search takes a couple of hundred milliseconds on a phone and cannot be
 * interrupted, so on the main thread it is a freeze: whatever was animating
 * stalls and jumps, and every timing in app.js was arranged around keeping the
 * two apart. Off the main thread the freeze is somebody else's, and the board
 * can be dragged, scrolled and tapped straight through a re-plan.
 *
 * Best effort, and quiet about it on screen. Three things can go wrong - no
 * Worker at all, a module worker the browser will not build, a worker file that
 * cannot be fetched (the artifact build has no sibling files) - and each one
 * means the same thing: search on the main thread, as the app always did. So a
 * failure takes the runner back out (core/search.js) rather than being
 * reported. It is not quiet in the console, though: what happened to the worker
 * - when it started, when it said it was ready, why it was given up on, how
 * long each search took - is kept on `globalThis.SURVIVOR_DIAGNOSTICS.search`
 * and marked on the performance timeline (`survivor:search-worker:*`,
 * `survivor:search`), so a trace taken on a phone can tell a search that ran
 * here from one that ran there.
 *
 * The worker says when it is ready (core/recommend.worker.js). Until it does,
 * searches queue here rather than being posted into the dark: the browser
 * would hold them for a worker still loading, but a worker that never loads
 * would hold them for ever, and this is what turns that into a fallback with
 * a reason attached.
 */

import { setSearchRunner } from "./core/search.js";

/** How long to give a search before deciding the worker is not coming back. */
const PATIENCE_MS = 20000;

/** How long the worker gets to say it is ready before it is given up on. */
const STARTUP_MS = 8000;

/** What happened to the worker, for a console and for tests. */
const diagnostics = (globalThis.SURVIVOR_DIAGNOSTICS ??= {});
const status = (diagnostics.search = {
  /** "worker" while searches are handed off, "inline" otherwise. */
  mode: "inline",
  startedAt: null,
  readyAt: null,
  startupMs: null,
  /** Why searches run inline, when they do. Null while the worker is in use. */
  fallbackReason: null,
  /** Searches the worker has answered, and how long the last one took. */
  searches: 0,
  lastSearchMs: null,
});

const now = () => globalThis.performance?.now?.() ?? Date.now();

function mark(name) {
  try {
    globalThis.performance?.mark?.(name);
  } catch {
    /* an old browser without marks loses nothing but the mark */
  }
}

function measure(name, start) {
  try {
    globalThis.performance?.measure?.(name, { start, end: now() });
  } catch {
    /* as above */
  }
}

/**
 * @returns {boolean} Whether searches will be handed off. False is not a
 *   failure: it means the board searches inline.
 */
export function useWorkerForSearch() {
  // An artifact is one document with no siblings to load a worker from, and it
  // says so by carrying its data inline.
  if (typeof Worker !== "function") {
    status.fallbackReason = "this browser has no Worker";
    return false;
  }
  if (globalThis.SURVIVOR_DATA) {
    status.fallbackReason = "the artifact build has no worker file to load";
    return false;
  }

  let worker;
  try {
    worker = new Worker(new URL("./core/recommend.worker.js", import.meta.url), {
      type: "module",
    });
  } catch (error) {
    status.fallbackReason = `no module worker: ${error?.message ?? error}`;
    return false;
  }

  status.mode = "worker";
  status.startedAt = now();
  mark("survivor:search-worker:start");

  /** Searches on the wire, by the id they went out with. */
  const waiting = new Map();
  /** Searches asked for before the worker said it was ready. */
  const queued = [];
  let ready = false;
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
    clearTimeout(startup);
    status.mode = "inline";
    status.fallbackReason = reason;
    mark("survivor:search-worker:abandoned");
    setSearchRunner(null);
    queued.length = 0;
    for (const id of [...waiting.keys()]) settle(id, (p) => p.reject(new Error(reason)));
    worker.terminate();
  };

  const startup = setTimeout(() => {
    if (!ready) abandon(`the search worker did not start within ${STARTUP_MS} ms`);
  }, STARTUP_MS);

  const post = (message) => {
    try {
      worker.postMessage(message);
    } catch (error) {
      // Something in the request would not clone. Inline from here on.
      settle(message.id, (p) => p.reject(error));
      abandon(`a search could not be sent to the worker: ${error?.message ?? error}`);
    }
  };

  worker.addEventListener("message", (event) => {
    const { id, value, error, ready: hello } = event.data ?? {};
    if (hello) {
      ready = true;
      clearTimeout(startup);
      status.readyAt = now();
      status.startupMs = Math.round(status.readyAt - status.startedAt);
      mark("survivor:search-worker:ready");
      measure("survivor:search-worker:startup", status.startedAt);
      for (const message of queued.splice(0)) post(message);
      return;
    }
    settle(id, (pending) => {
      status.searches += 1;
      status.lastSearchMs = Math.round(now() - pending.startedAt);
      measure("survivor:search", pending.startedAt);
      if (error) pending.reject(new Error(error));
      else pending.resolve(value);
    });
  });

  // A worker that cannot load its module reports it here, asynchronously, long
  // after the constructor returned happily.
  worker.addEventListener("error", (event) => {
    abandon(`the search worker stopped: ${event?.message ?? "no detail"}`);
  });
  worker.addEventListener("messageerror", () => abandon("a search could not be read back"));

  setSearchRunner(
    (request) =>
      new Promise((resolve, reject) => {
        const id = ++next;
        const timer = setTimeout(
          () => settle(id, (p) => p.reject(new Error("The search timed out"))),
          PATIENCE_MS,
        );
        waiting.set(id, { resolve, reject, timer, startedAt: now() });
        const message = { id, request };
        if (ready) post(message);
        else queued.push(message);
      }),
  );

  return true;
}
