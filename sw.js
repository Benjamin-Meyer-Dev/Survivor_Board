/**
 * Service worker. Its only jobs are to make the board installable, which Chrome
 * will not offer without a fetch handler, and to keep it usable on a phone with
 * no signal.
 *
 * The strategy is network-first for every same-origin GET: online you always
 * get the live file, so the odds bot's commits and any deploy land immediately
 * and there is no cache to bust. The copy in the cache is only ever a fallback
 * for a failed request. Cross-origin requests (Supabase, Google Fonts) are left
 * alone and go straight to the network.
 *
 * There is no precache list to keep in step with the repo: whatever the app
 * fetches while online is what is available offline.
 */

const CACHE = "survivor-board-v1";

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
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});

/** Live response when the network answers, the last good copy when it does not. */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);

  try {
    const response = await fetch(request);
    // Opaque and error responses are not worth keeping as a fallback.
    if (response.ok && response.type === "basic") {
      cache.put(request, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;

    // An offline navigation with nothing cached for that exact URL still gets
    // the shell, which is the whole app.
    if (request.mode === "navigate") {
      const shell = await cache.match("./");
      if (shell) return shell;
    }
    throw err;
  }
}
