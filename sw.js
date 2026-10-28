// Keeps the app working offline: the page is fetched fresh when online and
// served from cache when not; fonts and cover images are cached as they load.
// Paths are relative so the app works both at a site's root and in a sub-folder (GitHub Pages).
const CACHE = "hum-v43";
const HOME = new URL("./", self.location).href;
const FONTS = ["BricolageGrotesque-latin-1", "BricolageGrotesque-latin-ext-0", "Figtree-latin-3", "Figtree-latin-ext-2", "JetBrainsMono-latin-5", "JetBrainsMono-latin-ext-4"].map(n => "fonts/" + n + ".woff2");
const SHELL = ["./", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "i18n/en.json", "vendor/qrcode.js", ...FONTS].map(p => new URL(p, self.location).href);
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

  // opening the app: the newest version if the internet answers in 3.5 s; if not, the copy saved on this
  // phone opens right away (a slow or flaky connection never leaves it loading) and the new one is saved for next time
  if (req.mode === "navigate"){
    const net = fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(HOME, copy)); }
      return res;
    });
    e.waitUntil(net.catch(() => {}));
    e.respondWith(new Promise(resolve => {
      let done = false; const give = r => { if (!done && r){ done = true; resolve(r); } };
      const t = setTimeout(() => caches.match(HOME).then(give), 3500);
      net.then(res => { clearTimeout(t); if (res.ok || done) give(res); else caches.match(HOME).then(hit => give(hit || res)); })
        .catch(() => { clearTimeout(t); caches.match(HOME).then(hit => give(hit || Response.error())); });
    }));
    return;
  }

  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === "opaque"){ const copy = res.clone(); caches.open(CACHE).then(c => c.put(req, copy)); }
      return res;
    }))
  );
});
