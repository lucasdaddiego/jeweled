import { describe, it, expect, beforeEach } from 'vitest';

// sceneCommon.js is import-clean (particles/floaters/waves/bolts + cascade STATE
// + config TIMING + grid.findModestHint). No render/main, so no module mocks.
import { tickEffects, clearEffects, tickHint } from '../src/scenes/sceneCommon.js';
import * as particles from '../src/particles.js';
import * as floaters from '../src/floaters.js';
import * as waves from '../src/waves.js';
import * as bolts from '../src/bolts.js';
import { STATE } from '../src/cascade.js';
import { TIMING } from '../src/config.js';
import { createBoard, findModestHint } from '../src/grid.js';
import { mulberry32 } from '../src/rng.js';
import { makeStubCtx } from './helpers.js';

// The four FX pools are module-level singletons shared across this file. Wiping
// them before each test keeps spawns/draws from one case leaking into the next.
beforeEach(() => clearEffects());

// Draw all four pools onto one recording ctx and report how many ops they emit.
// Each pool's draw() early-returns (zero ops) when its aliveCount is 0, so a
// non-zero count means "something is alive" and 0 means "all pools are empty".
function fxOps() {
  const ctx = makeStubCtx();
  particles.draw(ctx);
  floaters.draw(ctx);
  waves.draw(ctx);
  bolts.draw(ctx);
  return ctx.__calls.length;
}

function spawnIntoEveryPool() {
  particles.spawnBurst(10, 10, '#f00', 6);   // life ~700ms
  floaters.spawnScore(10, 10, 123);          // life 850ms
  waves.spawn(10, 10, '#fff', 80, 420);      // maxT 420ms
  bolts.spawnLightning(0, 0, 30, 30);        // maxT 340ms
}

describe('tickEffects', () => {
  it('advances all four FX pools (a large dt ages every pool to death)', () => {
    spawnIntoEveryPool();
    expect(fxOps()).toBeGreaterThan(0);      // everything alive after spawn

    // 5s is past every pool's longest lifetime (floaters 850ms) → all expire,
    // which can only happen if tickEffects forwarded the dt to each pool.update.
    tickEffects(5000);
    expect(fxOps()).toBe(0);
  });

  it('a small dt ages but does not kill (update ran, lifetimes remain)', () => {
    spawnIntoEveryPool();
    tickEffects(50);                          // well under any pool lifetime
    expect(fxOps()).toBeGreaterThan(0);
  });
});

describe('clearEffects', () => {
  it('empties every FX pool', () => {
    spawnIntoEveryPool();
    expect(fxOps()).toBeGreaterThan(0);
    clearEffects();
    expect(fxOps()).toBe(0);
  });
});

describe('tickHint', () => {
  const grid = createBoard(mulberry32(1));   // guaranteed to have a valid move

  it('computes a fresh hint when idle long enough and none is shown', () => {
    const cascade = { state: STATE.IDLE, idleSinceMs: TIMING.HINT_AFTER + 1 };
    const result = tickHint(cascade, grid, null);
    // Falls through to findModestHint(grid); a solvable board yields a swap.
    expect(result).toEqual(findModestHint(grid));
    expect(result).toMatchObject({ a: { r: expect.any(Number) }, b: { r: expect.any(Number) } });
  });

  it('keeps the existing hint (does not recompute) while idle long enough', () => {
    const cascade = { state: STATE.IDLE, idleSinceMs: TIMING.HINT_AFTER + 1 };
    const existing = { a: { r: 0, c: 0 }, b: { r: 0, c: 1 } };
    // hint is truthy → returned by identity, the `hint || …` left operand wins.
    expect(tickHint(cascade, grid, existing)).toBe(existing);
  });

  it('clears the hint to null while the cascade is busy (not idle)', () => {
    const cascade = { state: STATE.SWAPPING, idleSinceMs: 999999 };
    const existing = { a: { r: 0, c: 0 }, b: { r: 0, c: 1 } };
    expect(tickHint(cascade, grid, existing)).toBeNull();
  });

  it('holds the existing hint when idle but not yet long enough', () => {
    const existing = { a: { r: 0, c: 0 }, b: { r: 0, c: 1 } };
    // Below threshold → first branch false; state is IDLE → returns hint as-is.
    expect(tickHint({ state: STATE.IDLE, idleSinceMs: TIMING.HINT_AFTER - 1 }, grid, existing)).toBe(existing);
    // Exactly at the threshold is still "not yet" (strict >), same branch.
    expect(tickHint({ state: STATE.IDLE, idleSinceMs: TIMING.HINT_AFTER }, grid, existing)).toBe(existing);
  });
});
