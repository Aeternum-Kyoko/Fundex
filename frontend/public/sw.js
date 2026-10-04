/* Fundex service worker: the app shell works offline, live data never comes from a cache. */
const VERSION = "fundex-v5";
const SHELL = ["/", "/manifest.webmanifest", "/icons/icon-192.png", "/icons/favicon.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// The page tells us which built files it loaded, so the very first visit is already available offline.
self.addEventListener("message", (event) => {
  if (!event.data || event.data.type !== "precache") return;
  const urls = (event.data.urls || []).filter((url) => url.startsWith(self.location.origin + "/assets/"));
  event.waitUntil(caches.open(VERSION).then((cache) => Promise.all(urls.map((url) => cache.add(url).catch(() => undefined)))));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  // Market data, the change stream, trades and keys are always live.
  if (request.method !== "GET" || url.origin !== self.location.origin || url.pathname.startsWith("/api")) return;

  // Pages: network first so a deploy shows up straight away, cached shell when offline.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          event.waitUntil(caches.open(VERSION).then((cache) => cache.put("/", copy)));
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached || Response.error())),
    );
    return;
  }

  // Built assets have hashed names: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request, { ignoreVary: true }).then((cached) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) {
            // Clone now: once the page starts reading the body, a later clone() throws "body is already used".
            const copy = response.clone();
            event.waitUntil(caches.open(VERSION).then((cache) => cache.put(request, copy)));
          }
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
