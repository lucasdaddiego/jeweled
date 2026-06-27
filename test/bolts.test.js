import { describe, it, expect, beforeEach, vi } from 'vitest';
import { makeStubCtx } from './helpers.js';
import * as bolts from '../src/bolts.js';

// bolts.js is a module-level pool singleton (32 Bolts + an aliveCount). clear()
// is its reset hook, so every test starts from an empty pool. Math.random drives
// the jitter inside buildPath; pinning it makes the generated polylines (and the
// recorded moveTo/lineTo coords) deterministic. 0.5 → zero jitter (points land
// exactly on the straight line), which keeps coordinate assertions simple.
beforeEach(() => {
  bolts.clear();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

// --- ctx-call helpers --------------------------------------------------------
const names = (ctx) => ctx.__calls.map((c) => c[0]);
const count = (ctx, name) => names(ctx).filter((n) => n === name).length;
const argsOf = (ctx, name) => ctx.__calls.filter((c) => c[0] === name).map((c) => c[1]);

describe('spawn + draw', () => {
  it('draws a lightning bolt as a glow + white core polyline', () => {
    bolts.spawnLightning(0, 0, 200, 0); // dist 200 → segs = floor(200/28) = 7
    const ctx = makeStubCtx();
    bolts.draw(ctx);

    expect(count(ctx, 'save')).toBe(1);
    expect(count(ctx, 'restore')).toBe(1);
    // glow pass + core pass = two strokes, each its own beginPath + moveTo.
    expect(count(ctx, 'beginPath')).toBe(2);
    expect(count(ctx, 'stroke')).toBe(2);
    expect(count(ctx, 'moveTo')).toBe(2);
    // 7 segments → 7 lineTo per stroke → 14 total.
    expect(count(ctx, 'lineTo')).toBe(14);
    // polyline starts at (x1,y1) and ends at (x2,y2).
    expect(argsOf(ctx, 'moveTo')[0]).toEqual([0, 0]);
    expect(argsOf(ctx, 'lineTo')).toContainEqual([200, 0]);
    // core pass is the last to set style → white core, width 3.
    expect(ctx.strokeStyle).toBe('#ffffff');
    expect(ctx.lineWidth).toBe(3);
  });

  it('draws a star trail in gold with a thicker line', () => {
    bolts.spawnStarTrail(0, 0, 10, 10); // dist ~14 → segs clamped to min 4
    const ctx = makeStubCtx();
    bolts.draw(ctx);

    expect(count(ctx, 'stroke')).toBe(2);
    expect(count(ctx, 'lineTo')).toBe(8); // 4 segments per stroke
    expect(ctx.strokeStyle).toBe('#ffe48a');
    expect(ctx.lineWidth).toBe(4);
  });

  it('scales segment count with distance (short bolt → minimum 4)', () => {
    bolts.spawnLightning(0, 0, 10, 0); // dist 10 → floor(10/28)=0 → clamped to 4
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(count(ctx, 'lineTo')).toBe(8); // 4 per stroke
  });

  it('applies perpendicular jitter to the midpoints', () => {
    Math.random.mockReturnValue(0.75); // j = (0.75-0.5)*jitter
    bolts.spawnLightning(0, 0, 0, 100); // vertical → jitter pushes x off the line
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    // dist 100 → segs 4; perp unit = (-1,0); jitter 16 → j=4; first midpoint at
    // k=0.25: (0 + 0 + (-1)*4, 0 + 100*0.25 + 0) = (-4, 25).
    expect(argsOf(ctx, 'lineTo')).toContainEqual([-4, 25]);
  });

  it('handles a zero-length bolt without dividing by zero', () => {
    bolts.spawnLightning(5, 5, 5, 5); // dist 0 → the `dist || 1` guard kicks in
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(count(ctx, 'stroke')).toBe(2);
    expect(argsOf(ctx, 'moveTo')[0]).toEqual([5, 5]);
    // every coordinate is finite (no NaN from a 0/0 division).
    for (const [x, y] of argsOf(ctx, 'lineTo')) {
      expect(Number.isFinite(x)).toBe(true);
      expect(Number.isFinite(y)).toBe(true);
    }
  });

  it('draws nothing when the pool is empty', () => {
    const ctx = makeStubCtx();
    bolts.draw(ctx); // aliveCount === 0 → early return, not even save()
    expect(ctx.__calls).toEqual([]);
  });
});

describe('update / lifetime', () => {
  it('advances a live bolt and keeps drawing it', () => {
    bolts.spawnLightning(0, 0, 10, 10);
    bolts.update(16); // well under maxT (340) → still alive
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(count(ctx, 'stroke')).toBe(2);
  });

  it('removes a bolt once it reaches the end of its life', () => {
    bolts.spawnLightning(0, 0, 10, 10); // maxT 340
    bolts.update(340); // t >= maxT → bolt dies, aliveCount → 0
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(ctx.__calls).toEqual([]); // nothing alive to draw
  });

  it('fades a near-dead bolt out (alpha < 0.02 is skipped, not stroked)', () => {
    bolts.spawnLightning(0, 0, 10, 10); // maxT 340
    bolts.update(335); // alpha = 1 - 335/340 ≈ 0.0147 < 0.02, still alive
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    // draw ran (save/restore present) but the bolt was too faint to stroke.
    expect(count(ctx, 'save')).toBe(1);
    expect(count(ctx, 'restore')).toBe(1);
    expect(count(ctx, 'stroke')).toBe(0);
  });

  it('is a no-op when nothing is alive', () => {
    expect(() => bolts.update(1000)).not.toThrow();
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(ctx.__calls).toEqual([]);
  });
});

describe('pool capacity', () => {
  // POOL_SIZE is 32; the 33rd spawn must reuse the oldest slot rather than grow.
  it('spawnLightning reuses the oldest slot when the pool is full', () => {
    for (let i = 0; i < 32; i++) bolts.spawnLightning(i, i, i + 10, i + 10);
    bolts.spawnLightning(99, 99, 109, 109); // 33rd → stomps an already-alive slot
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    // exactly 32 bolts alive (pool is bounded) → 32 * 2 strokes.
    expect(count(ctx, 'stroke')).toBe(64);
  });

  it('spawnStarTrail also reuses a slot when the pool is full', () => {
    for (let i = 0; i < 32; i++) bolts.spawnStarTrail(i, i, i + 10, i + 10);
    bolts.spawnStarTrail(99, 99, 109, 109); // 33rd → stomps an already-alive slot
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(count(ctx, 'stroke')).toBe(64);
  });
});

describe('clear', () => {
  it('drops every bolt so nothing draws afterward', () => {
    bolts.spawnLightning(0, 0, 10, 10);
    bolts.spawnStarTrail(0, 0, 10, 10);
    bolts.clear();
    const ctx = makeStubCtx();
    bolts.draw(ctx);
    expect(ctx.__calls).toEqual([]);
  });
});
