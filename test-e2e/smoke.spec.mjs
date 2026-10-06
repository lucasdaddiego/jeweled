// E2E smoke test — real Chromium against the real app, zero config.
//
//   node test-e2e/smoke.spec.mjs
//
// Self-contained on purpose: npm's test:e2e script first builds dist/, then
// this starts its own static server, launches Chromium via the plain `playwright`
// library (NOT the @playwright/test runner), drives the app through the
// localhost-only `window.__game` debug hook, and exits non-zero on any failure.
// It lives outside test/ and uses .mjs so the Vitest suite (include:
// test/**/*.test.js) never picks it up.
//
// It serves whatever is in dist/: the ES-module source tree (test.yml) or the
// bundled, minified production tree (deploy.yml runs it after the bundle step,
// before `wrangler pages deploy`). Nothing here imports /src/*.js, which the
// bundle removes; geometry and dates come from window.__game.
//
// What it asserts:
//   1. The page boots: #boot-splash is removed once the first frame is drawn.
//   2. canvas#game exists with a nonzero backing store and layout size.
//   3. The title scene actually painted pixels (not a blank/black canvas).
//   4. Scene switch via __game.setScene('gameZen') settles to cascade IDLE
//      (entry animation completes) and back to title cleans up window.__zen.
//   5. The save file lands in localStorage under 'gem-match:v1'.
//   6. The generated service-worker manifest supports a complete offline reload,
//      and with the worker in control an unknown path still shows the 404 page.
//   7. On an emulated phone (hasTouch), the release-activated buttons run from
//      a real touchscreen tap: View source opens a popup to the repo, Share
//      calls navigator.share with the card image, and without a share sheet
//      the same tap reaches navigator.clipboard.writeText.
//   8. One active tab: a second tab blocks and cannot write over the first
//      tab's save, takes over when the first tab closes, and "Play here" moves
//      the save to the tab that asks.
//   9. Zero console errors and zero uncaught page errors across all of it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');

// ---------------------------------------------------------------------------
// Tiny hermetic static server (built dist/, correct MIME types, no caching).
// ---------------------------------------------------------------------------

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function startServer() {
  return new Promise((resolveServer, rejectServer) => {
    const server = createServer(async (req, res) => {
      try {
        let pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
        if (pathname.endsWith('/')) pathname += 'index.html';
        const filePath = normalize(join(ROOT, pathname));
        if (!filePath.startsWith(ROOT + sep)) {
          res.writeHead(403, { 'content-type': 'text/plain' });
          res.end('forbidden');
          return;
        }
        const body = await readFile(filePath);
        res.writeHead(200, {
          'content-type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
          'cache-control': 'no-store',
        });
        res.end(body);
      } catch {
        // Like Cloudflare Pages: an unknown path answers dist/404.html, 404.
        const body = await readFile(join(ROOT, '404.html')).catch(() => 'not found');
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(body);
      }
    });
    server.on('error', rejectServer);
    server.listen(0, '127.0.0.1', () => resolveServer(server));
  });
}

// ---------------------------------------------------------------------------
// Assertion + logging helpers.
// ---------------------------------------------------------------------------

let stepNo = 0;
function step(msg) {
  stepNo += 1;
  console.log(`[smoke] ${stepNo}. ${msg}`);
}

