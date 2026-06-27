import { describe, it, expect, vi } from 'vitest';
import { Cascade, STATE } from '../src/cascade.js';
import { makeEmptyGrid, newCell } from '../src/grid.js';
import { Tween } from '../src/animations.js';
import { mulberry32 } from '../src/rng.js';
import {
  GRID, SPECIAL, TIMING, SCORE, COIN_MULTIPLIER,
} from '../src/config.js';

// A checkerboard of two types never contains a 3-in-a-row, so it's a clean
// "no pre-existing match" base. Types 2/3 are used so planted 0/1 gems stand out.
function checker(a = 2, b = 3) {
  const g = makeEmptyGrid();
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) g[r][c] = newCell((r + c) % 2 === 0 ? a : b);
  }
  return g;
}

// Drive the time-based state machine to rest. dt is large so each tween wave
// finishes in a step; cap guards against a runaway cascade never settling.
function runToIdle(c, dt = 1000, cap = 4000) {
  let n = 0;
  while (c.state !== STATE.IDLE && n < cap) { c.update(dt); n++; }
  return n;
}

const key = (r, c) => `${r},${c}`;

describe('constructor', () => {
  it('defaults mode to zen and rng to Math.random', () => {
    const c = new Cascade(checker());
    expect(c.mode).toBe('zen');
    expect(c.rng).toBe(Math.random);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBe(0);
  });

  it('honours provided mode and rng', () => {
    const rng = mulberry32(1);
    const c = new Cascade(checker(), { mode: 'classic', rng });
    expect(c.mode).toBe('classic');
    expect(c.rng).toBe(rng);
  });
});

describe('tryStartSwap — rejections', () => {
  it('rejects when not idle', () => {
    const c = new Cascade(checker());
    c.state = STATE.SWAPPING;
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(false);
  });

  it('rejects non-adjacent cells', () => {
    const c = new Cascade(checker());
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 2, c: 2 })).toBe(false);
  });

  it('rejects when a target cell is empty', () => {
    const g = checker();
    g[0][1] = null;
    const c = new Cascade(g);
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(false);
  });

  it('rejects (and stays idle) a non-matching swap, with nothing to bounce', () => {
    const c = new Cascade(checker());
    // A plain checkerboard swap creates no match → wouldSwapMatch false →
    // bounceBack(a); the cell has no render override so bounceBack no-ops.
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(false);
    expect(c.state).toBe(STATE.IDLE);
  });
});

describe('tryStartSwap — valid swap drives a full cascade', () => {
  it('commits, spawns a line gem from a 4-match, explodes a bomb, settles idle', () => {
    const g = checker(2, 3);
    // 0,0,_,0 in row 0 with a 0 below the gap → swapping the gap up makes 0,0,0,0.
    g[0][0] = newCell(0); g[0][1] = newCell(0); g[0][2] = newCell(1); g[0][3] = newCell(0);
    g[1][2] = newCell(0);
    // A bomb at one tick left, away from the match → detonates on the committed move.
    g[7][7] = newCell(2, SPECIAL.TIME_BOMB, 1);

    const c = new Cascade(g, { rng: mulberry32(42) });
    const cb = {
      onMoveCommitted: vi.fn(),
      onMatchCleared: vi.fn(),
      onScoreChanged: vi.fn(),
      onSpecialSpawned: vi.fn(),
      onBombExploded: vi.fn(),
      onIdleReached: vi.fn(),
    };
    Object.assign(c, cb);

    expect(c.tryStartSwap({ r: 0, c: 2 }, { r: 1, c: 2 })).toBe(true);
    expect(c.state).toBe(STATE.SWAPPING);

    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
    expect(cb.onMoveCommitted).toHaveBeenCalledTimes(1);
    expect(cb.onSpecialSpawned).toHaveBeenCalledWith(SPECIAL.LINE_H);
    expect(cb.onBombExploded).toHaveBeenCalledWith(expect.objectContaining({ r: 7, c: 7 }));
    expect(c.grid[7][7]?.special).not.toBe(SPECIAL.TIME_BOMB);  // bomb gone (cell later refilled)
    expect(c.score).toBeGreaterThanOrEqual(SCORE.PER_GEM_CLEARED * 4 + SCORE.SPECIAL_SPAWN_BONUS);
    expect(cb.onMatchCleared).toHaveBeenCalled();
    expect(cb.onIdleReached).toHaveBeenCalled();
  });
});

