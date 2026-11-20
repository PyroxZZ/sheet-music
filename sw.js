// Service worker: makes the app open with no internet.
// Bump VERSION whenever you change any app file so iPads pick up the update.
const VERSION = 'v13';
const APP_CACHE = `app-${VERSION}`;
const OCR_CACHE = 'ocr-v1'; // big OCR files, cached the first time OCR is used
const LIB_CACHE = 'lib-verovio-6.4.1'; // music engraving library for MusicXML (7 MB)
const LIB_FILES = ['./vendor/verovio/verovio.mjs', './vendor/verovio/verovio-module.mjs'];

const APP_FILES = [
  './',
  './index.html',
  './styles.css',
  './scan.css',
  './manifest.webmanifest',
  './js/icons.js',
  './js/scan.js',
  './js/vectorize.js',
  './js/prefs.js',
  './js/settings.js',
  './js/find.js',
  './js/score.js',
  './js/app.js',
  './js/db.js',
  './js/pdf.js',
  './js/detect.js',
  './js/viewer.js',
  './js/ui.js',
  './vendor/pdfjs/pdf.min.mjs',
  './vendor/pdfjs/pdf.worker.min.mjs',
  './icons/apple-touch-icon.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', event => {
  // cache: 'reload' skips the browser's HTTP cache so a new version really gets the new files.
  event.waitUntil(caches.open(APP_CACHE)
    .then(c => c.addAll(APP_FILES.map(u => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
  // Also fetch the MusicXML engraver in the background so scores work offline (not fatal if it fails).
  caches.open(LIB_CACHE).then(async c => { for (const u of LIB_FILES) if (!(await c.match(u))) await c.add(u).catch(() => {}); });
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key !== APP_CACHE && key !== OCR_CACHE && key !== LIB_CACHE) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;

  const big = url.pathname.includes('/vendor/tesseract/') ? OCR_CACHE : url.pathname.includes('/vendor/verovio/') ? LIB_CACHE : null;
  if (big) {
    // Large libraries: cache-first, filled on first use.
    event.respondWith((async () => {
      const cache = await caches.open(big);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // App files: serve from cache instantly; refresh in the background when online.
  event.respondWith((async () => {
    const cache = await caches.open(APP_CACHE);
    const hit = await cache.match(req, { ignoreSearch: true });
    const network = fetch(req).then(res => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    }).catch(() => null);
    if (hit) { event.waitUntil(network); return hit; }
    const res = await network;
    if (res) return res;
    if (req.mode === 'navigate') return cache.match('./index.html');
    return new Response('Offline', { status: 503 });
  })());
});