function assert(cond, msg) {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// ---------------------------------------------------------------------------
// Touch phase: release-activated buttons on an emulated phone.
// ---------------------------------------------------------------------------
// On touch, pointerdown is not a user-activation event (pointerup is), so the
// buttons that hit activation-gated APIs — Share (navigator.share / clipboard)
// and View source (window.open) — fire on the release of a tap (see
// input.createPressTracker). Emulate a phone (hasTouch) and prove each action
// runs from a real touchscreen tap. The platform APIs are stubbed via
// addInitScript, so this proves the wiring under touch ("the stub was called
// from a tap"), not the browser's activation policy itself — Playwright
// launches Chromium with popup blocking off. A minute on a real phone is still
// worth it after touching this path.

const REPO_URL = 'https://github.com/lucasdaddiego/jeweled';

async function runTouchPhase(browser, base, consoleErrors, pageErrors) {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    locale: 'en-US',
    // The routes below must see the page's own fetches (a service worker
    // would answer them first); the SW is exercised by the desktop phase.
    serviceWorkers: 'block',
  });
  // Keep the network out of it: the popup's github.com navigation gets a stub
  // page, and the optional leaderboard answers 200 with a body the client maps
  // to {ok:false} — no block drawn, no console error from a 404.
  await context.route('https://github.com/**', (route) => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>stub</title>',
  }));
  await context.route('**/api/leaderboard/**', (route) => route.fulfill({
    contentType: 'application/json', body: '{}',
  }));
  await context.addInitScript(() => {
    // A saved player name skips the DOM name-entry modal, which blocks canvas taps.
    localStorage.setItem('gem-match:v1', JSON.stringify({ profile: { playerName: 'E2E' } }));
    window.__e2e = { share: [], clipboard: [] };
    navigator.canShare = () => true;
    navigator.share = async (data) => { window.__e2e.share.push(Object.keys(data).sort()); };
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__e2e.clipboard.push(text); } },
    });
  });
  const page = await context.newPage();
  page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));

  await page.goto(`${base}/`, { waitUntil: 'load', timeout: 15_000 });
  await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 15_000 });
  await page.waitForFunction(() => window.__game && window.__game.clockMs() > 600, null, { timeout: 10_000 });
  const vp = page.viewportSize();
  step(`touch context booted (Pixel 7 descriptor, ${vp.width}x${vp.height}, hasTouch)`);

  // Two painted frames so the scene's hit rects reflect the current screen.
  const settle = () => page.evaluate(() =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

  // --- Title → View source (window.open → popup) ------------------------------
  // title.js draws the link label at x=10 with its baseline at h - 6 - sab and
  // a 13px-tall hit rect above it; tap a few px in from its left edge.
  const link = await page.evaluate(() => {
    const sab = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
    return { x: 16, y: window.__game.viewport().h - 6 - sab - 6 };
  });
  const popupPromise = page.waitForEvent('popup', { timeout: 10_000 });
  await page.touchscreen.tap(link.x, link.y);
  const popup = await popupPromise;
  await popup.waitForLoadState('load').catch(() => {});
  assert(popup.url().startsWith(REPO_URL), `View source popup opened ${REPO_URL} (got ${popup.url()})`);
  await popup.close().catch(() => {});
  step('tap on View source → window.open popup to the repo');

  // --- Daily result → Share (navigator.share, then the clipboard rung) -------
  const today = await page.evaluate(() => window.__game.todayISO());
  await page.evaluate((date) => window.__game.setScene('result', {
    mode: 'daily', date, score: 4321, isNewBest: true, movesUsed: 9, streak: 1,
  }), today);
  await settle();
  // Share is the first action; its rect comes from the same pure layout helper
  // result.draw() uses (daily + new best = 2 subtitle lines, 3 actions, no board).
  const share = await page.evaluate(() => {
    const { w, h } = window.__game.viewport();
    const box = window.__game.resultLayout({
      w, h, safeTop: window.__game.layout.safeTop, subtitleLines: 2, actionCount: 3,
      leaderboardRows: 0, hasRank: false,
    });
    return { x: w / 2, y: box.buttonsY + box.buttonH / 2 };
  });
  await page.touchscreen.tap(share.x, share.y);
  await page.waitForFunction(() => window.__e2e.share.length === 1, null, { timeout: 5_000 });
  const shared = await page.evaluate(() => window.__e2e.share[0]);
  assert(shared.includes('files') && shared.includes('text'),
    `navigator.share got the card image + text (keys: ${shared.join(',')})`);
  assert((await page.evaluate(() => window.__e2e.clipboard.length)) === 0,
    'clipboard untouched when the share sheet succeeded');
  step('tap on Share → navigator.share called with the card image');

  // Without a share sheet the same tap lands on the clipboard rung.
  await page.evaluate(() => { navigator.share = undefined; navigator.canShare = undefined; });
  await page.touchscreen.tap(share.x, share.y);
  await page.waitForFunction(() => window.__e2e.clipboard.length === 1, null, { timeout: 5_000 });
  const copied = await page.evaluate(() => window.__e2e.clipboard[0]);
  assert(/4[,.]?321/.test(copied), `clipboard text carries the score (got ${JSON.stringify(copied)})`);
  step('tap on Share without navigator.share → clipboard.writeText called');

  await context.close();
}

// ---------------------------------------------------------------------------
// One active tab: two pages of one context share localStorage and Web Locks.
// ---------------------------------------------------------------------------

