// Debug HUD telemetry. Opt-in via ?debug=1 / localhost.
//
// Despite the historic name "perf.js", nothing here adjusts game behavior to
// hit a perf target — it's purely measurement feeding the on-screen debug
// HUD in main.js (FPS, 95p frame time, hot-path counters, active anim size).
// If real quality throttling is ever needed, that belongs in a separate
// module so the boundary stays clear.
//
// Counters are incremented by hot-path callers (matcher.findMatches,
// render.drawBoard) and reset each frame by main.js, which also samples
// frame times into a rolling buffer for FPS + 95p readouts.
//
// Nothing here allocates per frame: the buffer is a fixed-size Float64Array
// and the counters object is reused.

export const counters = {
  findMatches: 0,
  drawBoard: 0,
};

// Active cascade ref — scenes register on enter, clear on exit, so the debug
// HUD can read anims.size without a scene-specific lookup. Single ref since
// only one game scene is active at a time.
let _activeCascade = null;
export function setActiveCascade(c) { _activeCascade = c; }
export function activeCascade() { return _activeCascade; }

export function resetFrameCounters() {
  counters.findMatches = 0;
  counters.drawBoard = 0;
}

const WINDOW = 120;                 // ~2s at 60fps
const buf = new Float64Array(WINDOW);
let bufN = 0;
let bufHead = 0;

export function recordFrame(dtMs) {
  buf[bufHead] = dtMs;
  bufHead = (bufHead + 1) % WINDOW;
  if (bufN < WINDOW) bufN++;
}

// Returns { fps, p95 } using the current rolling window. Avoids any
// per-call allocation by reusing a single scratch array.
const scratch = new Float64Array(WINDOW);
export function frameStats() {
  if (bufN === 0) return { fps: 0, p95: 0, avg: 0 };
  let sum = 0;
  for (let i = 0; i < bufN; i++) {
    const v = buf[i];
    scratch[i] = v;
    sum += v;
  }
  // Sort the populated slice in place. Built-in sort over a typed-array
  // subarray is fine for n=120 each frame (well under a ms).
  const slice = scratch.subarray(0, bufN);
  slice.sort();
  const p95idx = Math.min(bufN - 1, Math.floor(bufN * 0.95));
  const p95 = slice[p95idx];
  const avg = sum / bufN;
  const fps = avg > 0 ? 1000 / avg : 0;
  return { fps, p95, avg };
}
