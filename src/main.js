// Bootstrap: canvas setup, RAF loop, scene dispatch, SW register.

import * as render from './render.js';
import * as input from './input.js';
import * as storage from './storage.js';
import * as toasts from './toasts.js';
import * as debugHud from './debugHud.js';
import * as i18n from './i18n.js';
import * as dialogs from './dialogs.js';

// Scene modules
import * as title from './scenes/title.js';
import * as levelSelect from './scenes/levelSelect.js';
import * as gameZen from './scenes/gameZen.js';
import * as gameClassic from './scenes/gameClassic.js';
import * as gameDaily from './scenes/gameDaily.js';
import * as gameBlitz from './scenes/gameBlitz.js';
import * as gamePuzzle from './scenes/gamePuzzle.js';
import * as puzzleSelect from './scenes/puzzleSelect.js';
import * as stats from './scenes/stats.js';
import * as result from './scenes/result.js';

const SCENES = {
  title, levelSelect, gameZen, gameClassic, gameDaily, gameBlitz,
  gamePuzzle, puzzleSelect, stats, result,
};

// Scenes whose transitions should *replace* history rather than push a new
// entry. Going result → gameClassic via "Next Level", for example, shouldn't
// stack up entries the user has to mash Back through to leave the app.
const TRANSIENT_SOURCES = new Set(['result']);

let current = null;
let currentName = null;
let lastFrameTime = 0;
let paused = false;
let _handlingPopState = false;
let _firstFrameDrawn = false;
let _swRefreshing = false;
let _swUpdateReady = false;
// When a 'down' event handler swaps the scene, the matching 'up' would
// otherwise leak into the *new* scene and fire as a click on whatever button
// happens to occupy the release coordinates. (Hit puzzleSelect from the
// title's Puzzles tap → up landed on a puzzle tile → instant gameplay
// launch.) This flag is set inside _swapScene and consumed by the next 'up'.
let _swallowNextUp = false;

// Debug HUD — only drawn when dbg is true (localhost or ?debug=1). Re-evaluated
// at init so a ?debug=1 page load enables it for the whole session.
let _dbg = false;
let _hudCounters = { findMatches: 0, drawBoard: 0 };   // snapshotted per frame

// Paused-aware monotonic clock in ms. Effects that previously read Date.now()
// (sheen pulse, glow pulse, hint pulse) should read this instead, so a long
// tab-away doesn't desync every animated phase.
let _clockMs = 0;
export function clockMs() { return _clockMs; }

// Scene crossfade — sceneAlpha is the OPACITY of the new scene during a swap.
// We reset to 0 on swap and tween to 1 over CROSSFADE_MS while the scene draws.
const CROSSFADE_MS = 220;
let sceneAlpha = 1;          // 0 = scene invisible (black overlay), 1 = fully visible
let crossfadeT = 0;          // 0..CROSSFADE_MS — counter

export function setScene(name, args = {}, opts = {}) {
  // Auto-replace on transient sources (result → next), unless the caller
  // explicitly chose otherwise.
  const replace = opts.replace ?? (currentName != null && TRANSIENT_SOURCES.has(currentName));
  _swapScene(name, args);
  // Mirror the scene change into browser history so back/forward navigate scenes.
  // Skip when we're handling a popstate (avoid pushing while restoring).
  if (_handlingPopState) return;
  const state = { scene: name, args: serializeArgs(args) };
  const url = `#${name}`;
  if (replace) history.replaceState(state, '', url);
  else history.pushState(state, '', url);
}

function _swapScene(name, args) {
  if (current && current.exit) current.exit();
  current = SCENES[name];
  currentName = name;
  if (!current) {
    console.warn('unknown scene:', name);
    current = SCENES.title;
    currentName = 'title';
  }
  if (current.enter) current.enter(args);
  // If a pointer is still down (typical case: scene swap fired from this
  // scene's own 'down' handler), drop the matching 'up' so it doesn't fire
  // a stray click on whatever button now sits under the release point.
  if (input.isPointerDown()) _swallowNextUp = true;
  // Reset crossfade so the new scene fades in over CROSSFADE_MS.
  sceneAlpha = 0;
  crossfadeT = 0;
  maybeReloadForServiceWorkerUpdate();
}