async function runTabLockPhase(browser, base, consoleErrors, pageErrors) {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 }, serviceWorkers: 'block' });
  await context.addInitScript(() => {
    if (!localStorage.getItem('gem-match:v1')) {
      localStorage.setItem('gem-match:v1', JSON.stringify({ profile: { playerName: 'E2E' } }));
    }
  });
  const open = async () => {
    const page = await context.newPage();
    page.on('console', (msg) => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
    page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 15_000 });
    await page.waitForFunction(() => window.__game, null, { timeout: 10_000 });
    return page;
  };
  const tabState = (page, want, timeout = 5_000) => page.waitForFunction(
    (w) => window.__game.tabState() === w, want, { timeout, polling: 100 });
  const best = () => first.evaluate(() => JSON.parse(localStorage.getItem('gem-match:v1')).zen.bestScore);

  const first = await open();
  await tabState(first, 'owner');
  const second = await open();
  await tabState(second, 'blocked');
  step('second tab blocks while the first tab owns the save');

  await first.evaluate(() => { window.__game.storage.saveKey('zen', { bestScore: 4242 }); window.__game.storage.flush(); });
  await second.evaluate(() => { window.__game.storage.saveKey('zen', { bestScore: 1 }); window.__game.storage.flush(); });
  assert((await best()) === 4242, `blocked tab did not overwrite the save (bestScore ${await best()})`);
  step('blocked tab writes nothing over the owner\'s progress');

  await first.close({ runBeforeUnload: true });
  await tabState(second, 'owner', 10_000);
  const adopted = await second.evaluate(() => window.__game.storage.load().zen.bestScore);
  assert(adopted === 4242, `takeover adopted the closed tab's save (got ${adopted})`);
  step('first tab closed → second tab took over with its latest save');

  const third = await open();
  await tabState(third, 'blocked');
  await third.keyboard.press('Enter');          // "Play here" is the dialog's OK
  await tabState(third, 'owner');
  await tabState(second, 'blocked');
  step('"Play here" moved the save to the asking tab; the old owner blocked');

  await context.close();
}

// ---------------------------------------------------------------------------
// The test.
// ---------------------------------------------------------------------------

