// Shared test helpers: a recording stub for the Canvas 2D context, a
// controllable requestAnimationFrame queue, and DOM fixtures. jsdom ships no
// canvas backend (getContext returns null) and no OffscreenCanvas/matchMedia,
// so everything the render/scene layer touches is faked here.

// Standard CanvasRenderingContext2D properties seeded with real-ish values so
// reads return a value (some code keys caches off ctx.font, reads globalAlpha,
// etc.) rather than the catch-all no-op used for draw *methods*.
const CTX_PROPS = {
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  lineCap: 'butt',
  lineJoin: 'miter',
  miterLimit: 10,
  lineDashOffset: 0,
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic',
  direction: 'ltr',
  globalAlpha: 1,
  globalCompositeOperation: 'source-over',
  shadowBlur: 0,
  shadowColor: 'rgba(0, 0, 0, 0)',
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  imageSmoothingEnabled: true,
  imageSmoothingQuality: 'low',
  filter: 'none',
};

function makeGradient() {
  return { addColorStop() {} };
}

// Build a fake 2D context. Every method call is recorded into `ctx.__calls`
// (array of [name, args]) so tests can assert *what was drawn*, not merely that
// nothing threw. Methods that must return a value (measureText, gradients,
// image data) return plausible shapes; everything else is a recorded no-op.
export function makeStubCtx(canvas = {}) {
  const calls = [];
  const target = { canvas, ...CTX_PROPS };

  const valueReturning = {
    measureText: (t = '') => ({
      width: String(t).length * 6,
      actualBoundingBoxAscent: 8,
      actualBoundingBoxDescent: 2,
      actualBoundingBoxLeft: 0,
      actualBoundingBoxRight: String(t).length * 6,
    }),
    createLinearGradient: makeGradient,
    createRadialGradient: makeGradient,
    createConicGradient: makeGradient,
    createPattern: () => ({ setTransform() {} }),
    getImageData: (x = 0, y = 0, w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)),
      width: w | 0,
      height: h | 0,
    }),
    createImageData: (w = 1, h = 1) => ({
      data: new Uint8ClampedArray(Math.max(1, (w | 0) * (h | 0) * 4)),
      width: w | 0,
      height: h | 0,
    }),
    getLineDash: () => [],
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    isPointInPath: () => false,
    isPointInStroke: () => false,
  };

  return new Proxy(target, {
    get(t, prop) {
      if (prop === '__calls') return calls;
      // Avoid being mistaken for a thenable / breaking util.inspect.
      if (prop === 'then' || typeof prop === 'symbol') return undefined;
      if (prop in valueReturning) {
        return (...args) => {
          calls.push([prop, args]);
          return valueReturning[prop](...args);
        };
      }
      if (prop in t) return t[prop];
      // Unknown access on a 2D context → assume it's a draw method.
      return (...args) => { calls.push([prop, args]); };
    },
    set(t, prop, value) { t[prop] = value; return true; },
  });
}

// jsdom has no OffscreenCanvas. Mirror just enough surface: width/height and a
// getContext that returns the same recording stub. transferToImageBitmap is
// used by some atlas paths.
export class StubOffscreenCanvas {
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
    this._ctx = null;
  }
  getContext() {
    if (!this._ctx) this._ctx = makeStubCtx(this);
    return this._ctx;
  }
  transferToImageBitmap() { return { width: this.width, height: this.height, close() {} }; }
  convertToBlob() { return Promise.resolve(new Blob()); }
}

// Drain the pending requestAnimationFrame callbacks once. We snapshot first so
// callbacks that re-schedule (the main-loop frame) don't spin forever.
export function flushRAF(t = 16) {
  const q = globalThis.__rafCbs;
  if (!q || q.size === 0) return 0;
  const cbs = [...q.values()];
  q.clear();
  for (const cb of cbs) cb(t);
  return cbs.length;
}

export function pendingRAFCount() {
  return globalThis.__rafCbs ? globalThis.__rafCbs.size : 0;
}

// Install the canvas + boot-splash the app boots against, returning the canvas.
export function installCanvas() {
  document.body.innerHTML =
    '<canvas id="game" role="application" aria-label="Jeweled game board"></canvas>' +
    '<div id="boot-splash"><div class="boot-gem"></div></div>';
  return document.getElementById('game');
}

// A standard window size used across canvas tests (keeps layout deterministic).
export function setViewport(w = 800, h = 600, dpr = 1) {
  window.innerWidth = w;
  window.innerHeight = h;
  window.devicePixelRatio = dpr;
}
