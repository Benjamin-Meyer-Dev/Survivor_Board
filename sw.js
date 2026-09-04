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
 * The data files under data/ are different. The odds bot rewrites them daily
 * and the board must not show yesterday's lines when today's are a fetch away,
 * so they go network-first with a time limit, then fall back to the last copy.
 * The app cache-busts them with a query string, so they are stored under the
 * bare URL; stored as requested, the fallback could never find them and the
 * cache grew by five files a launch.
 *
 * There is still no precache list: whatever the app fetches while online is
 * what is available offline.
 */

const CACHE = "survivor-board-v2";

/** How long to wait for fresh data before opening with the last copy. */
const DATA_TIMEOUT_MS = 2500;

/** Cross-origin hosts whose files are part of the shell. Supabase itself is not. */
const SHELL_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "cdn.jsdelivr.net"];

const isData = (url) => /\/data\/.+\.json$/.test(url.pathname);

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
    event.respondWith(isData(url) ? freshFirst(request) : cachedFirst(request));
  } else if (SHELL_HOSTS.includes(url.hostname)) {
    event.respondWith(cachedFirst(request));
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
 */
async function cachedFirst(request) {
  const cache = await caches.open(CACHE);
  // ignoreVary: Google's font stylesheet varies on Sec-Fetch headers, which no
  // stored request carries, and a copy that cannot be matched is no copy.
  const cached = await cache.match(request.url, { ignoreVary: true });

  const refresh = fetch(request).then((response) => {
    if (keepable(response)) cache.put(request.url, response.clone());
    return response;
  });

  if (cached) {
    refresh.catch(() => {});
    return cached;
  }
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
 * or cannot. A late answer is still kept, so the next launch opens with it.
 */
async function freshFirst(request) {
  const cache = await caches.open(CACHE);
  const key = bareUrl(request.url);

  const network = fetch(request).then((response) => {
    if (response.ok) cache.put(key, response.clone());
    return response;
  });
  network.catch(() => {});

  try {
    return await withinTime(network, DATA_TIMEOUT_MS);
  } catch {
    const cached = await cache.match(key, { ignoreVary: true });
    // Nothing to fall back on: the network is the only hope, however slow.
    return cached ?? network;
  }
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