// Strip non-serializable / oversized args before stashing in history.state.
// restoreFrom holds a full grid snapshot — too big to put in state, and a back-nav
// shouldn't re-restore the same one-shot continue anyway.
function serializeArgs(args) {
  if (!args || typeof args !== 'object') return {};
  const out = {};
  for (const k of Object.keys(args)) {
    if (k === 'restoreFrom') continue;
    const v = args[k];
    if (v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      out[k] = v;
    }
  }
  return out;
}

function frame(now) {
  if (paused) { lastFrameTime = now; requestAnimationFrame(frame); return; }
  let dt = now - lastFrameTime;
  if (dt > 50) dt = 50; // clamp big gaps (tab refocus, slow frames)
  if (dt < 0) dt = 0;
  lastFrameTime = now;
  _clockMs += dt;

  // Snapshot + reset the per-frame counters so scene draws can mutate them
  // freely; the HUD reads from the snapshot taken at the start of THIS frame.
  if (_dbg) {
    _hudCounters.findMatches = debugHud.counters.findMatches;
    _hudCounters.drawBoard = debugHud.counters.drawBoard;
    debugHud.resetFrameCounters();
    debugHud.recordFrame(dt);
  }

  if (current) {
    if (current.update) current.update(dt);
    if (current.draw) current.draw();
  }
  // Crossfade overlay — black rect with opacity (1 - sceneAlpha), drawn over
  // the just-painted scene so the new scene fades in.
  if (crossfadeT < CROSSFADE_MS) {
    crossfadeT = Math.min(CROSSFADE_MS, crossfadeT + dt);
    sceneAlpha = crossfadeT / CROSSFADE_MS;
    const ctx = render.ctxRef();
    const { w, h } = render.getViewport();
    if (ctx) {
      ctx.fillStyle = `rgba(0, 0, 0, ${1 - sceneAlpha})`;
      ctx.fillRect(0, 0, w, h);
    }
  }
  // Global overlays drawn on top of every scene
  toasts.update(dt);
  toasts.draw();
  dialogs.draw();
  if (_dbg) drawDebugHud();

  // Fade the boot splash once we've successfully drawn a first frame. Avoids
  // the case where the splash disappears via timeout while modules are still
  // resolving on slow networks and leaves a blank canvas.
  if (!_firstFrameDrawn) {
    _firstFrameDrawn = true;
    const splash = document.getElementById('boot-splash');
    if (splash) {
      splash.classList.add('fade-out');
      setTimeout(() => splash.remove(), 400);
    }
  }

  requestAnimationFrame(frame);
}

function drawDebugHud() {
  const ctx = render.ctxRef();
  if (!ctx) return;
  const { fps, p95 } = debugHud.frameStats();
  // 5 lines: fps · 95p · anims · findMatches/f · drawBoard/f. Cheap printf-y
  // formatting; this only runs when ?debug=1, so we don't sweat the strings.
  const ac = debugHud.activeCascade();
  const animsSize = ac ? ac.anims.size : '—';
  const lines = [
    `${fps.toFixed(1)} fps`,
    `${p95.toFixed(1)}ms p95`,
    `anims: ${animsSize}`,
    `findMatches/f: ${_hudCounters.findMatches}`,
    `drawBoard/f: ${_hudCounters.drawBoard}`,
  ];
  ctx.save();
  ctx.font = '12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  // Background pill so text reads against any scene.
  const x = 8, y = 8, pad = 6, lh = 14;
  let w = 0;
  for (const s of lines) w = Math.max(w, ctx.measureText(s).width);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.fillRect(x, y, w + pad * 2, lines.length * lh + pad * 2);
  ctx.fillStyle = '#9affc8';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], x + pad, y + pad + i * lh);
  }
  ctx.restore();
}

function setupVisibility() {
  document.addEventListener('visibilitychange', () => {
    paused = document.hidden;
    if (!paused) lastFrameTime = performance.now();
  });
}

function setupHistoryNav() {
  window.addEventListener('popstate', e => {
    // If a dialog is open, treat Back as "close the dialog" rather than
    // "navigate scenes". Without this:
    //  - Android system Back during a dialogs.confirm(...) await leaks the
    //    pending Promise forever (caller's await never resolves), and
    //  - the scene under the dialog swaps unexpectedly.
    // After dismissing the dialog, re-push the just-popped scene state so the
    // history stack depth matches what it was before the Back press.
    if (dialogs.consumeBack()) {
      if (e.state && e.state.scene) {
        history.pushState(e.state, '', location.hash);
      }
      return;
    }
    const s = e.state;
    _handlingPopState = true;
    try {
      if (s && s.scene && SCENES[s.scene]) {
        _swapScene(s.scene, s.args || {});
      } else {
        // No state (initial entry or external nav) → land on title and
        // replaceState so the synthetic landing doesn't leave a stale
        // history entry that the next pushState would orphan.
        _swapScene('title', {});
        history.replaceState({ scene: 'title', args: {} }, '', '#title');
      }
    } finally {
      _handlingPopState = false;
    }
  });
}

