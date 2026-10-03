/* Fundex service worker: the app shell works offline, live data never comes from a cache. */
const VERSION = "fundex-v2";
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
          caches.open(VERSION).then((cache) => cache.put("/", copy));
          return response;
        })
        .catch(() => caches.match("/").then((cached) => cached || Response.error())),
    );
    return;
  }

  // Built assets have hashed names: serve from cache, refresh in the background.
  event.respondWith(
    caches.match(request).then((cached) => {
      const fresh = fetch(request)
        .then((response) => {
          if (response.ok) caches.open(VERSION).then((cache) => cache.put(request, response.clone()));
          return response;
        })
        .catch(() => cached);
      return cached || fresh;
    }),
  );
});
