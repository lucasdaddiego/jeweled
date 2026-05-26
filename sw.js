// Network-first service worker for Jeweled.
//
// Why network-first: cache-first means users keep seeing old code forever after
// a deploy until they clear site data. With network-first they always get the
// latest code when online, and the cache only kicks in as an offline fallback.
//
// Bump CACHE on every deploy so old caches are swept on activate.

const CACHE = 'gem-match-v32';

const PRECACHE = [
  '/',
  '/index.html',
  '/style.css',
  '/manifest.json',
  '/favicon.svg',
  '/src/main.js',
  '/src/build.js',
  '/src/config.js',
  '/src/grid.js',
  '/src/matcher.js',
  '/src/cascade.js',
  '/src/specials.js',
  '/src/animations.js',
  '/src/particles.js',
  '/src/floaters.js',
  '/src/painting.js',
  '/src/rng.js',
  '/src/render.js',
  '/src/input.js',
  '/src/dragInput.js',
  '/src/waves.js',
  '/src/bolts.js',
  '/src/debugHud.js',
  '/src/i18n.js',
  '/src/dialogs.js',
  '/src/wakeLock.js',
  '/src/powerups.js',
  '/src/achievements.js',
  '/src/toasts.js',
  '/src/storage.js',
  '/src/levels.js',
  '/src/puzzles.js',
  '/src/scenes/title.js',
  '/src/scenes/levelSelect.js',
  '/src/scenes/powerupOverlay.js',
  '/src/scenes/sceneCommon.js',
  '/src/scenes/gameZen.js',
  '/src/scenes/gameClassic.js',
  '/src/scenes/gameDaily.js',
  '/src/scenes/gameBlitz.js',
  '/src/scenes/gamePuzzle.js',
  '/src/scenes/puzzleSelect.js',
  '/src/scenes/stats.js',
  '/src/scenes/result.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-maskable.png',
  // Bundled Fluent emoji SVGs — the local glyphs rendered by the game, served
  // from this origin so first-load needs no CDN and offline play can use them.
  '/icons/emoji/red_square_color.svg',
  '/icons/emoji/blue_square_color.svg',
  '/icons/emoji/green_square_color.svg',
  '/icons/emoji/yellow_square_color.svg',
  '/icons/emoji/purple_square_color.svg',
  '/icons/emoji/white_large_square_color.svg',
  '/icons/emoji/black_large_square_color.svg',
  '/icons/emoji/collision_color.svg',
  '/icons/emoji/fire_color.svg',
  '/icons/emoji/high_voltage_color.svg',
  '/icons/emoji/star_color.svg',
  '/icons/emoji/joker_color.svg',
];

// Whitelist of URL prefixes we cache opportunistically on fetch. Anything
// outside the whitelist passes through without populating the cache — keeps
// quota predictable and avoids accidentally pinning stale third-party data.
const CACHEABLE_PREFIXES = ['/src/', '/icons/'];
const CACHEABLE_EXACT = new Set(['/', '/index.html', '/style.css', '/manifest.json', '/favicon.svg']);

function isCacheable(pathname) {
  if (CACHEABLE_EXACT.has(pathname)) return true;
  return CACHEABLE_PREFIXES.some(p => pathname.startsWith(p));
}

self.addEventListener('install', e => {
  // Pre-cache so first offline load works. cache: 'no-cache' bypasses HTTP cache.
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(PRECACHE.map(a =>
        fetch(a, { cache: 'no-cache' })
          .then(r => r.ok ? c.put(a, r) : null)
          .catch(() => null)
      )))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;

  // Never intercept the SW itself. If we did, a buggy SW could pin itself in
  // cache and prevent future updates from ever reaching the browser.
  if (url.pathname === '/sw.js') return;

  // Network-first: try the network, update cache on success (for whitelisted
  // URLs only), fall back to cache on failure.
  //
  // We treat a non-ok status (5xx from a Cloudflare edge hiccup, 4xx from a
  // misrouted request, etc.) the same as a network error — throw to enter the
  // catch branch so the cached copy is served. Without this, a transient 502
  // would be returned to the page even though we have a perfectly good
  // cached version, defeating the point of offline support.
  //
  // We also skip caching redirected responses: same-origin 30x followed by a
  // 200 would otherwise be cached as the redirect, replaying the redirect
  // offline indefinitely.
  e.respondWith(
    fetch(e.request)
      .then(resp => {
        if (!resp || !resp.ok) throw new Error('bad-response');
        if (!resp.redirected && resp.type !== 'opaqueredirect' && isCacheable(url.pathname)) {
          const copy = resp.clone();
          caches.open(CACHE)
            .then(c => c.put(e.request, copy))
            .catch(() => { /* quota or other; ignore — next load will retry */ });
        }
        return resp;
      })
      .catch(() => caches.match(e.request).then(r => r || Response.error()))
  );
});
