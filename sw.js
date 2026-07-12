// PSBase Service Worker v2 — раздельный кэш для app и изображений
'use strict';

const APP_CACHE = 'psbase-app-v6';
const IMG_CACHE = 'psbase-img-v1';

// Файлы приложения — кэшируем при установке
const APP_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './db.js',
  './config.js',
  './sync/supabase-client.js',
  './sync/imagekit.js',
  './sync/strategy.js',
  './manifest.json',
  'https://unpkg.com/dexie@3.2.4/dist/dexie.js',
  'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/cropperjs/1.6.1/cropper.min.js',
  'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js',
];

// Хосты для которых используем cache-first (CDN изображения)
const IMG_HOSTS = ['ik.imagekit.io'];

// ── Install ───────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_ASSETS))
      .then(() => self.skipWaiting())
  );
});

// ── Activate: чистим старые кэши ─────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== APP_CACHE && k !== IMG_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch ─────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // ImageKit CDN — cache-first, долгий TTL
  if (IMG_HOSTS.some(h => url.hostname.includes(h))) {
    e.respondWith(cacheFirstImg(e.request));
    return;
  }

  // Supabase API — только сеть, не кэшируем
  if (url.hostname.includes('supabase.co')) {
    e.respondWith(fetch(e.request).catch(() => new Response('', {status:503})));
    return;
  }

  // ImageKit Upload API — только сеть
  if (url.hostname.includes('upload.imagekit.io')) {
    e.respondWith(fetch(e.request));
    return;
  }

  // App assets — stale-while-revalidate
  e.respondWith(staleWhileRevalidate(e.request));
});

// ── Стратегии ─────────────────────────────────────────────────────

// Cache-first для изображений: отдаём из кэша мгновенно, обновляем фоново
async function cacheFirstImg(request) {
  const cache  = await caches.open(IMG_CACHE);
  const cached = await cache.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) cache.put(request, response.clone());
    return response;
  } catch {
    return new Response('', { status: 503, statusText: 'Offline' });
  }
}

// Stale-while-revalidate для app: отдаём кэш + обновляем в фоне
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(APP_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request).then(response => {
    if (response && response.status === 200 && response.type !== 'opaque') {
      cache.put(request, response.clone());
    }
    return response;
  }).catch(() => null);

  // Если есть кэш — отдаём сразу, обновляем фоново
  if (cached) return cached;

  // Нет кэша — ждём сеть
  const networkResponse = await fetchPromise;
  if (networkResponse) return networkResponse;

  // Офлайн + нет кэша — fallback на index.html для навигации
  if (request.destination === 'document') {
    const fallback = await cache.match('./index.html');
    if (fallback) return fallback;
  }

  return new Response('Offline', { status: 503 });
}

// ── Background Sync (опционально, браузер поддерживает не везде) ──
self.addEventListener('sync', e => {
  if (e.tag === 'psbase-sync') {
    // SyncManager.flush() будет вызван из клиента при восстановлении сети
    // SW только сигнализирует — логика синхронизации в app
    e.waitUntil(Promise.resolve());
  }
});
