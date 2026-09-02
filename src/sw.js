const CACHE_PREFIX = 'riddle-diary-shell-';
const CACHE_NAME = CACHE_PREFIX + 'v9';
const AUDIO_CACHE = 'geomancer-audio-v1';
const APP_SHELL = [
  '/',
  '/geomancy.js',
  '/fonts/lxgw-wenkai.css',
  '/fonts/dancing-script.woff2',
  '/portal.js',
  '/portal.css',
  '/music.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-32.png',
  '/icons/icon-180.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) { return cache.addAll(APP_SHELL); })
      .then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys()
      .then(function(keys) {
        return Promise.all(keys.map(function(key) {
          if (key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME) {
            return caches.delete(key);
          }
          return Promise.resolve(false);
        }));
      })
      .then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstPage(request, url.search ? null : request));
    return;
  }

  event.respondWith(cacheFirstAsset(request, url.pathname.startsWith('/audio/') ? AUDIO_CACHE : CACHE_NAME));
});

async function networkFirstPage(request, cacheKey) {
  try {
    const response = await fetch(request);
    if (response.ok && cacheKey) {
      const cache = await caches.open(CACHE_NAME);
      await cache.put(cacheKey, response.clone());
    }
    return response;
  } catch {
    return (await caches.match(request)) ||
      (await caches.match('/')) ||
      new Response('答案之书目前处于离线状态。', {
        status: 503,
        headers: { 'Content-Type': 'text/plain; charset=utf-8' },
      });
  }
}

async function cacheFirstAsset(request, cacheName) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    const cache = await caches.open(cacheName);
    await cache.put(request, response.clone());
  }
  return response;
}
