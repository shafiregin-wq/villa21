// Villa 21 service worker: keeps the app itself available offline.
// Expense data is synced by Firebase, which has its own offline storage; its network calls are never cached here.
const VERSION = "villa21-v1";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
const LIVE = /(firestore|identitytoolkit|securetoken|firebaseinstallations|firebaselogging)\.googleapis\.com$/;

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(VERSION);
    await cache.addAll(SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", event => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (LIVE.test(url.hostname)) return;

  // The app page and its settings: newest from the network, saved copy when offline.
  const fresh = req.mode === "navigate" || (url.origin === self.location.origin && /config\.js$/.test(url.pathname));
  if (fresh) {
    const key = req.mode === "navigate" ? "./index.html" : req;
    event.respondWith(
      fetch(req).then(res => { if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(key, copy)); } return res; })
        .catch(() => caches.match(key))
    );
    return;
  }

  // Icons and the Firebase library: saved copy first.
  if (url.origin === self.location.origin || url.hostname === "www.gstatic.com") {
    event.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
        return res;
      }))
    );
  }
});
