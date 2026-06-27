import { describe, it, expect, vi } from 'vitest';

// debugHud is an import-clean singleton: counters, the `enabled` flag, the
// active-cascade ref and the rolling frame-time ring buffer all live at module
// scope. Re-import fresh per scenario so the buffer (which has no reset export)
// starts empty and earlier recordFrame() calls don't bleed across cases.
async function fresh() {
  vi.resetModules();
  return import('../src/debugHud.js');
}

describe('hot-path counters', () => {
  it('start at zero and resetFrameCounters() clears them', async () => {
    const d = await fresh();
    expect(d.counters).toEqual({ findMatches: 0, drawBoard: 0 });
    d.counters.findMatches = 5;
    d.counters.drawBoard = 9;
    d.resetFrameCounters();
    expect(d.counters).toEqual({ findMatches: 0, drawBoard: 0 });
  });
});

describe('enabled flag', () => {
  it('defaults to false and toggles via setEnabled (live binding)', async () => {
    const d = await fresh();
    expect(d.enabled).toBe(false);
    d.setEnabled(true);
    expect(d.enabled).toBe(true);    // the exported `let` reflects the new value
    d.setEnabled(false);
    expect(d.enabled).toBe(false);
  });
});

describe('active cascade ref', () => {
  it('defaults to null and round-trips a registered cascade', async () => {
    const d = await fresh();
    expect(d.activeCascade()).toBeNull();
    const fake = { anims: new Map() };
    d.setActiveCascade(fake);
    expect(d.activeCascade()).toBe(fake);
    d.setActiveCascade(null);
    expect(d.activeCascade()).toBeNull();
  });
});

describe('frame stats', () => {
  it('returns zeros before any frame is recorded (empty window)', async () => {
    const d = await fresh();
    expect(d.frameStats()).toEqual({ fps: 0, p95: 0, avg: 0 });
  });

  it('computes avg/fps and the 95th-percentile over a partial window', async () => {
    const d = await fresh();
    for (let i = 1; i <= 10; i++) d.recordFrame(i);   // dt = 1..10ms
    const { fps, p95, avg } = d.frameStats();
    expect(avg).toBeCloseTo(5.5, 10);                  // mean of 1..10
    expect(fps).toBeCloseTo(1000 / 5.5, 6);            // avg > 0 branch
    // p95idx = min(bufN-1, floor(bufN*0.95)) = min(9, floor(9.5)) = 9 -> value 10
    expect(p95).toBe(10);
  });

  it('reports 0 fps when every recorded frame time is 0 (avg <= 0 branch)', async () => {
    const d = await fresh();
    for (let i = 0; i < 5; i++) d.recordFrame(0);
    const { fps, avg, p95 } = d.frameStats();
    expect(avg).toBe(0);
    expect(fps).toBe(0);                               // avg > 0 ? ... : 0  -> else
    expect(p95).toBe(0);
  });

  it('caps the rolling window at 120 samples (ring-buffer wrap, bufN clamp)', async () => {
    const d = await fresh();
    // Record well past WINDOW (120). If bufN were not clamped, frameStats would
    // read past the fixed 120-slot Float64Array and produce NaN.
    for (let i = 0; i < 200; i++) d.recordFrame(10);
    const { avg, fps, p95 } = d.frameStats();
    expect(avg).toBe(10);     // only the 120 retained samples, all 10ms
    expect(fps).toBe(100);    // 1000 / 10
    expect(p95).toBe(10);
  });

  it('p95 tracks the tail once old samples are overwritten by the wrap', async () => {
    const d = await fresh();
    for (let i = 0; i < 120; i++) d.recordFrame(5);   // fill the window with 5ms
    for (let i = 0; i < 6; i++) d.recordFrame(100);   // wrap: overwrite the 6 oldest
    // 120 samples = 114 fives + 6 hundreds. Sorted, p95idx = floor(120*0.95) = 114,
    // which lands on the first 100.
    expect(d.frameStats().p95).toBe(100);
  });
});
