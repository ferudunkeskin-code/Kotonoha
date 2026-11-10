// Kotonoha service worker: uygulama dosyalarını önbelleğe alır.
// Uygulama dosyaları: önce internetten (güncel sürüm gelsin), yoksa önbellekten.
// Furigana sözlüğü (CDN): önce önbellekten (12 MB bir kez indirilsin).
const APP = "kotonoha-app-v1";
const CDN = "kotonoha-cdn-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("fetch", e => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.hostname === "cdn.jsdelivr.net") {
    e.respondWith(caches.open(CDN).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) c.put(req, res.clone());
      return res;
    }));
  } else if (url.origin === self.location.origin) {
    e.respondWith(fetch(req).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(APP).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
});
