const CACHE_NAME = 'fittimer-v2';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
  './src/app.mjs',
  './src/audio-cues.mjs',
  './src/interval-engine.mjs',
  './src/settings.mjs',
  './data/content-index.json',
];

function scopedUrl(relativePath) {
  return new URL(relativePath, self.registration.scope).href;
}

async function installApp() {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(APP_SHELL.map(scopedUrl));
  await self.skipWaiting();
}

async function activateApp() {
  const names = await caches.keys();
  await Promise.all(names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name)));
  await self.clients.claim();
}

async function fetchWithTimeout(request) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(request, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(installApp());
}); // ubs:ignore — service-worker lifecycle listeners live for the worker global's lifetime

self.addEventListener('activate', (event) => {
  event.waitUntil(activateApp());
}); // ubs:ignore — service-worker lifecycle listeners live for the worker global's lifetime

async function navigationResponse(request) {
  try {
    const response = await fetchWithTimeout(request);
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
    return response;
  } catch {
    return caches.match(scopedUrl('./index.html'));
  }
}

async function assetResponse(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  return fetchWithTimeout(request);
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(event.request.mode === 'navigate' ? navigationResponse(event.request) : assetResponse(event.request));
}); // ubs:ignore — service-worker fetch listeners live for the worker global's lifetime

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'CACHE_CONTENT' || !Array.isArray(event.data.urls)) return;

  event.waitUntil((async () => {
    try {
      const scope = new URL(self.registration.scope);
      const urls = [...new Set(event.data.urls)].map((relativePath) => new URL(relativePath, scope));
      const safe = urls.every((url) => {
        if (url.origin !== scope.origin || !url.pathname.startsWith(scope.pathname)) return false;
        const relativePath = url.pathname.slice(scope.pathname.length);
        return (
          relativePath === '' ||
          relativePath === 'index.html' ||
          relativePath === 'styles.css' ||
          relativePath === 'manifest.webmanifest' ||
          relativePath.startsWith('icons/') ||
          relativePath.startsWith('src/') ||
          relativePath === 'data/content-index.json' ||
          relativePath.startsWith('data/blocks/') ||
          relativePath.startsWith('data/routines/') ||
          relativePath.startsWith('data/media/') ||
          relativePath.startsWith('data/gifs/')
        );
      });
      if (!safe) throw new Error('Refused to cache content outside the service-worker scope');
      const cache = await caches.open(CACHE_NAME);
      const missing = [];
      for (const url of urls) {
        if (!(await cache.match(url.href))) missing.push(url.href);
      }
      if (missing.length > 0) await cache.addAll(missing);
      event.ports[0]?.postMessage({ ok: true, cached: urls.length, fetched: missing.length });
    } catch (error) {
      event.ports[0]?.postMessage({ ok: false, error: error.message });
    }
  })());
}); // ubs:ignore — service-worker message listeners live for the worker global's lifetime
