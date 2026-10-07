// Bootstrap: canvas setup, RAF loop, scene dispatch, SW register.

import * as render from './render.js';
import * as input from './input.js';
import * as storage from './storage.js';
import * as achievements from './achievements.js';
import * as sound from './sound.js';
import * as toasts from './toasts.js';
import * as debugHud from './debugHud.js';
import * as i18n from './i18n.js';
import * as dialogs from './dialogs.js';
import * as tabLock from './tabLock.js';
import { todayISO } from './rng.js';
import { GRID } from './config.js';

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
import * as gempedia from './scenes/gempedia.js';
import * as dailyHistory from './scenes/dailyHistory.js';
import * as gallery from './scenes/gallery.js';

const SCENES = {
  title, levelSelect, gameZen, gameClassic, gameDaily, gameBlitz,
  gamePuzzle, puzzleSelect, stats, result, gempedia, dailyHistory, gallery,
};

// Scenes whose transitions should *replace* history rather than push a new
// entry. Going result → gameClassic via "Next Level", for example, shouldn't
// stack up entries the user has to mash Back through to leave the app.
const TRANSIENT_SOURCES = new Set(['result']);

let current = null;
let currentName = null;
let currentArgs = {};
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
  // Auto-replace in two situations:
  //   - Coming from a transient source (result → next).
  //   - Continuing into a scene via `restoreFrom`: the snapshot can't be
  //     serialized into history.state (too big), so pushing an entry would
  //     leave a forward-nav stub that re-enters the scene with empty args —
  //     hitting IDLE → snapshotSaveState → overwrites the real save with a
  //     fresh L1 / 0-score snapshot. Replacing avoids the orphan entry.
  const replace = opts.replace ?? (
    (args && args.restoreFrom != null) ||
    (currentName != null && TRANSIENT_SOURCES.has(currentName))
  );
  _swapScene(name, args);
  // Mirror the scene change into browser history so back/forward navigate scenes.
  // Skip when we're handling a popstate (avoid pushing while restoring).
  if (!_handlingPopState) {
    const state = { scene: name, args: serializeArgs(args) };
    const url = `#${name}`;
    if (replace) history.replaceState(state, '', url);
    else history.pushState(state, '', url);
  }
  // A pending service-worker update reloads here, AFTER the history write.
  // Inside _swapScene the URL still named the previous scene: a Back from
  // #gameZen reloaded on #gameZen and booted into the parked run, not title.
  maybeReloadForServiceWorkerUpdate();
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
  currentArgs = args || {};
  // Keyboard focus and the tracked hit rects belong to the scene that drew
  // them; the new scene starts clean (its first frame registers its own).
  clearKeyboardState();
  render.clearHitButtons();
  // Announce the scene to assistive tech — the canvas is a black box to
  // screen readers, so this hidden live region is the only navigation cue.
  // Scheduled BEFORE enter(): a scene with more to say (result: the score)
  // calls announce() from enter() and its text replaces this generic one.
  announce(i18n.t(`sr.scene.${currentName}`));
  if (current.enter) current.enter(args);
  // If a pointer is still down (typical case: scene swap fired from this
  // scene's own 'down' handler), drop the matching 'up' so it doesn't fire
  // a stray click on whatever button now sits under the release point.
  if (input.isPointerDown()) _swallowNextUp = true;
  // Reset crossfade so the new scene fades in over CROSSFADE_MS.
  sceneAlpha = 0;
  crossfadeT = 0;
}

