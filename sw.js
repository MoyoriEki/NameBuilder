/* オフラインでも開けるようにする最小のService Worker。
   方針: ネットワーク優先 → 失敗したらキャッシュ。更新が即反映され、
   オフライン時だけ前回の版で起動する(古い版に固定される事故を避ける) */
const CACHE = 'namebuilder-v3';
const SHELL = [
  './', 'index.html', 'probe.html', 'css/app.css',
  'js/app.js', 'js/db.js', 'js/ink.js', 'js/zip.js',
  'vendor/perfect-freehand.mjs', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('namebuilder-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});
