// Offline support. Everything is network-first with a cache fallback, so a
// hand-edited site goes live immediately when online and still reads fully
// offline afterwards. Audio and images are cache-first: they're big, they
// don't change, and re-downloading them costs the most.
const VERSION = 'v1';
const SHELL_CACHE = `anamnesis-shell-${VERSION}`;
const CONTENT_CACHE = `anamnesis-content-${VERSION}`;
const MEDIA_CACHE = `anamnesis-media-${VERSION}`;

const SHELL = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/main.js',
  './js/state.js',
  './js/parser.js',
  './js/audio.js',
  './js/codex.js',
  './js/reader.js',
  './icons/icon-192.png',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  const keep = [SHELL_CACHE, CONTENT_CACHE, MEDIA_CACHE];
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => !keep.includes(k)).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;

  if (/\.(mp3|wav|ogg|m4a|flac|jpg|jpeg|png|webp|gif|svg)$/i.test(url.pathname)) {
    e.respondWith(cacheFirst(e.request, MEDIA_CACHE));
  } else if (url.pathname.includes('/content/')) {
    e.respondWith(networkFirst(e.request, CONTENT_CACHE));
  } else {
    e.respondWith(networkFirst(e.request, SHELL_CACHE));
  }
});

async function cacheFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req);
    if (hit) return hit;
    // Offline navigation to a page we never cached: serve the app shell,
    // whose hash router will take it from there.
    if (req.mode === 'navigate') {
      const shell = await caches.open(SHELL_CACHE).then(c => c.match('./index.html'));
      if (shell) return shell;
    }
    throw err;
  }
}
