/* Minimal service worker: caches the app shell so the PWA installs and opens
 * offline. API responses and iNat photos are intentionally NOT precached — they
 * go through the network and use a runtime cache-first-then-network fallback so
 * a previously loaded feed can still render offline. Bump CACHE_VERSION to ship
 * updated app-shell files. */
const CACHE_VERSION = "iff-v1";
const SHELL = [
  "./",
  "./index.html",
  "./styles.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // App shell (same-origin): cache-first.
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
    return;
  }

  // iNat photos: cache-first with background fill (they're immutable by URL).
  if (url.hostname.endsWith("inaturalist.org") && /\.(jpe?g|png)$/i.test(url.pathname)) {
    event.respondWith(
      caches.open("iff-photos").then((cache) =>
        cache.match(req).then((hit) => {
          const network = fetch(req).then((res) => {
            if (res.ok) cache.put(req, res.clone());
            return res;
          }).catch(() => hit);
          return hit || network;
        })
      )
    );
    return;
  }

  // API + everything else: network-first, fall back to any cached copy.
  event.respondWith(fetch(req).catch(() => caches.match(req)));
});