async function main() {
  const t0 = Date.now();
  const consoleErrors = [];
  const pageErrors = [];

  // Hard watchdog: unref'd so it never keeps the process alive, but if
  // anything wedges (browser, server socket), we still die loudly.
  const watchdog = setTimeout(() => {
    console.error('[smoke] FAIL: watchdog fired — test exceeded 60s');
    process.exit(1);
  }, 60_000);
  watchdog.unref();

  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  step(`static server serving ${ROOT} at ${base}`);

  let browser;
  let failed = false;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => pageErrors.push(String((err && err.stack) || err)));
    step('chromium launched');

    // --- Boot ---------------------------------------------------------------
    await page.goto(`${base}/`, { waitUntil: 'load', timeout: 15_000 });
    step('page loaded');

    // main.js removes #boot-splash ~200ms after the first successfully drawn
    // frame — its removal is the "the RAF loop is alive and painting" signal.
    await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 15_000 });
    step('boot splash removed (first frame drawn)');

    const size = await page.$eval('canvas#game', (el) => ({
      w: el.width, h: el.height, cw: el.clientWidth, ch: el.clientHeight,
    }));
    assert(size.w > 0 && size.h > 0, `canvas backing store has nonzero size (got ${size.w}x${size.h})`);
    assert(size.cw > 0 && size.ch > 0, `canvas has nonzero layout size (got ${size.cw}x${size.ch})`);
    step(`canvas#game present, ${size.w}x${size.h} (css ${size.cw}x${size.ch})`);

    // Let the game clock advance past the 220ms scene crossfade so we sample
    // the fully faded-in title scene, not the black overlay. __game is the
    // localhost-only debug hook exposed by src/main.js.
    await page.waitForFunction(
      () => window.__game && window.__game.clockMs() > 600,
      null, { timeout: 10_000 },
    );
    step('debug hook window.__game present, game clock running');

    // --- Title scene painted? ------------------------------------------------
    // Copy the game canvas onto a fresh canvas and read pixels from the copy
    // (same-origin, never tainted). Sample every ~37th pixel: a painted title
    // scene has many distinct colors and plenty of non-black pixels; a blank
    // canvas has one color and a tiny toDataURL.
    const paint = await page.evaluate(() => {
      const src = document.getElementById('game');
      const copy = document.createElement('canvas');
      copy.width = src.width;
      copy.height = src.height;
      const ctx = copy.getContext('2d');
      ctx.drawImage(src, 0, 0);
      const { data } = ctx.getImageData(0, 0, copy.width, copy.height);
      const colors = new Set();
      let lit = 0;
      let sampled = 0;
      for (let i = 0; i < data.length; i += 4 * 37) {
        sampled += 1;
        const r = data[i], g = data[i + 1], b = data[i + 2], a = data[i + 3];
        colors.add((r << 16) | (g << 8) | b);
        if (a > 0 && r + g + b > 24) lit += 1; // visible and not near-black
      }
      return { colors: colors.size, lit, sampled, dataUrlLen: src.toDataURL().length };
    });
    assert(paint.dataUrlLen > 20_000,
      `canvas toDataURL length ${paint.dataUrlLen} > 20000 (a blank canvas encodes to ~1-3k)`);
    assert(paint.colors >= 8, `title scene painted >= 8 distinct colors (got ${paint.colors})`);
    assert(paint.lit / paint.sampled > 0.05,
      `>5% of sampled pixels visibly painted (got ${paint.lit}/${paint.sampled})`);
    step(`title scene painted (${paint.colors} colors, ${paint.lit}/${paint.sampled} lit px, dataURL ${paint.dataUrlLen}b)`);

    // --- Zen scene round-trip -------------------------------------------------
    // gameZen exposes window.__zen = { grid, cascade } on debug hosts. Entering
    // it plays a board-entry animation (cascade state FALLING, ~1-2.5s), then
    // settles to IDLE — poll for that instead of sleeping a fixed amount.
    await page.evaluate(() => window.__game.setScene('gameZen'));
    const zenT0 = Date.now();
    await page.waitForFunction(
      () => window.__zen && window.__zen.cascade && window.__zen.cascade.state === 'IDLE',
      null, { timeout: 10_000, polling: 100 },
    );
    step(`gameZen entered, entry animation settled to IDLE in ${Date.now() - zenT0}ms`);

    await page.evaluate(() => window.__game.setScene('title'));
    const zenGone = await page.evaluate(() => window.__zen === undefined);
    assert(zenGone, 'window.__zen cleaned up after leaving gameZen');
    step('returned to title, __zen cleaned up');

    // --- Persistence ------------------------------------------------------------
    // Saves are debounced (~250ms); flush() forces the pending write so the
    // check is deterministic rather than sleep-based.
    const stored = await page.evaluate(() => {
      window.__game.storage.flush();
      return localStorage.getItem('gem-match:v1');
    });
    assert(stored != null, "localStorage key 'gem-match:v1' exists");
    assert(typeof JSON.parse(stored) === 'object', "'gem-match:v1' contains parseable JSON");
    step(`localStorage 'gem-match:v1' persisted (${stored.length} bytes)`);

    // --- Offline reload --------------------------------------------------------
    // build.sh generated the full precache manifest from dist/. Wait until the
    // claiming worker controls this page, disable the network, and prove the
    // whole module graph boots from CacheStorage rather than merely checking
    // that installation reported success.
    await page.waitForFunction(
      () => navigator.serviceWorker && navigator.serviceWorker.controller,
      null, { timeout: 15_000 },
    );
    await context.setOffline(true);
    await page.reload({ waitUntil: 'load', timeout: 15_000 });
    await page.waitForSelector('#boot-splash', { state: 'detached', timeout: 15_000 });
    const offlineReady = await page.evaluate(() =>
      !!window.__game && document.getElementById('game')?.width > 0);
    assert(offlineReady, 'app boots with a painted canvas while network is offline');
    assert((await page.evaluate(() => JSON.parse(localStorage.getItem('gem-match:v1')).zen.saveState)) != null,
      'parked Zen save remains available after a fresh offline reload');
    await context.setOffline(false);
    step('service-worker precache completed a full offline reload with save-state intact');

    // --- 404 through the service worker ----------------------------------------
    // The worker answers navigations network-first. A 404 is the server's real
    // answer, not an outage: it must reach the page, not the cached app shell.
    // A separate page keeps the expected 404 out of the console-error tally.
    const notFound = await context.newPage();
    const resp = await notFound.goto(`${base}/nope-xyz`, { waitUntil: 'load', timeout: 15_000 });
    const nfTitle = await notFound.title();
    assert(resp && resp.fromServiceWorker(), 'the 404 navigation went through the service worker');
    assert(resp.status() === 404, `unknown path answers 404 through the worker (got ${resp && resp.status()})`);
    assert(nfTitle.startsWith('404'), `unknown path shows the 404 page, not the app (title ${JSON.stringify(nfTitle)})`);
    await notFound.close();
    step('with the worker in control, an unknown path shows the 404 page (404)');

    // --- Touch: release-activated buttons ------------------------------------
    // Runs before the error tally below so its console/page errors count too.
    await runTouchPhase(browser, base, consoleErrors, pageErrors);

    // --- One active tab --------------------------------------------------------
    await runTabLockPhase(browser, base, consoleErrors, pageErrors);

    // --- No errors, ever ---------------------------------------------------------
    assert(consoleErrors.length === 0, `no console errors (got ${consoleErrors.length})`);
    assert(pageErrors.length === 0, `no uncaught page errors (got ${pageErrors.length})`);
    step('zero console errors, zero page errors');

    await context.close();
  } catch (err) {
    failed = true;
    console.error(`\n[smoke] FAIL: ${err && err.message ? err.message : err}`);
    if (consoleErrors.length) {
      console.error('\n[smoke] console errors collected:');
      for (const e of consoleErrors) console.error(`  - ${e}`);
    }
    if (pageErrors.length) {
      console.error('\n[smoke] page errors collected:');
      for (const e of pageErrors) console.error(`  - ${e}`);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }

  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(failed ? `\n[smoke] FAILED in ${secs}s` : `\n[smoke] PASS in ${secs}s`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('[smoke] fatal:', err);
  process.exit(1);
});
