const CACHE_NAME = 'homlok-v2';
const CORE = ['./', './index.html', './styles.css?v=2', './app.js?v=2', './data.js?v=2', './game-core.js', './favicon.svg', './manifest.webmanifest?v=2'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE.map((path) => new Request(path, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith('homlok-') && key !== CACHE_NAME).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Network first keeps a GitHub Pages update visible; the cache handles offline use.
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      return await cache.match(event.request)
        || (event.request.mode === 'navigate' ? await cache.match('./index.html') : undefined)
        || Response.error();
    }
  })());
});
