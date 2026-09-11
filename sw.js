/**
 * Service worker. Two jobs: make the board installable, which Chrome will not
 * offer without a fetch handler, and make opening it feel instant, from the
 * home screen or with no signal.
 *
 * What the board is made of is served from the cache first and refreshed in
 * the background: the page, its stylesheets and modules, the icons, the fonts
 * from Google and the Supabase client from its CDN. A launch never waits on the
 * network for any of them. It used to: every file went to the network before
 * the cached copy was even considered, so opening from the home screen on a
 * weak signal stalled on a blank screen, and then the fonts arrived late and
 * reflowed the startup screen under the play. The price is that a deploy is
 * picked up on the launch after the one that fetched it.
 *
 * The data files under data/ come in two kinds. The ones the odds bot rewrites
 * daily - the lines, the fit to them, the availability report, the pool's
 * numbers - go network-first with a time limit, then fall back to the last
 * copy, because the board must not show yesterday's lines when today's are a
 * fetch away. The ones that describe the season and sit still all week - the
 * calendar, the roster, the fixtures, the shipped ratings, the fitted model -
 * are served like the shell, from the cache first (isSettledData): they were
 * two thirds of the requests an open made and every one of them waited on the
 * network for bytes the cache already held. All of them are stored under the
 * URL with any query stripped off: whatever a caller asks for, the fallback has
 * to be able to find it, and a copy stored under a one-off query string is a
 * copy nothing will ever match again.
 *
 * There is still no precache list: whatever the app fetches while online is
 * what is available offline.
 *
 * Both strategies keep a copy for next time, and both hand back a response
 * before that copy has been written. So the write is handed to
 * `event.waitUntil` rather than left running on its own: a service worker is
 * killed as soon as the events it is handling are done with, and a detached
 * `fetch().then(cache.put)` is not one of them - which made "the next launch
 * opens with it" a hope rather than a promise, most often exactly when it
 * mattered, on the launch where the worker had just been started to serve one
 * navigation and had nothing else to keep it up.
 */

/* Bumped when the shell changes shape: v3 is the home page, the start screen
   and the board as separate sections, which a device holding v2 must not keep
   half of. */
const CACHE = "survivor-board-v3";

/** How long to wait for fresh data before opening with the last copy. */
const DATA_TIMEOUT_MS = 2500;

/** Cross-origin hosts whose files are part of the shell. Supabase itself is not. */
const SHELL_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

const isData = (url) => /\/data\/.+\.json$/.test(url.pathname);

/**
 * The data files a season is described by, which the daily refresh leaves
 * alone: the calendar, the roster, the fixtures, the ratings it shipped with
 * and the fitted model. The same five app.js holds for the session
 * (SETTLED_FILES there). They open from the cache like the shell does, and a
 * change to one is picked up on the launch after the one that fetched it -
 * where the lines, the fit to them, the availability report and the pool's
 * numbers still go to the network first, because those are what the refresh
 * rewrites and a board must not show yesterday's when today's are a fetch away.
 */
const isSettledData = (url) =>
  /\/data\/[^/]+\/(plan|teams|schedule|ratings|calibration)\.json$/.test(url.pathname);

self.addEventListener("install", () => {
  // Nothing to precache; take over as soon as this version is ready.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(names.filter((name) => name !== CACHE).map((name) => caches.delete(name)));
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin === self.location.origin) {
    if (!isData(url)) event.respondWith(cachedFirst(event));
    // Under the bare URL either way, so a copy freshFirst kept is one
    // cachedFirst finds, and the other way round.
    else if (isSettledData(url)) event.respondWith(cachedFirst(event, bareUrl(request.url)));
    else event.respondWith(freshFirst(event));
  } else if (SHELL_HOSTS.includes(url.hostname)) {
    event.respondWith(cachedFirst(event));
  }
  // Anything else goes straight to the network.
});

/** Whether a response is worth keeping as the copy to open with next time. */
function keepable(response) {
  // A font stylesheet loaded without CORS comes back opaque, status 0. It is
  // still the file the browser will use, so it is kept; only errors are not.
  return response.ok || response.type === "opaque";
}

/**
 * The cached copy at once when there is one, the network otherwise, and in
 * either case the network's answer becomes the copy for next time.
 *
 * @param {FetchEvent} event
 * @param {string} [key] What the copy is kept under; the request's own URL
 *   unless a caller says otherwise.
 */
async function cachedFirst(event, key = event.request.url) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  // ignoreVary: Google's font stylesheet varies on Sec-Fetch headers, which no
  // stored request carries, and a copy that cannot be matched is no copy.
  const cached = await cache.match(key, { ignoreVary: true });

  const refresh = fetch(request);
  // Attached before the response is handed anywhere, so the copy is taken
  // while the body is certainly still unread - and held by the event, so the
  // worker is not free to stop before it has been written.
  event.waitUntil(keep(cache, key, refresh));

  if (cached) return cached;
  try {
    return await refresh;
  } catch (error) {
    // An offline navigation with nothing cached for that exact URL still gets
    // the shell, which is the whole app.
    if (request.mode === "navigate") {
      const shell = await cache.match("./");
      if (shell) return shell;
    }
    throw error;
  }
}

/**
 * The network's answer when it comes in time, the last copy when it does not
 * or cannot. A late answer is still kept, so the next launch opens with it -
 * which is what waitUntil is for: the answer this event is waiting for has
 * already been given by then, and without it the worker would be free to stop
 * before the file it just fetched had been written anywhere.
 */
async function freshFirst(event) {
  const { request } = event;
  const cache = await caches.open(CACHE);
  const key = bareUrl(request.url);

  const network = fetch(request);
  event.waitUntil(keep(cache, key, network));

  try {
    return await withinTime(network, DATA_TIMEOUT_MS);
  } catch {
    const cached = await cache.match(key, { ignoreVary: true });
    // Nothing to fall back on: the network is the only hope, however slow.
    return cached ?? network;
  }
}

/**
 * Keep a response as the copy to open with next time, under `key`.
 *
 * The clone is taken in the first handler attached to the fetch, before the
 * response reaches respondWith and its body starts being read - a body can only
 * be read once, and the copy has to be made from the untouched one. Resolves
 * when the write is done, so a caller can hold the worker up for it; a failure
 * is not one, since there was simply nothing to keep.
 */
function keep(cache, key, response) {
  return response
    .then((answer) => (keepable(answer) ? cache.put(key, answer.clone()) : undefined))
    .catch(() => undefined);
}

/** The URL without its query, the key the data files are kept under. */
function bareUrl(href) {
  const url = new URL(href);
  url.search = "";
  return url.href;
}

function withinTime(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No answer within ${ms} ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}
