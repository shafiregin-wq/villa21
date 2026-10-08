// Villa 21 service worker: keeps the app itself available offline, and shows push notifications
// (sent by the Supabase Edge Function "villa-notify") when someone else adds an expense or payment.
// Expense data is synced by Firebase, which has its own offline storage; its network calls are never cached here.
const VERSION = "villa21-v3";
const SHELL = ["./", "./index.html", "./config.js", "./manifest.webmanifest", "./logo.png", "./icon-180.png", "./icon-192.png", "./icon-512.png"];
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

// A notification from another person's phone (see supabase/functions/villa-notify).
self.addEventListener("push", event => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; } catch (e) { msg = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(msg.title || "Villa 21", {
    body: msg.body || "",
    tag: msg.tag || undefined,
    icon: "icon-192.png",
    badge: "icon-192.png",
    data: { url: self.registration.scope }
  }));
});

// Tapping it opens Villa 21, or brings it to the front if it's already open.
self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const open = windows.find(w => w.url.startsWith(self.registration.scope));
    if (open) { await open.focus(); return; }
    await self.clients.openWindow(self.registration.scope);
  })());
});