describe('color-bomb swaps', () => {
  it('CB swapped onto a plain gem clears that whole colour (cellA branch)', () => {
    const g = checker(2, 3);
    g[0][0] = newCell(3);                         // plain partner (type 3)
    g[0][1] = newCell(5, SPECIAL.COLOR_BOMB);     // CB → after swap CB lands at (0,0) = cellA
    const c = new Cascade(g, { rng: mulberry32(3) });
    const onSpecialActivated = vi.fn();
    c.onSpecialActivated = onSpecialActivated;
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(true);
    runToIdle(c);
    expect(onSpecialActivated).toHaveBeenCalledWith(
      expect.objectContaining({ special: SPECIAL.COLOR_BOMB }),
    );
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBeGreaterThan(0);
  });

  it('CB + CB wipes the board (partnerSpecial branch, no extra chain push)', () => {
    const g = checker(2, 3);
    g[0][0] = newCell(5, SPECIAL.COLOR_BOMB);
    g[0][1] = newCell(4, SPECIAL.COLOR_BOMB);
    const c = new Cascade(g, { rng: mulberry32(5) });
    const onSpecialActivated = vi.fn();
    c.onSpecialActivated = onSpecialActivated;
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(true);
    runToIdle(c);
    expect(onSpecialActivated).toHaveBeenCalled();
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBeGreaterThan(0);
  });

  it('CB + effect special queues the partner effect after the colour clear', () => {
    const g = checker(2, 3);
    g[0][0] = newCell(3, SPECIAL.LINE_H);         // partner effect special
    g[0][1] = newCell(5, SPECIAL.COLOR_BOMB);
    const c = new Cascade(g, { rng: mulberry32(9) });
    const activated = [];
    c.onSpecialActivated = (e) => activated.push(e.special);
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(true);
    runToIdle(c);
    // Both the colour bomb and the queued partner LINE_H fire.
    expect(activated).toContain(SPECIAL.COLOR_BOMB);
    expect(activated).toContain(SPECIAL.LINE_H);
    expect(c.state).toBe(STATE.IDLE);
  });

  it('CB swap that also makes an incidental match resolves the match first (cellB branch)', () => {
    const g = checker(2, 3);
    g[0][0] = newCell(5, SPECIAL.COLOR_BOMB);     // a=(0,0): CB → after swap lands at (0,1)=cellB
    g[0][1] = newCell(0);                          // partner plain type 0
    g[1][0] = newCell(0); g[2][0] = newCell(0);   // swapping partner to (0,0) makes col0 = 0,0,0
    const c = new Cascade(g, { rng: mulberry32(11) });
    const activated = [];
    c.onSpecialActivated = (e) => activated.push(e.special);
    const onMatchCleared = vi.fn();
    c.onMatchCleared = onMatchCleared;
    expect(c.tryStartSwap({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(true);
    runToIdle(c);
    expect(onMatchCleared).toHaveBeenCalled();      // the incidental col-0 match
    expect(activated).toContain(SPECIAL.COLOR_BOMB); // CB still fires from the queue
    expect(c.state).toBe(STATE.IDLE);
  });
});

describe('_afterSwap revert path', () => {
  it('reverts the grid when the committed swap turns out to make no match', () => {
    const g = checker(2, 3);
    const before = g[0][0].id;
    const c = new Cascade(g);
    c.onIdleReached = vi.fn();
    // Drive _afterSwap directly: tryStartSwap pre-validates so this branch is
    // only reachable defensively. A plain checkerboard swap yields no match.
    c._pendingSwap = { a: { r: 0, c: 0 }, b: { r: 0, c: 1 } };
    c.state = STATE.SWAPPING;
    c._afterSwap();
    expect(c.state).toBe(STATE.REVERTING);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.grid[0][0].id).toBe(before);          // swap undone
    expect(c.onIdleReached).toHaveBeenCalled();
  });
});

describe('bounceBack', () => {
  it('no-ops for an out-of-range cell', () => {
    const c = new Cascade(checker());
    c.bounceBack({ r: 99, c: 99 });
    expect(c.state).toBe(STATE.IDLE);
  });

  it('animates a render-displaced cell back and returns to idle', () => {
    const g = checker();
    g[0][0].renderRow = 2;                          // pretend a drag left it displaced
    g[0][0].renderCol = 0;
    const c = new Cascade(g);
    c.onIdleReached = vi.fn();
    c.bounceBack({ r: 0, c: 0 });
    expect(c.state).toBe(STATE.BOUNCING);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.onIdleReached).toHaveBeenCalled();
  });
});

describe('applyExternalClears', () => {
  it('rejects when not idle', () => {
    const c = new Cascade(checker());
    c.state = STATE.FALLING;
    expect(c.applyExternalClears(new Set([key(0, 0)]))).toBe(false);
  });

  it('rejects an empty or null clear set', () => {
    const c = new Cascade(checker());
    expect(c.applyExternalClears(new Set())).toBe(false);
    expect(c.applyExternalClears(null)).toBe(false);
  });

  it('resolves an externally supplied clear set to completion', () => {
    const c = new Cascade(checker(), { rng: mulberry32(2) });
    c.onScoreChanged = vi.fn();
    expect(c.applyExternalClears(new Set([key(3, 3), key(3, 4), key(3, 5)]))).toBe(true);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBeGreaterThan(0);
    expect(c.onScoreChanged).toHaveBeenCalled();
  });
});

describe('resolveCurrentMatches', () => {
  it('rejects when not idle', () => {
    const c = new Cascade(checker());
    c.state = STATE.RESOLVING;
    expect(c.resolveCurrentMatches()).toBe(false);
  });

  it('returns false and signals idle when the board has no matches', () => {
    const c = new Cascade(checker());
    c.onIdleReached = vi.fn();
    expect(c.resolveCurrentMatches()).toBe(false);
    expect(c.onIdleReached).toHaveBeenCalled();
  });

  it('resolves an existing on-board match', () => {
    const g = checker(2, 3);
    g[4][2] = newCell(0); g[4][3] = newCell(0); g[4][4] = newCell(0);  // a planted 3-run
    const c = new Cascade(g, { rng: mulberry32(8) });
    expect(c.resolveCurrentMatches()).toBe(true);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBeGreaterThan(0);
  });
});

describe('_afterSpawn cascade (falling existing gems form a new match)', () => {
  it('increments cascade depth when gravity creates a follow-up match', () => {
    const g = checker(2, 3);
    // col 0 top→bottom: 0,0,1,0,0,(checker…). Clearing the type-1 at (2,0) lets
    // the two 0s above drop, stacking four 0s (rows 1-4) → a depth-2 cascade.
    g[0][0] = newCell(0); g[1][0] = newCell(0); g[2][0] = newCell(1);
    g[3][0] = newCell(0); g[4][0] = newCell(0);
    const c = new Cascade(g, { rng: mulberry32(123) });
    let maxDepth = 0;
    c.onMatchCleared = (_cells, depth) => { maxDepth = Math.max(maxDepth, depth); };
    c.onIdleReached = vi.fn();
    expect(c.applyExternalClears(new Set([key(2, 0)]))).toBe(true);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
    expect(maxDepth).toBeGreaterThanOrEqual(2);     // proves the cascade chained
    expect(c.onIdleReached).toHaveBeenCalled();
  });
});

describe('_beginResolve — special effects, scoring, FX (depth 5)', () => {
  it('applies defuse + coin multiplier, flips gravity, queues chains, triggers shake/slowmo, big-wave colour bomb', () => {
    const g = makeEmptyGrid();
    g[0][0] = newCell(0, SPECIAL.TIME_BOMB, 3);   // defuse bonus
    g[0][1] = newCell(0, SPECIAL.GRAVITY);        // flip gravity next fall
    g[0][2] = newCell(0, SPECIAL.COIN);           // ×5 score
    g[0][3] = newCell(0, SPECIAL.FIRE);           // chains
    g[0][4] = newCell(0); g[0][5] = newCell(0); g[0][6] = newCell(0);
    // (0,7) intentionally left null → exercises the !cell skip in the scans.
    const c = new Cascade(g);
    const onMatchCleared = vi.fn();
    const onScoreChanged = vi.fn();
    c.onMatchCleared = onMatchCleared;
    c.onScoreChanged = onScoreChanged;

    const toSpawn = [];
    c.cascadeDepth = 5;
    const cleared = new Set([0, 1, 2, 3, 4, 5, 6, 7].map((cc) => key(0, cc)));
    c._beginResolve(cleared, toSpawn);

    // gemsScore = round(8 * 10 * mult(5)=3)=240, × coin(5) = 1200; + defuse 500
    expect(c.score).toBe(1700);
    expect(c.gravityFlipNext).toBe(true);
    expect(c.slowmoMsRemaining).toBe(TIMING.SLOWMO_MS);  // depth 5 ≥ SLOWMO_MIN_DEPTH
    expect(c.shakeAmp).toBe(10);                          // min(5*2, 14)
    expect(c.activationQueue).toHaveLength(1);
    expect(c.activationQueue[0].special).toBe(SPECIAL.FIRE);
    expect(toSpawn).toHaveLength(1);
    expect(toSpawn[0].special).toBe(SPECIAL.COLOR_BOMB);  // 8 cells ≥ BIG_WAVE_COLOR_BOMB
    expect(onMatchCleared).toHaveBeenCalledTimes(1);
    expect(onMatchCleared.mock.calls[0][0]).toHaveLength(7);  // null cell skipped
    expect(onMatchCleared.mock.calls[0][1]).toBe(5);
    expect(onScoreChanged).toHaveBeenCalledWith(1700, 1700);
    expect(c.state).toBe(STATE.RESOLVING);
  });

  it('queues a chain activation for every effect-bearing special in the clear', () => {
    const g = makeEmptyGrid();
    const specials = [
      SPECIAL.LINE_H, SPECIAL.LINE_V, SPECIAL.AREA_BOMB, SPECIAL.COLOR_BOMB,
      SPECIAL.FIRE, SPECIAL.LIGHTNING, SPECIAL.STAR,
    ];
    specials.forEach((sp, cc) => { g[0][cc] = newCell(0, sp); });
    const c = new Cascade(g);
    c.cascadeDepth = 1;
    c._beginResolve(new Set(specials.map((_, cc) => key(0, cc))), []);
    expect(c.activationQueue.map((e) => e.special).sort()).toEqual([...specials].sort());
  });

  it('spawns a STAR at the trigger depth and a big-wave AREA_BOMB, skipping occupied cells', () => {
    const g = makeEmptyGrid();
    for (let cc = 0; cc < 6; cc++) g[1][cc] = newCell(0);
    const c = new Cascade(g);
    const toSpawn = [{ r: 1, c: 0, special: SPECIAL.LINE_H, type: 0 }];  // pre-occupies (1,0)
    c.cascadeDepth = 3;                                                   // STAR_CASCADE_TRIGGER
    c._beginResolve(new Set([0, 1, 2, 3, 4, 5].map((cc) => key(1, cc))), toSpawn);
    const specials = toSpawn.map((s) => s.special);
    expect(specials).toContain(SPECIAL.STAR);        // placed at the first free cell (1,1)
    expect(specials).toContain(SPECIAL.AREA_BOMB);   // 6 cells → AREA_BOMB, placed at (1,2)
    expect(toSpawn.find((s) => s.special === SPECIAL.STAR)).toMatchObject({ r: 1, c: 1 });
    expect(toSpawn.find((s) => s.special === SPECIAL.AREA_BOMB)).toMatchObject({ r: 1, c: 2 });
    expect(c.shakeAmp).toBe(6);                       // depth 3 → shake
    expect(c.slowmoMsRemaining).toBe(0);             // depth 3 < SLOWMO_MIN_DEPTH → no slowmo
  });

  it('defaults the spawn type to 0 when the chosen STAR / big-wave cell is empty', () => {
    const g = makeEmptyGrid();
    for (let cc = 2; cc < 6; cc++) g[0][cc] = newCell(0);  // (0,0) and (0,1) stay null
    const c = new Cascade(g);
    c.cascadeDepth = 3;                                    // STAR trigger
    const toSpawn = [];
    c._beginResolve(new Set([0, 1, 2, 3, 4, 5].map((cc) => key(0, cc))), toSpawn);  // size 6
    // STAR lands on the first cleared cell (0,0) — a hole → type falls back to 0.
    expect(toSpawn.find((s) => s.special === SPECIAL.STAR)).toMatchObject({ r: 0, c: 0, type: 0 });
    // Big-wave AREA_BOMB then lands on the next free cell (0,1) — also a hole → 0.
    expect(toSpawn.find((s) => s.special === SPECIAL.AREA_BOMB)).toMatchObject({ r: 0, c: 1, type: 0 });
  });
});

describe('_afterResolve — spawning a special into a vacated cell', () => {
  it('creates a fresh cell when the protected target was nulled (else branch)', () => {
    const c = new Cascade(makeEmptyGrid());
    const onSpecialSpawned = vi.fn();
    c.onSpecialSpawned = onSpecialSpawned;
    c.clearingCells = new Set();
    c.activationQueue = [];
    c.activationQueueIndex = 0;
    // Protected target (7,0) is null in the grid → _afterResolve must newCell() it.
    c._pendingSpawns = [{ r: 7, c: 0, special: SPECIAL.LINE_H, type: 3 }];
    c._afterResolve();
    expect(c.grid[7][0]).toBeTruthy();
    expect(c.grid[7][0].special).toBe(SPECIAL.LINE_H);
    expect(c.grid[7][0].type).toBe(3);
    expect(onSpecialSpawned).toHaveBeenCalledWith(SPECIAL.LINE_H);
  });
});

describe('_afterActivations', () => {
  it('skips a no-op activation then settles when nothing falls', () => {
    const c = new Cascade(checker(2, 3));            // full board, no holes, no matches
    const onSpecialActivated = vi.fn();
    c.onSpecialActivated = onSpecialActivated;
    // A non-effect special clears nothing (switch default) → the activation loop
    // skips it, the full board needs no fall/spawn, and the machine returns idle.
    c.activationQueue = [{ r: 0, c: 0, special: SPECIAL.NONE, type: 0 }];
    c.activationQueueIndex = 0;
    c.state = STATE.ACTIVATING_SPECIALS;
    c._afterActivations();
    expect(onSpecialActivated).not.toHaveBeenCalled();
    expect(c.state).toBe(STATE.IDLE);                 // no fall, no spawn, no match → idle
  });

  it('dispatches a pending activation through the update() switch', () => {
    const c = new Cascade(checker(2, 3));            // full board, settles after the no-op
    c.activationQueue = [{ r: 0, c: 0, special: SPECIAL.NONE, type: 0 }];
    c.activationQueueIndex = 0;
    c.state = STATE.ACTIVATING_SPECIALS;
    c.update(16);                                     // switch → _afterActivations
    expect(c.state).toBe(STATE.IDLE);
  });

  it('processes a queued line gem: clears the lane, credits a bomb, chains, scores', () => {
    const g = checker(2, 3);
    g[0][3] = newCell(0, SPECIAL.TIME_BOMB, 5);       // a bomb in the lane → defuse credit
    g[0][5] = newCell(0, SPECIAL.FIRE);               // a special in the lane → chains
    const c = new Cascade(g, { rng: mulberry32(4) });
    const onSpecialActivated = vi.fn();
    const onMatchCleared = vi.fn();
    c.onSpecialActivated = onSpecialActivated;
    c.onMatchCleared = onMatchCleared;
    c.cascadeDepth = 0;                                // exercises Math.max(depth, 1)
    c.activationQueue = [{ r: 0, c: 0, special: SPECIAL.LINE_H, type: 0 }];
    c.activationQueueIndex = 0;
    c.state = STATE.ACTIVATING_SPECIALS;
    c._afterActivations();
    expect(onSpecialActivated).toHaveBeenCalledWith(
      expect.objectContaining({ special: SPECIAL.LINE_H }),
    );
    // 8 cells cleared, depth lifted to 1: 8*10*1 + defuse 500
    expect(c.score).toBe(SCORE.PER_GEM_CLEARED * 8 + SCORE.BOMB_DEFUSE_BONUS);
    expect(onMatchCleared).toHaveBeenCalled();
    expect(c.state).toBe(STATE.RESOLVING);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
  });
});

describe('_creditBombDefuses', () => {
  it('credits live time-bombs and ignores empty / non-bomb cells', () => {
    const g = makeEmptyGrid();
    g[1][1] = newCell(0, SPECIAL.TIME_BOMB, 4);
    g[2][2] = newCell(0);                              // plain → no credit
    const c = new Cascade(g);
    const bonus = c._creditBombDefuses(new Set([key(0, 0), key(1, 1), key(2, 2)]));
    expect(bonus).toBe(SCORE.BOMB_DEFUSE_BONUS);       // only the one bomb; (0,0) is null
  });
});

describe('no-callback flows (optional-call skip branches)', () => {
  it('runs a special-spawning, chaining resolve with no callbacks attached', () => {
    const g = checker(2, 3);
    g[3][3] = newCell(0, SPECIAL.FIRE);               // a special in the clear → chains
    const c = new Cascade(g, { rng: mulberry32(6) }); // no callbacks set at all
    // 6 cells → big-wave spawn (exercises the onSpecialSpawned-absent branch).
    const cleared = new Set([key(0, 0), key(0, 1), key(0, 2), key(0, 3), key(0, 4), key(3, 3)]);
    expect(c.applyExternalClears(cleared)).toBe(true);
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
  });
});

describe('playEntryAnimation', () => {
  it('drops every cell in and eventually reaches idle', () => {
    const g = checker(2, 3);
    g[4][4] = null;                                   // a hole → covers the !cell skip
    const c = new Cascade(g, { rng: mulberry32(7) });
    c.playEntryAnimation();
    expect(c.state).toBe(STATE.FALLING);
    expect(c.anims.size).toBe(GRID * GRID - 1);       // one tween per non-null cell
    runToIdle(c);
    expect(c.state).toBe(STATE.IDLE);
  });

  it('handles a degenerate grid with no rows (cols fallback)', () => {
    const c = new Cascade([]);                         // grid[0] is undefined → cols = 0
    c.playEntryAnimation();
    expect(c.state).toBe(STATE.FALLING);
    expect(c.anims.size).toBe(0);
  });
});

describe('low-level tween/squash helpers', () => {
  it('_tweenCellFallTo invokes its onDone callback', () => {
    const c = new Cascade(makeEmptyGrid());
    const cell = newCell(0);
    const done = vi.fn();
    c._tweenCellFallTo(cell, { r: 0, c: 0 }, { r: 3, c: 0 }, 100, done);
    c.update(200);
    expect(done).toHaveBeenCalled();
  });

  it('_startSquash skips trivial (<1 cell) falls', () => {
    const c = new Cascade(makeEmptyGrid());
    const cell = newCell(0);
    c._startSquash(cell, 0);
    expect(c._squashed === undefined || !c._squashed.has(cell)).toBe(true);
  });

  it('_tickSquashes scales mid-flight then resets on completion', () => {
    const c = new Cascade(makeEmptyGrid());
    const cell = newCell(0);
    c._startSquash(cell, 2);
    c.update(100);                                     // k < 1 → scaled
    expect(cell.scaleX).toBeGreaterThan(1);
    expect(cell.scaleY).toBeLessThan(1);
    c.update(400);                                     // k ≥ 1 → settled & removed
    expect(cell.scaleX).toBe(1);
    expect(cell.scaleY).toBe(1);
    expect(c._squashed.has(cell)).toBe(false);
  });

  it('_tweenClear fires its onDone callback after the clear tween', () => {
    const c = new Cascade(makeEmptyGrid());
    c.grid[0][0] = newCell(0);
    const cb = vi.fn();
    c._tweenClear(key(0, 0), 100, cb, 0);
    expect(c.grid[0][0].clearAlpha).toBe(1);          // armed for the fade
    c.update(300);                                     // flash (90ms) + clear (100ms) complete
    expect(cb).toHaveBeenCalled();
  });

  it('_startSwapAnim bails out when a cell is missing', () => {
    const c = new Cascade(makeEmptyGrid());           // all cells null
    c._startSwapAnim({ r: 0, c: 0 }, { r: 0, c: 1 });
    expect(c.anims.size).toBe(0);                      // returned before tweening
  });

  it('_beginFall uses upward gravity when a flip is pending', () => {
    const c = new Cascade(makeEmptyGrid());
    c.grid[7][0] = newCell(0);                         // lone gem at the bottom
    c.gravityFlipNext = true;
    c._beginFall();
    expect(c.gravityDir).toBe('up');                  // flip consumed
    expect(c.gravityFlipNext).toBe(false);
    expect(c.state).toBe(STATE.FALLING);              // the gem rises → a move exists
  });

});

describe('update — bookkeeping branches (driven directly while idle)', () => {
  it('rolls the displayed score up toward the real score, then snaps', () => {
    const c = new Cascade(makeEmptyGrid());
    c.score = 1000; c.scoreShown = 0;
    c.update(16);                                      // big diff → incremental step
    expect(c.scoreShown).toBeGreaterThan(0);
    expect(c.scoreShown).toBeLessThan(1000);
    c.score = 5; c.scoreShown = 0;
    c.update(1000);                                    // diff ≤ step → snaps exactly
    expect(c.scoreShown).toBe(5);
  });

  it('rolls the displayed score down for a negative delta', () => {
    const c = new Cascade(makeEmptyGrid());
    c.score = 0; c.scoreShown = 100;
    c.update(16);
    expect(c.scoreShown).toBeLessThan(100);
    expect(c.scoreShown).toBeGreaterThan(0);
  });

  it('decays shake amplitude and clamps small values to zero', () => {
    const c = new Cascade(makeEmptyGrid());
    c.shakeAmp = 14;
    c.update(16);
    expect(c.shakeAmp).toBeGreaterThan(0.5);          // still above the floor
    c.shakeAmp = 0.5;
    c.update(16);
    expect(c.shakeAmp).toBe(0);                        // below floor → snapped to 0
  });

  it('scales dt during slowmo and clamps the remaining time at zero', () => {
    const c = new Cascade(makeEmptyGrid());
    c.slowmoMsRemaining = 100;
    c.update(16);                                      // 100 - 16 = 84 → stays positive
    expect(c.slowmoMsRemaining).toBe(84);
    c.slowmoMsRemaining = 10;
    c.update(16);                                      // 10 - 16 < 0 → clamped
    expect(c.slowmoMsRemaining).toBe(0);
  });

  it('tracks idle time while resting', () => {
    const c = new Cascade(makeEmptyGrid());
    c.update(16);
    expect(c.idleSinceMs).toBe(16);
  });
});

describe('update — terminal switch cases reachable only by direct state set', () => {
  it('BOUNCING falls back to idle when no animation is pending', () => {
    const c = new Cascade(makeEmptyGrid());
    c.onIdleReached = vi.fn();
    c.state = STATE.BOUNCING;
    c.update(16);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.onIdleReached).toHaveBeenCalled();
  });
});
