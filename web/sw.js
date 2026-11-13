// Kotonoha service worker: uygulama dosyalarını önbelleğe alır.
// Uygulama dosyaları: önce internetten (güncel sürüm gelsin), yoksa önbellekten.
// Furigana sözlüğü (CDN): önce önbellekten (12 MB bir kez indirilsin).
const APP = "kotonoha-app-v2";
const CDN = "kotonoha-cdn-v1";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil((async () => {
  for (const k of await caches.keys()) if (k.startsWith("kotonoha-app-") && k !== APP) await caches.delete(k);
  await self.clients.claim();
})()));

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
    // "no-cache": tarayıcı her seferinde sunucuya sorsun (değişmediyse küçük bir 304 cevabı gelir).
    // GitHub Pages dosyaları 10 dakika önbellekte tuttuğu için bu olmadan yeni sürüm geç geliyordu.
    e.respondWith(fetch(req, { cache: "no-cache" }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(APP).then(c => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req)));
  }
});