// Post a message to the visually-hidden aria-live region (index.html). The
// canvas UI is invisible to screen readers; scene changes and end-of-run
// results are announced here so the app is at least navigable by ear.
//
// Clear now, set in a later task: both writes in one task collapse into no
// observed change for most screen readers (the same string again, or even a
// new one, stays silent). The gap makes every call a fresh insertion, and a
// second call inside the gap replaces the pending text (last writer wins).
const ANNOUNCE_DELAY_MS = 50;
let _announceTimer = 0;
export function announce(text) {
  const el = document.getElementById('sr-live');
  if (!el || !text) return;
  el.textContent = '';
  clearTimeout(_announceTimer);
  _announceTimer = setTimeout(() => { el.textContent = text; }, ANNOUNCE_DELAY_MS);
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
    drawKeyboardFocus();
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
      // Matches the 150ms opacity transition in style.css (+50ms slack).
      setTimeout(() => splash.remove(), 200);
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
    if (!paused) { lastFrameTime = performance.now(); return; }
    // Going background: persist pending debounced writes now. iOS can freeze or
    // discard the tab after 'hidden' without ever firing a reliable 'pagehide',
    // which would otherwise drop the session's most important write (end-of-run
    // best score / unlock). Idempotent with the pagehide handler — flush()
    // no-ops when nothing is dirty.
    try {
      achievements.flushPlayTime();
      storage.flush();
    } catch {}
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
      // Re-push the CURRENT scene (the one still on screen), not e.state —
      // e.state describes the entry we popped TO, so pushing it would leave
      // the top history entry misidentifying the visible scene and a later
      // Back would land somewhere unexpected. Skip when there's no app state
      // to restore depth against (Back at the app's entry boundary).
      if (e.state && e.state.scene) {
        history.pushState(
          { scene: currentName, args: serializeArgs(currentArgs) }, '', `#${currentName}`,
        );
      }
      return;
    }
    const s = e.state;
    _handlingPopState = true;
    try {
      if (s && s.scene && SCENES[s.scene]) {
        _swapScene(s.scene, withParkedRun(s.scene, s.args || {}));
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
    // The browser already moved the URL to the popped entry, so a reload
    // here (pending update, safe scene) boots into the scene on screen.
    maybeReloadForServiceWorkerUpdate();
  });
}

// This tab takes over the save from another tab (src/tabLock.js). The scene on
// screen ran on a stale copy: leave it first, while writes are still gated off,
// so its exit snapshot cannot reach the disk. Then read the save again and
// re-derive what the blob controls (the same steps as a save import).
function takeOverSave(adopt) {
  setScene('title', {}, { replace: true });
  adopt();
  i18n.init();
  sound.setEnabled(storage.getSettings().sound !== false);
  render.setGemStyle(storage.getSettings().gemStyle);
  setScene('title', {}, { replace: true });
}

// Zen and Classic park a resumable run in storage; title's Continue passes it
// back as args.restoreFrom. Re-entering either scene WITHOUT that snapshot —
// a reload while playing (the URL is #gameZen / #gameClassic), the PWA Zen
// shortcut, or a back/forward re-entry (history.state can't hold the grid) —
// must resume the parked run rather than start a fresh board: a fresh board
// reaches IDLE after its entry animation and snapshotSaveState() overwrites
// the real save with a 0-score one before the player has touched anything.
const PARKED_RUN_SCENES = { gameZen: 'zen', gameClassic: 'classic' };
function withParkedRun(name, args) {
  const mode = PARKED_RUN_SCENES[name];
  if (!mode) return args;
  const saveState = storage.load()[mode].saveState;
  return saveState ? { ...args, restoreFrom: saveState } : args;
}

// Pointer routing. The 'down' and 'up' halves are module-level so keyboard
// play (below) can deliver a synthetic press through the exact same path.
function onPointerDown(cell, x, y) {
  // First user gesture unlocks WebAudio (autoplay policy). Idempotent
  // and near-free after the first call.
  sound.unlock();
  // A real press moves the player off the keyboard: drop the focus ring and
  // the board cursor. A synthetic press (keyboard) keeps them.
  if (!_syntheticPress) clearKeyboardState();
  if (dialogs.handlePointer({ type: 'down', cell, x, y })) return;
  if (current && current.onPointer) current.onPointer({ type: 'down', cell, x, y });
}

