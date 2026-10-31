/* Broadsheet service worker: makes the site installable and usable offline.
 *
 * - The app itself (HTML, CSS, JS, icons) is stored when installed, and served
 *   from storage straight away while a fresh copy downloads in the background.
 * - News data (data/*.json) is fetched from the network first so you always get
 *   the newest stories; the last copy is kept for offline use and instant start.
 * - Fonts are kept once downloaded.
 * - Article photos are NOT stored (they come from many other websites).
 *
 * VERSION is replaced by the GitHub workflow on every deploy, so a new version
 * of the app replaces the old one automatically.
 */

const VERSION = '__BUILD_ID__';
const SHELL_CACHE = `broadsheet-shell-${VERSION}`;
const DATA_CACHE = 'broadsheet-data';
const FONT_CACHE = 'broadsheet-fonts';
const NETWORK_TIMEOUT_MS = 6000;

const SHELL_FILES = [
  './',
  'index.html',
  'css/styles.css',
  'js/app.js',
  'js/config.js',
  'js/data.js',
  'js/store.js',
  'js/ui.js',
  'js/views.js',
  'manifest.webmanifest',
  'icons/favicon.svg',
  'icons/favicon-32.png',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

const scopeUrl = new URL('./', self.location).href;
const indexUrl = new URL('./', self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL_CACHE);
    // cache: 'reload' skips the browser's HTTP cache so we store the newest files.
    await cache.addAll(SHELL_FILES.map((path) => new Request(new URL(path, self.location).href, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names
        .filter((name) => name.startsWith('broadsheet-shell-') && name !== SHELL_CACHE)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

function withoutQuery(url) {
  const copy = new URL(url);
  copy.search = '';
  copy.hash = '';
  return copy.href;
}

async function staleWhileRevalidate(event, cacheName, key) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(key, { ignoreSearch: true });
  const network = fetch(event.request)
    .then(async (response) => {
      if (response && response.ok && response.type === 'basic') {
        await cache.put(key, response.clone());
      }
      return response;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  const response = await network;
  return response || new Response('Offline', { status: 503, statusText: 'Offline' });
}

async function networkFirst(event, key) {
  const cache = await caches.open(DATA_CACHE);
  const network = fetch(event.request).then(async (response) => {
    if (response.ok) await cache.put(key, response.clone());
    return response;
  });
  const cached = await cache.match(key);
  if (!cached) {
    try {
      return await network;
    } catch (err) {
      return new Response(JSON.stringify({ error: 'offline' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
  // If the network is slow, fall back to the stored copy (the download continues).
  event.waitUntil(network.catch(() => {}));
  const timeout = new Promise((resolve) => setTimeout(() => resolve(null), NETWORK_TIMEOUT_MS));
  const winner = await Promise.race([network.catch(() => null), timeout]);
  return winner && winner.ok ? winner : cached;
}

async function fontCache(event) {
  const cache = await caches.open(FONT_CACHE);
  const cached = await cache.match(event.request);
  if (cached) return cached;
  try {
    const response = await fetch(event.request);
    if (response.ok || response.type === 'opaque') await cache.put(event.request, response.clone());
    return response;
  } catch (err) {
    return new Response('', { status: 503 });
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);

  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    event.respondWith(fontCache(event));
    return;
  }
  if (url.origin !== self.location.origin || !url.href.startsWith(scopeUrl)) return;

  const path = url.href.slice(scopeUrl.length).split(/[?#]/)[0];

  if (path.startsWith('data/')) {
    if (path === 'data/version.json') return; // always straight from the network
    event.respondWith(networkFirst(event, withoutQuery(url.href)));
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, indexUrl));
    return;
  }

  event.respondWith(staleWhileRevalidate(event, SHELL_CACHE, withoutQuery(url.href)));
});
