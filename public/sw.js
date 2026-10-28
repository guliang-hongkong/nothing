'use strict';

const CACHE_NAME = 'islands-forum-v8';
const CORE_ASSETS = [
  '/',
  '/styles.css',
  '/app.js',
  '/theme-init.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/favicon.ico',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(CORE_ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  const isNavigation = request.mode === 'navigate';

  // Network-first keeps the app shell and styles current; the cache is the
  // offline safety net rather than the primary source.
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(isNavigation ? '/' : request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(isNavigation ? '/' : request);
        if (cached) return cached;
        if (isNavigation) {
          return new Response('离岛暂时离线了。请恢复网络后重试。', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }
        return Response.error();
      }),
  );
});
