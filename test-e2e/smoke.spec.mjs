// E2E smoke test — real Chromium against the real app, zero config.
//
//   node test-e2e/smoke.spec.mjs
//
// Self-contained on purpose: it starts its own static server (no dependency on
// `serve` or any config), launches headless Chromium via the plain `playwright`
// library (NOT the @playwright/test runner), drives the app through the
// localhost-only `window.__game` debug hook, and exits non-zero on any failure.
// It lives outside test/ and uses .mjs so the Vitest suite (include:
// test/**/*.test.js) never picks it up.
//
// What it asserts:
//   1. The page boots: #boot-splash is removed once the first frame is drawn.
//   2. canvas#game exists with a nonzero backing store and layout size.
//   3. The title scene actually painted pixels (not a blank/black canvas).
//   4. Scene switch via __game.setScene('gameZen') settles to cascade IDLE
//      (entry animation completes) and back to title cleans up window.__zen.
//   5. The save file lands in localStorage under 'gem-match:v1'.
//   6. Zero console errors and zero uncaught page errors across all of it.

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------------------
// Tiny hermetic static server (repo root, correct MIME types, no caching).
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
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
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
