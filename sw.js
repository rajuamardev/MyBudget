/* MyBudget service worker: network-first, falls back to cache when offline. */
const CACHE = 'mybudget-shell-v3';
const SHELL = ['./', 'index.html', 'styles.css', 'logic.js', 'app.js', 'manifest.json',
  'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // Only the app files and web fonts are cached. Spreadsheet traffic (Apps Script) always goes straight to the network,
  // so data is never served from a stale local copy.
  const host = new URL(e.request.url).hostname;
  const own = host === self.location.hostname;
  if (!own && host !== 'fonts.googleapis.com' && host !== 'fonts.gstatic.com') return;
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res && (res.ok || res.type === 'opaque')) {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
      }
      return res;
    }).catch(() => caches.match(e.request).then((hit) => hit || (e.request.mode === 'navigate' ? caches.match('index.html') : Response.error())))
  );
});
