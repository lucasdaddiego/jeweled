// Global test environment setup (vitest setupFiles). Runs before every test
// file's imports, so module-top-level code (render.js reads window.matchMedia
// at import time) sees the stubs. Fills the gaps jsdom leaves: no canvas
// backend, no OffscreenCanvas, no matchMedia, no requestAnimationFrame.

import { beforeEach } from 'vitest';
import { makeStubCtx, StubOffscreenCanvas } from './helpers.js';

// --- Canvas 2D backend -------------------------------------------------------
HTMLCanvasElement.prototype.getContext = function getContext(type) {
  if (type === '2d') {
    if (!this.__ctx2d) this.__ctx2d = makeStubCtx(this);
    return this.__ctx2d;
  }
  return null;
};
globalThis.OffscreenCanvas = StubOffscreenCanvas;

// --- matchMedia (reduced-motion query in render.js) --------------------------
if (!window.matchMedia) {
  window.matchMedia = function matchMedia(query) {
    return {
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},        // legacy Safari API render.js falls back to
      removeListener() {},
      dispatchEvent() { return false; },
    };
  };
}

// --- requestAnimationFrame: queue, don't auto-run (tests drive frames) -------
const rafCbs = new Map();
let rafId = 0;
globalThis.__rafCbs = rafCbs;
globalThis.requestAnimationFrame = (cb) => { const id = ++rafId; rafCbs.set(id, cb); return id; };
globalThis.cancelAnimationFrame = (id) => { rafCbs.delete(id); };

// --- navigator bits ----------------------------------------------------------
if (!('vibrate' in navigator)) {
  Object.defineProperty(navigator, 'vibrate', {
    value: () => true, writable: true, configurable: true,
  });
}

// --- per-test isolation ------------------------------------------------------
beforeEach(() => {
  rafCbs.clear();
  try { localStorage.clear(); } catch { /* jsdom always has it */ }
  document.body.innerHTML = '';
  document.body.className = '';
  document.documentElement.className = '';
});
