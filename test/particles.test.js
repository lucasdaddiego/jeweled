import { describe, it, expect, beforeEach, vi } from 'vitest';
import { spawnBurst, update, draw, clear } from '../src/particles.js';
import { PARTICLE_POOL } from '../src/config.js';
import { makeStubCtx } from './helpers.js';

// particles.js owns a fixed module-level pool + aliveCount + a walking cursor.
// clear() resets all of it, so each test starts from an empty pool. Math.random
// is stubbed to 0.5 so spawn geometry is deterministic and assertable.
beforeEach(() => {
  clear();
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

const arcs = (ctx) => ctx.__calls.filter((c) => c[0] === 'arc');
const names = (ctx) => ctx.__calls.map((c) => c[0]);

describe('spawnBurst + draw', () => {
  it('spawns a particle at the given position/color/size and draws it', () => {
    // random=0.5 -> angle=PI (cos=-1, sin~=0), speed/life/size multipliers all = 1.0.
    spawnBurst(100, 200, '#abc', 1, { speed: 1, life: 1000, size: 10 });
    const ctx = makeStubCtx();
    draw(ctx);

    const a = arcs(ctx);
    expect(a).toHaveLength(1);
    expect(a[0][1]).toEqual([100, 200, 10, 0, Math.PI * 2]);
    expect(ctx.fillStyle).toBe('#abc');      // single-color (Array.isArray=false) branch
    expect(ctx.globalAlpha).toBe(1);         // life === maxLife -> alpha 1
    expect(names(ctx)).toEqual(expect.arrayContaining(['save', 'beginPath', 'fill', 'restore']));
  });

  it('uses default count/opts (?? right-hand sides) when omitted', () => {
    spawnBurst(0, 0, '#fff'); // count defaults 12, opts {} -> speed/life/size defaults
    const ctx = makeStubCtx();
    draw(ctx);
    expect(arcs(ctx)).toHaveLength(12);
    // default size 5, random=0.5 -> *1.0 = 5
    expect(arcs(ctx)[0][1][2]).toBe(5);
  });

  it('picks a per-particle shade from a color array (Array.isArray=true branch)', () => {
    spawnBurst(0, 0, ['#a', '#b', '#c'], 1); // index = (0.5 * 3) | 0 = 1 -> '#b'
    const ctx = makeStubCtx();
    draw(ctx);
    expect(ctx.fillStyle).toBe('#b');
  });

  it('stops at the pool ceiling instead of over-spawning (recycle/skip branch)', () => {
    spawnBurst(0, 0, '#fff', PARTICLE_POOL + 50); // findDead() returns null -> break
    const ctx = makeStubCtx();
    draw(ctx);
    expect(arcs(ctx)).toHaveLength(PARTICLE_POOL); // never exceeds the fixed pool
  });
});

describe('update', () => {
  it('is a no-op (and draw early-returns) when nothing is alive', () => {
    update(16); // aliveCount === 0 -> early return
    const ctx = makeStubCtx();
    draw(ctx); // aliveCount === 0 -> early return, not even save()
    expect(ctx.__calls).toHaveLength(0);
  });

  it('integrates gravity + drag into position over a tick', () => {
    spawnBurst(100, 200, '#fff', 1, { speed: 1, life: 1000, size: 5 });
    update(16);
    const ctx = makeStubCtx();
    draw(ctx);
    // dragFactor = 0.998^1; gravStep = 0.0008*16 = 0.0128.
    // vx0=-1 -> -0.998; x = 100 + (-0.998*16) = 84.032
    // vy0=-0.15 -> -0.1372; y = 200 + (-0.1372*16) = 197.8048
    const [x, y] = arcs(ctx)[0][1];
    expect(x).toBeCloseTo(84.032, 3);
    expect(y).toBeCloseTo(197.8048, 3);
    expect(ctx.globalAlpha).toBeCloseTo(984 / 1000, 6); // life decayed by dt
  });

  it('kills a particle once its life runs out', () => {
    spawnBurst(0, 0, '#fff', 1, { life: 100 }); // maxLife = 100 (random=0.5 -> *1.0)
    update(150); // life 100 - 150 <= 0 -> dead, aliveCount-- to 0
    const ctx = makeStubCtx();
    draw(ctx);
    expect(ctx.__calls).toHaveLength(0); // back to aliveCount === 0
  });

  it('keeps a faded particle alive but skips drawing it (alpha < 0.02)', () => {
    spawnBurst(0, 0, '#fff', 1, { life: 1000 }); // maxLife 1000
    update(985); // life = 15 > 0 (alive), alpha = 0.015 < 0.02
    const ctx = makeStubCtx();
    draw(ctx);
    // aliveCount still 1 so draw enters (save/restore) but the arc is skipped.
    expect(names(ctx)).toContain('save');
    expect(names(ctx)).toContain('restore');
    expect(arcs(ctx)).toHaveLength(0);
  });
});

describe('clear', () => {
  it('kills every particle so subsequent draws emit nothing', () => {
    spawnBurst(0, 0, '#fff', 20);
    clear();
    const ctx = makeStubCtx();
    draw(ctx);
    expect(ctx.__calls).toHaveLength(0);
  });
});