function setupInput() {
  input.setup();
  input.on({
    onTapCell: (cell, x, y) => {
      if (dialogs.handlePointer({ type: 'down', cell, x, y })) return;
      if (current && current.onPointer) current.onPointer({ type: 'down', cell, x, y });
    },
    onMove: (x, y) => {
      if (dialogs.isOpen()) { dialogs.onMove(x, y); return; }
      if (current && current.onMove) current.onMove(x, y);
    },
    onUp: (x, y) => {
      if (_swallowNextUp) { _swallowNextUp = false; return; }
      if (dialogs.handlePointer({ type: 'up', x, y })) return;
      if (current && current.onPointer) current.onPointer({ type: 'up', x, y });
    },
    onCancel: (x, y) => {
      if (dialogs.handlePointer({ type: 'cancel', x, y })) return;
      if (current && current.onPointer) current.onPointer({ type: 'cancel', x, y });
    },
    onWheel: (dy, x, y) => {
      if (dialogs.isOpen()) return;
      if (current && current.onWheel) current.onWheel(dy, x, y);
    },
  });
}

// True when the current scene is at a safe moment to reload (no in-flight game).
function isSafeToReload() {
  return currentName === 'title'
      || currentName === 'levelSelect'
      || currentName === 'puzzleSelect'
      || currentName === 'stats'
      || currentName === 'result';
}

function maybeReloadForServiceWorkerUpdate() {
  if (!_swUpdateReady || _swRefreshing || !isSafeToReload()) return;
  _swRefreshing = true;
  window.location.reload();
}

function init() {
  render.setupCanvas();
  render.buildAtlas();
  setupInput();
  setupVisibility();
  setupHistoryNav();

  // Bootstrap initial scene. Use replaceState so a single browser-back from title
  // leaves the page rather than re-displaying it.
  storage.load(); // ensure cache is warm
  i18n.init();    // resolve locale from settings/navigator/URL before any scene draws
  setScene('title', {}, { replace: true });

  // Flush debounced storage writes synchronously on tab close. Without this,
  // the last ~250ms of changes (typical: end-of-run save) would be lost on
  // mobile when the user backgrounds the app.
  window.addEventListener('pagehide', () => {
    try { storage.flush(); } catch {}
  });

  lastFrameTime = performance.now();
  requestAnimationFrame(frame);

  // Register service worker after first paint.
  // updateViaCache: 'none' so the browser never serves a cached sw.js — every load
  // re-checks for updates. Pair with a focus listener that re-checks too.
  if ('serviceWorker' in navigator) {
    // Capture controller state BEFORE registering. If the page was uncontrolled
    // at load (first-ever install), the controllerchange that fires when the
    // brand-new SW claims this page isn't an "update" — there's no old code to
    // refresh from. Without this guard, every brand-new visitor would hit an
    // unnecessary reload as soon as they leave the title scene.
    const hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(reg => {
          // When a new SW takes over an *already-controlled* page, reload — but
          // defer if the user is mid-game. They'll pick up the new version
          // next time they navigate to a safe scene (title / result / etc).
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_swRefreshing || !hadController) return;
            _swUpdateReady = true;
            maybeReloadForServiceWorkerUpdate();
          });
          // Re-check for updates when the tab regains focus.
          window.addEventListener('focus', () => reg.update().catch(() => {}));
        })
        .catch(err => console.warn('SW register failed:', err));
    });
  }

  // Expose for debug — only on localhost / when ?debug=1 is in the URL.
  // Avoids letting any random visitor wipe their own state via devtools by
  // accident, and lays the groundwork for adding cloud sync later.
  const dbg = location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || new URLSearchParams(location.search).has('debug');
  _dbg = dbg;
  if (dbg) window.__game = {
    storage, setScene, clockMs,
    setLanguage: i18n.setLanguage,
    getLocale: i18n.getLocale,
    isSwUpdateReady: () => _swUpdateReady,
  };
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
