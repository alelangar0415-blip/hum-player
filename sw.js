// Keeps the app working offline: the page is fetched fresh when online and
// served from cache when not; fonts and cover images are cached as they load.
// Paths are relative so the app works both at a site's root and in a sub-folder (GitHub Pages).
const CACHE = "hum-v24";
const HOME = new URL("./", self.location).href;
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"].map(p => new URL(p, self.location).href);
const CACHED_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com", "i.scdn.co", "mosaic.scdn.co", "image-cdn-ak.spotifycdn.com", "image-cdn-fa.spotifycdn.com"];

self.addEventListener("install", e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // accounts, Google sign-in and downloads always go straight to the network
  if (url.origin === location.origin && (url.pathname.includes("/api/") || url.pathname.includes("/descargas/"))) return;
  if (url.origin !== location.origin && !CACHED_HOSTS.includes(url.hostname)) return;

  if (req.mode === "navigate"){
    e.respondWith(
      fetch(req)
        .then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(HOME, copy)); return res; })
        .catch(() => caches.match(HOME))
    );
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque"){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
