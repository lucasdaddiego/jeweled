import { describe, it, expect, beforeEach } from 'vitest';
import { makeStubCtx } from './helpers.js';
import { spawn, update, draw, clear } from '../src/waves.js';

// waves.js is a module-level pool singleton (24 pooled Wave objects + an
// aliveCount). clear() resets every slot to dead, so we run it before each
// test instead of resetModules — cheaper and the pool identity is irrelevant.
beforeEach(() => clear());

function arcCalls(ctx) {
  return ctx.__calls.filter((c) => c[0] === 'arc');
}

describe('update / draw before anything spawns', () => {
  it('are no-ops when nothing is alive (early return, no draw)', () => {
    const ctx = makeStubCtx();
    update(16);                 // aliveCount === 0 → returns immediately
    draw(ctx);                  // aliveCount === 0 → returns before ctx.save()
    expect(ctx.__calls).toHaveLength(0);
  });
});

describe('spawn + draw', () => {
  it('activates a pooled wave and strokes one expanding ring', () => {
    spawn(40, 50);              // default color/endR/duration
    update(16);
    const ctx = makeStubCtx();
    draw(ctx);
    const names = ctx.__calls.map((c) => c[0]);
    expect(names).toContain('save');
    expect(names).toContain('beginPath');
    expect(names).toContain('stroke');
    expect(names).toContain('restore');
    const arcs = arcCalls(ctx);
    expect(arcs).toHaveLength(1);
    const [x, y, r] = arcs[0][1];
    expect(x).toBe(40);
    expect(y).toBe(50);
    // radius starts at 8 and eases toward endR (80); after 16ms it has barely moved.
    expect(r).toBeGreaterThanOrEqual(8);
    expect(r).toBeLessThan(80);
    // fresh wave (k≈0.04) → alpha ≈ 0.55
    expect(ctx.globalAlpha).toBeGreaterThan(0.5);
    expect(ctx.globalAlpha).toBeLessThanOrEqual(0.55);
  });

  it('honours explicit color / endR / duration arguments', () => {
    spawn(5, 6, '#ff0000', 120, 500);
    update(16);
    const ctx = makeStubCtx();
    draw(ctx);
    expect(ctx.strokeStyle).toBe('#ff0000');   // w.color flows to ctx.strokeStyle
    const [, , r] = arcCalls(ctx)[0][1];
    expect(r).toBeGreaterThanOrEqual(8);
    expect(r).toBeLessThanOrEqual(120);
  });
});

describe('lifecycle', () => {
  it('skips near-expiry waves whose alpha has faded below the floor', () => {
    spawn(10, 10, '#fff', 80, 1000);   // long-lived → stays bright
    spawn(20, 20, '#fff', 80, 100);    // short-lived → nearly faded after 98ms
    update(98);                         // both advance by 98ms, neither expired yet
    const ctx = makeStubCtx();
    draw(ctx);
    const arcs = arcCalls(ctx);
    // Only the bright wave draws; the faded one (alpha ≈ 0.011 < 0.02) is skipped.
    expect(arcs).toHaveLength(1);
    expect(arcs[0][1][0]).toBe(10);
  });

  it('removes a wave once its lifetime elapses', () => {
    spawn(1, 2, '#fff', 80, 100);
    update(150);                        // t (150) >= maxT (100) → wave dies
    const ctx = makeStubCtx();
    draw(ctx);                          // aliveCount back to 0 → early return
    expect(ctx.__calls).toHaveLength(0);
  });
});

describe('pool exhaustion', () => {
  it('drops the spawn when every pooled slot is in use', () => {
    for (let i = 0; i < 24; i++) spawn(i, i, '#fff', 80, 1000); // fill all 24 slots
    spawn(999, 999, '#fff', 80, 1000);  // no free slot → silently dropped
    const ctx = makeStubCtx();
    draw(ctx);
    // Exactly the 24 pooled waves draw; the 25th never took a slot.
    expect(arcCalls(ctx)).toHaveLength(24);
    expect(ctx.__calls.some((c) => c[0] === 'arc' && c[1][0] === 999)).toBe(false);
  });
});

describe('clear', () => {
  it('kills every wave so nothing draws or updates afterward', () => {
    spawn(1, 1);
    spawn(2, 2);
    clear();
    const ctx = makeStubCtx();
    draw(ctx);
    update(16);
    expect(ctx.__calls).toHaveLength(0);
  });
});