function onPointerUp(x, y) {
  // On touch the release, not the press, is the user-activation event, so
  // the AudioContext resume inside unlock() only succeeds here on a first tap.
  sound.unlock();
  if (_swallowNextUp) { _swallowNextUp = false; return; }
  if (dialogs.handlePointer({ type: 'up', x, y })) return;
  if (current && current.onPointer) current.onPointer({ type: 'up', x, y });
}

function setupInput() {
  input.setup();
  input.on({
    onTapCell: onPointerDown,
    onMove: (x, y) => {
      if (dialogs.isOpen()) { dialogs.onMove(x, y); return; }
      if (current && current.onMove) current.onMove(x, y);
    },
    onUp: onPointerUp,
    onKey,
    onCancel: (x, y) => {
      // Consume any pending swallow here too, symmetric with 'up' — otherwise
      // a pointercancel (OS gesture, blur) between _swapScene and the real
      // 'up' would leak the flag onto the next gesture's release.
      if (_swallowNextUp) _swallowNextUp = false;
      if (dialogs.handlePointer({ type: 'cancel', x, y })) return;
      if (current && current.onPointer) current.onPointer({ type: 'cancel', x, y });
    },
    onWheel: (dy, x, y) => {
      if (dialogs.isOpen()) return;
      if (current && current.onWheel) current.onWheel(dy, x, y);
    },
  });
}

// === Keyboard play ===
// index.html gives the canvas tabindex=0 and input.js forwards keydown while
// it has focus. Tab / Shift+Tab walk the buttons the scene drew this frame
// (render.hitButtons()), Enter or Space presses the focused one. On a board
// scene the arrows move a cell cursor, Enter / Space picks the gem up and the
// next arrow swaps it with that neighbour; Escape drops focus and cursor. On
// a menu scene the arrows walk the buttons like Tab.
//
// A press is delivered as a synthetic pointer down + up at the target's
// centre, so each scene's own pointer logic (settings-overlay precedence,
// release-activated buttons, drag-to-swap) handles it unchanged.
const BOARD_SCENES = new Set(['gameZen', 'gameClassic', 'gameDaily', 'gameBlitz', 'gamePuzzle']);
const ARROWS = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
let _kbFocus = -1;          // index into focusableButtons(), -1 = none
let _kbCursor = null;       // { r, c } on a board scene, null = hidden
let _kbSelected = false;    // the cursor gem is picked up: the next arrow swaps it
let _syntheticPress = false;

// A modal (power-up overlay) or the settings overlay sits above the rest of
// the scene and its pointer handler only accepts its own rects; Tab walks the
// same subset so a press can never land on a button hidden underneath.
function focusableButtons() {
  const all = render.hitButtons() || [];
  const modal = all.filter(b => b.modal);
  if (modal.length) return modal;
  const settings = all.filter(b => b.kind === 'settings');
  return settings.length ? settings : all;
}

function clearKeyboardState() {
  _kbFocus = -1;
  _kbCursor = null;
  _kbSelected = false;
  render.setKeyboardCursor(null);
}

// Down at (x, y), up at (upX, upY): a press when both are the same point, a
// one-cell drag (dragInput commits the swap) when they are not.
function syntheticPress(x, y, upX = x, upY = y) {
  _syntheticPress = true;
  try {
    onPointerDown(render.screenToCell(x, y), x, y);
    onPointerUp(upX, upY);
  } finally {
    _syntheticPress = false;
  }
}

function focusButton(idx, buttons) {
  _kbFocus = idx;
  _kbCursor = null;
  _kbSelected = false;
  render.setKeyboardCursor(null);
  // Scenes draw the hovered look from their own cursor: move it onto the
  // button so the focus reads as a highlight as well as a ring.
  const b = buttons[idx];
  if (current.onMove) current.onMove(b.x + b.w / 2, b.y + b.h / 2);
}

