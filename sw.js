const CACHE = 'shopping-list-v3';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'storage.js', 'cloud.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// ネットワーク優先、失敗時はキャッシュ(更新を反映しつつオフラインでも動く)
// 自分のファイルと Firebase の部品(CDN)だけを扱う。Firestore・ログインの通信には触れない。
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  const own = url.origin === self.location.origin;
  const sdk = url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/');
  if (!own && !sdk) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || (own ? caches.match('index.html') : Response.error())))
  );
});