// Returns true when the key was consumed (input.js then prevents the default).
function onKey(key, shift) {
  // Escape / Enter belong to an open dialog (dialogs.js listens on window).
  if (dialogs.isOpen() || !current) return false;
  const onBoard = BOARD_SCENES.has(currentName);
  if (key === 'Tab' || (!onBoard && key in ARROWS)) {
    const buttons = focusableButtons();
    if (!buttons.length) return false;
    const back = key === 'Tab' ? shift : (key === 'ArrowUp' || key === 'ArrowLeft');
    const n = buttons.length;
    const next = _kbFocus < 0 ? (back ? n - 1 : 0) : (_kbFocus + (back ? n - 1 : 1)) % n;
    focusButton(next, buttons);
    return true;
  }
  if (key === 'Enter' || key === ' ') {
    const buttons = focusableButtons();
    if (_kbFocus >= 0 && _kbFocus < buttons.length) {
      const b = buttons[_kbFocus];
      syntheticPress(b.x + b.w / 2, b.y + b.h / 2);
      return true;
    }
    if (!_kbCursor) return false;
    _kbSelected = !_kbSelected;
    render.setKeyboardCursor({ ..._kbCursor, selected: _kbSelected });
    return true;
  }
  if (key === 'Escape') {
    if (_kbFocus < 0 && !_kbCursor) return false;
    clearKeyboardState();
    return true;
  }
  if (key in ARROWS) {   // a board scene (menus were handled above)
    const [dr, dc] = ARROWS[key];
    _kbFocus = -1;
    if (!_kbCursor) {
      _kbCursor = { r: 0, c: 0 };          // the first arrow only shows the cursor
    } else if (_kbSelected) {
      swapTowards(dr, dc);
      _kbSelected = false;
    } else {
      _kbCursor = {
        r: Math.max(0, Math.min(GRID - 1, _kbCursor.r + dr)),
        c: Math.max(0, Math.min(GRID - 1, _kbCursor.c + dc)),
      };
    }
    render.setKeyboardCursor({ ..._kbCursor, selected: _kbSelected });
    return true;
  }
  return false;
}

// Swap the cursor gem with its neighbour: down on the gem, up a full cell
// away, which is past dragInput's commit threshold. Off the board: nothing.
function swapTowards(dr, dc) {
  const r = _kbCursor.r + dr, c = _kbCursor.c + dc;
  if (r < 0 || r >= GRID || c < 0 || c >= GRID) return;
  const { boardX, boardY, cellSize } = render.layout;
  syntheticPress(
    boardX + (_kbCursor.c + 0.5) * cellSize, boardY + (_kbCursor.r + 0.5) * cellSize,
    boardX + (c + 0.5) * cellSize, boardY + (r + 0.5) * cellSize,
  );
}

// Gold ring around the focused button, drawn after the scene each frame.
function drawKeyboardFocus() {
  if (_kbFocus < 0) return;
  const buttons = focusableButtons();
  if (_kbFocus >= buttons.length) { _kbFocus = -1; return; }   // the scene drew fewer buttons
  const ctx = render.ctxRef();
  if (!ctx) return;
  const b = buttons[_kbFocus];
  ctx.save();
  ctx.strokeStyle = '#ffd166';
  ctx.lineWidth = 3;
  render.roundRect(ctx, b.x - 4, b.y - 4, b.w + 8, b.h + 8, 14);
  ctx.stroke();
  ctx.restore();
}

// True when the current scene is at a safe moment to reload (no in-flight
// game). 'result' is deliberately NOT here: reloading the instant the score
// screen enters would eat the payoff moment — the update lands on the next
// menu scene instead.
function isSafeToReload() {
  return currentName === 'title'
      || currentName === 'levelSelect'
      || currentName === 'puzzleSelect'
      || currentName === 'stats';
}

function maybeReloadForServiceWorkerUpdate() {
  if (!_swUpdateReady || _swRefreshing || !isSafeToReload()) return;
  _swRefreshing = true;
  window.location.reload();
}

function init() {
  // One active tab: claim the shared save before anything can write to it
  // (load() below may write a migrated blob). See src/tabLock.js.
  tabLock.start({ onTakeover: takeOverSave });
  render.setupCanvas();
  // Apply the persisted gem style before the first atlas build so the very
  // first frame uses the right glyph set (setGemStyle only rebuilds on change).
  render.setGemStyle(storage.getSettings().gemStyle);
  render.buildAtlas();
  setupInput();
  setupVisibility();
  setupHistoryNav();

  // Bootstrap initial scene. Use replaceState so a single browser-back from title
  // leaves the page rather than re-displaying it. A #hash naming a directly
  // enterable scene (PWA manifest shortcuts: #gameDaily / #gameBlitz / #gameZen)
  // boots straight into it. Zen/Classic resume a parked run (withParkedRun);
  // the other game scenes entered this way just start fresh runs.
  storage.load(); // ensure cache is warm
  i18n.init();    // resolve locale from settings/navigator/URL before any scene draws
  sound.setEnabled(storage.getSettings().sound !== false);
  const BOOT_SCENES = new Set([
    'title', 'levelSelect', 'puzzleSelect', 'stats', 'gempedia',
    'dailyHistory', 'gallery', 'gameZen', 'gameClassic', 'gameDaily', 'gameBlitz',
  ]);
  const bootHash = (location.hash || '').replace(/^#/, '');
  const bootScene = BOOT_SCENES.has(bootHash) ? bootHash : 'title';
  setScene(bootScene, withParkedRun(bootScene, {}), { replace: true });

  // Flush debounced storage writes synchronously on tab close. Without this,
  // the last ~250ms of changes (typical: end-of-run save) would be lost on
  // mobile when the user backgrounds the app.
  window.addEventListener('pagehide', () => {
    try {
      achievements.flushPlayTime();
      storage.flush();
    } catch {}
    tabLock.release();   // after the last write
  });
  // Back from the back/forward cache: ask for the save again.
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) tabLock.reacquire();
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
    let hadController = !!navigator.serviceWorker.controller;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' })
        .then(reg => {
          // When a new SW takes over an *already-controlled* page, reload — but
          // defer if the user is mid-game. They'll pick up the new version
          // next time they navigate to a safe scene (title / stats / etc).
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (_swRefreshing) return;
            if (!hadController) {
              // First-ever install claiming this page isn't an update — but any
              // LATER controllerchange in this session is. Flip the flag so a
              // deploy during a long first session still refreshes.
              hadController = true;
              return;
            }
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
  // (Explicit ===1 check so ?debug=0 doesn't enable it.)
  const dbg = location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || new URLSearchParams(location.search).get('debug') === '1';
  _dbg = dbg;
  debugHud.setEnabled(dbg);
  if (dbg) window.__game = {
    storage, setScene, clockMs,
    setLanguage: i18n.setLanguage,
    getLocale: i18n.getLocale,
    isSwUpdateReady: () => _swUpdateReady,
    tabState: tabLock.getState,
    // Geometry + date helpers for the e2e smoke (test-e2e/smoke.spec.mjs).
    // It computes tap targets from these instead of importing /src/*.js, so
    // the same spec runs against the single-file production bundle too.
    viewport: render.getViewport,
    layout: render.layout,
    todayISO,
    resultLayout: result.computeResultLayout,
  };
}

// Boot wrapper: if init() throws (the realistic case: OffscreenCanvas missing
// on Safari < 16.4 — the app's hard compatibility floor), the boot splash
// would otherwise spin forever with no message. Swap it for a plain
// unsupported-browser notice instead of a silent hang.
function boot() {
  try {
    init();
  } catch (err) {
    console.error('boot failed:', err);
    const splash = document.getElementById('boot-splash');
    if (!splash) return;
    const dots = splash.querySelector('.boot-dots');
    if (dots) dots.remove();
    const msg = document.createElement('div');
    msg.className = 'boot-error';
    // i18n isn't reliably up when boot fails — hardcode both locales.
    msg.textContent = 'This browser is too old to run Jeweled — please update it. / '
      + 'Este navegador es demasiado antiguo para Jeweled — actualízalo.';
    splash.appendChild(msg);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
