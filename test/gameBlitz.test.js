import { describe, it, expect, beforeEach, vi } from 'vitest';

// gameBlitz imports ../main.js (setScene, clockMs). Mock it so importing the
// scene under jsdom doesn't boot the whole game, and so we can assert scene
// transitions. clockMs reads a mutable clock so the speed-streak tests can
// advance time between committed moves.
const clock = vi.hoisted(() => ({ now: 0 }));
vi.mock('../src/main.js', () => ({ clockMs: () => clock.now, setScene: vi.fn() }));

import * as blitz from '../src/scenes/gameBlitz.js';
import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as drag from '../src/dragInput.js';
import * as debugHud from '../src/debugHud.js';
import * as sound from '../src/sound.js';
import * as i18n from '../src/i18n.js';
import { setScene } from '../src/main.js';
import { STATE } from '../src/cascade.js';
import { newCell } from '../src/grid.js';
import { mulberry32 } from '../src/rng.js';
import {
  SPECIAL, BLITZ_DURATION_MS,
  BLITZ_STREAK_WINDOW_MS, BLITZ_STREAK_MAX, BLITZ_STREAK_BONUS,
} from '../src/config.js';
import { installCanvas, setViewport } from './helpers.js';

// ---- helpers ----------------------------------------------------------------

// enter() builds the grid + cascade internally and registers the cascade with
// the debug HUD — spy on that to grab the live cascade (and its grid).
function enterBlitz() {
  const spy = vi.spyOn(debugHud, 'setActiveCascade');
  blitz.enter();
  const cascade = spy.mock.calls[0][0];
  spy.mockRestore();
  return { cascade, grid: cascade.grid };
}

// Advance scene frames until the cascade rests (entry animation, then any wave).
function drain(cascade, cap = 4000) {
  let n = 0;
  while (cascade.state !== STATE.IDLE && n < cap) { blitz.update(64); n++; }
  return n;
}

function cellCenter(r, c) {
  const L = render.layout;
  return { x: L.boardX + c * L.cellSize + L.cellSize / 2, y: L.boardY + r * L.cellSize + L.cellSize / 2 };
}

// Repaint the board to a clean checkerboard plus a ready 4-in-a-row: swapping
// (0,2)<->(1,2) makes row 0 cols 0..3 all type 0 → a horizontal line gem spawn.
function plantMatch(grid) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) grid[r][c] = newCell((r + c) % 2 ? 2 : 3);
  grid[0][0] = newCell(0); grid[0][1] = newCell(0); grid[0][2] = newCell(1); grid[0][3] = newCell(0);
  grid[1][2] = newCell(0);
}

function swap(a, b) {
  const ca = cellCenter(a.r, a.c), cb = cellCenter(b.r, b.c);
  blitz.onPointer({ type: 'down', x: ca.x, y: ca.y });
  blitz.onMove(cb.x, cb.y);
  blitz.onPointer({ type: 'up', x: cb.x, y: cb.y });
}

// Draw once and read back the "seconds remaining" HUD label call ([text, opts]).
function readSecondsLabel() {
  const spy = vi.spyOn(render, 'drawText');
  blitz.draw();
  const call = spy.mock.calls.find(c => c[3] && c[3].align === 'right');
  spy.mockRestore();
  return call ? { text: call[0], color: call[3].color } : null;
}
const drawAndReadSecondsColor = () => readSecondsLabel()?.color ?? null;

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
  clock.now = 0;
  // Seed Math.random (blitz's cascade rng) so the board + spawns are deterministic.
  const rnd = mulberry32(0xC0FFEE);
  vi.spyOn(Math, 'random').mockImplementation(() => rnd());
});

// ---- enter() callbacks (kept FIRST so lastClearCenter is still null) ---------

describe('enter() wires the cascade callbacks', () => {
  it('routes match / score / special callbacks to FX + achievements', () => {
    const { cascade } = enterBlitz();

    // onScoreChanged with a positive delta but no clear centre yet → no floater
    // (covers the `&& lastClearCenter` false path while delta > 0).
    expect(() => cascade.onScoreChanged(50, 50)).not.toThrow();
    // delta <= 0 → first operand false.
    expect(() => cascade.onScoreChanged(50, 0)).not.toThrow();

    // A real match clear sets lastClearCenter and bumps the achievement counter.
    cascade.onMatchCleared([
      { r: 1, c: 1, type: 0, special: null },
      { r: 1, c: 2, type: 0, special: null },
    ], 3);
    const counters = storage.load().achievements.counters;
    expect(counters.totalMatches).toBeGreaterThanOrEqual(2);

    // Now delta > 0 AND lastClearCenter set → score floater path runs.
    expect(() => cascade.onScoreChanged(120, 120)).not.toThrow();

    // Special activation + spawn callbacks.
    expect(() => cascade.onSpecialActivated({ r: 0, c: 0, special: SPECIAL.LINE_H, targets: [{ r: 0, c: 1 }] })).not.toThrow();
    cascade.onSpecialSpawned(SPECIAL.COLOR_BOMB);
    expect(storage.load().achievements.unlocked.special_color).toBeTruthy();
  });
});

// ---- enter / exit -----------------------------------------------------------

describe('enter / exit', () => {
  it('records last-played mode, starts the entry animation, and zeroes the panel', () => {
    const { cascade } = enterBlitz();
    expect(storage.getProfile().lastPlayedMode).toBe('blitz');
    expect(cascade.state).toBe(STATE.FALLING);     // entry animation in flight
    expect(render.layout.panelW).toBe(0);
    drain(cascade);
    expect(cascade.state).toBe(STATE.IDLE);
  });

  it('exit unbinds and clears the body class', () => {
    enterBlitz();
    document.body.className = 'blitz';
    blitz.exit();
    expect(document.body.className).toBe('');
  });
});

// ---- the timer --------------------------------------------------------------

describe('countdown timer', () => {
  it('does not drain while the cascade is busy, then ticks down once idle', () => {
    const { cascade } = enterBlitz();
    // A small frame keeps the entry animation in flight → timer frozen.
    blitz.update(100);
    expect(cascade.state).not.toBe(STATE.IDLE);
    const duringEntry = readSecondsLabel().text;   // full clock, ~60s
    drain(cascade);
    blitz.update(40000);                            // idle frames now drain time
    expect(readSecondsLabel().text).not.toBe(duringEntry);
  });

  it('paints the HUD timer green > 20s, amber 10-20s, red < 10s', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    // > 20s: seconds label in the calm colour.
    expect(drawAndReadSecondsColor()).toBe('rgba(255,255,255,0.85)');
    blitz.update(45000);     // ~15s left → amber bar, calm seconds colour
    expect(drawAndReadSecondsColor()).toBe('rgba(255,255,255,0.85)');
    blitz.update(10000);     // ~5s left → red bar + urgent seconds colour
    expect(drawAndReadSecondsColor()).toBe('#ff8888');
  });

  it('draws the compact back button on a narrow viewport', () => {
    setViewport(420, 760, 1);
    render.setupCanvas();
    const { cascade } = enterBlitz();
    drain(cascade);
    expect(render.layout.isNarrow).toBe(true);
    expect(() => blitz.draw()).not.toThrow();
  });
});

// ---- pointer input ----------------------------------------------------------

describe('pointer input', () => {
  it('a valid drag-swap scores points', () => {
    const { cascade, grid } = enterBlitz();
    drain(cascade);
    plantMatch(grid);
    blitz.draw();                       // populate buttons[]
    swap({ r: 0, c: 2 }, { r: 1, c: 2 });
    blitz.update(200);                  // finish the swap → resolve
    drain(cascade);
    expect(cascade.score).toBeGreaterThan(0);
  });

  it('tapping Back returns to the title', () => {
    enterBlitz();
    blitz.draw();
    const L = render.layout;
    const btnW = L.isNarrow ? 56 : 76;
    const x = render.boardRight() - btnW + btnW / 2;
    const y = L.hudY + 2 + 18;
    blitz.onPointer({ type: 'down', x, y });
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('onMove updates the cursor without an active drag', () => {
    enterBlitz();
    expect(() => blitz.onMove(100, 100)).not.toThrow();
  });
});

// ---- game over --------------------------------------------------------------

describe('game over', () => {
  it('finalises with a new best when the score beats the prior best', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    cascade.score = 1234;
    blitz.update(BLITZ_DURATION_MS);    // idle frame drains the whole clock → finalize
    expect(setScene).toHaveBeenCalledWith('result', expect.objectContaining({
      mode: 'blitz', outcome: 'done', score: 1234, isNewBest: true, prevBest: 0,
    }));
    expect(storage.load().blitz.bestScore).toBe(1234);
    expect(storage.load().blitz.totalRunsPlayed).toBe(1);
    expect(storage.load().achievements.unlocked.first_blitz).toBeTruthy();
  });

  it('keeps the existing best when the run falls short', () => {
    storage.saveKey('blitz', { bestScore: 5000 });
    const { cascade } = enterBlitz();
    drain(cascade);
    cascade.score = 100;
    blitz.update(BLITZ_DURATION_MS);
    expect(setScene).toHaveBeenCalledWith('result', expect.objectContaining({
      isNewBest: false, prevBest: 5000, score: 100,
    }));
    expect(storage.load().blitz.bestScore).toBe(5000);
  });

  it('finalises exactly once and ignores input after the run ends', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    blitz.update(BLITZ_DURATION_MS);    // finalize
    blitz.update(1000);                 // resultTriggered → no second finalize
    expect(setScene).toHaveBeenCalledTimes(1);

    const handleSpy = vi.spyOn(drag, 'handle');
    blitz.draw();
    const cc = cellCenter(4, 4);
    blitz.onPointer({ type: 'down', x: cc.x, y: cc.y });   // not a button
    expect(handleSpy).not.toHaveBeenCalled();              // input suppressed
  });
});

// ---- TIME_PLUS clock gems -----------------------------------------------------

describe('TIME_PLUS clock gems', () => {
  it('each cleared TIME_PLUS adds +2s to the clock, capped at the full duration', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    blitz.update(5000);                                  // burn ~5s so there is headroom
    const secsBefore = parseInt(readSecondsLabel().text, 10);
    cascade.onMatchCleared([
      { r: 1, c: 1, type: 0, special: SPECIAL.TIME_PLUS },
      { r: 1, c: 2, type: 0, special: null },            // plain gem grants nothing
    ], 1);
    expect(readSecondsLabel().text).toBe(i18n.t('blitz.seconds', { n: secsBefore + 2 }));
    // A pile of time gems cannot push the clock past BLITZ_DURATION_MS.
    cascade.onMatchCleared([
      { r: 2, c: 1, type: 0, special: SPECIAL.TIME_PLUS },
      { r: 2, c: 2, type: 0, special: SPECIAL.TIME_PLUS },
      { r: 2, c: 3, type: 0, special: SPECIAL.TIME_PLUS },
      { r: 2, c: 4, type: 0, special: SPECIAL.TIME_PLUS },
      { r: 2, c: 5, type: 0, special: SPECIAL.TIME_PLUS },
    ], 1);
    expect(readSecondsLabel().text).toBe(i18n.t('blitz.seconds', { n: BLITZ_DURATION_MS / 1000 }));
  });

  it('after the run ends, TIME_PLUS clears no longer move the clock', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    blitz.update(BLITZ_DURATION_MS);                     // finalize
    expect(setScene).toHaveBeenCalledTimes(1);
    cascade.onMatchCleared([{ r: 1, c: 1, type: 0, special: SPECIAL.TIME_PLUS }], 1);
    expect(readSecondsLabel().text).toBe(i18n.t('blitz.seconds', { n: 0 }));
  });
});

// ---- speed streak -------------------------------------------------------------

describe('speed streak', () => {
  it('two quick committed moves pay the streak bonus; a slow third resets it', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    const base = cascade.score;
    clock.now = 1000;
    cascade.onMoveCommitted();                       // first move: streak 1, no bonus
    expect(cascade.score).toBe(base);
    clock.now = 1000 + BLITZ_STREAK_WINDOW_MS;       // inside the window (inclusive edge)
    cascade.onMoveCommitted();                       // streak 2 -> +BLITZ_STREAK_BONUS
    expect(cascade.score).toBe(base + BLITZ_STREAK_BONUS);
    clock.now += BLITZ_STREAK_WINDOW_MS + 1;         // outside the window
    cascade.onMoveCommitted();                       // reset to streak 1 -> no bonus
    expect(cascade.score).toBe(base + BLITZ_STREAK_BONUS);
    clock.now += 100;                                // chain again quickly
    cascade.onMoveCommitted();                       // streak 2 again
    expect(cascade.score).toBe(base + 2 * BLITZ_STREAK_BONUS);
  });

  it('the streak level (and its per-move payout) caps at BLITZ_STREAK_MAX', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    let expected = cascade.score;
    clock.now = 1000;
    cascade.onMoveCommitted();                       // streak 1
    for (let i = 2; i <= BLITZ_STREAK_MAX + 2; i++) {
      clock.now += 100;
      cascade.onMoveCommitted();                     // streak = min(MAX, i)
      expected += (Math.min(BLITZ_STREAK_MAX, i) - 1) * BLITZ_STREAK_BONUS;
    }
    expect(cascade.score).toBe(expected);
  });
});

// ---- countdown tick (final 10 seconds) ------------------------------------------

describe('countdown tick', () => {
  it('plays one tick per second under 10s and none for a same-second frame', () => {
    const tick = vi.spyOn(sound, 'blitzTick');
    const { cascade } = enterBlitz();
    drain(cascade);
    blitz.update(51000);                             // ~8.9s left -> first tick
    expect(tick).toHaveBeenCalledTimes(1);
    blitz.update(1000);                              // next second boundary -> second tick
    expect(tick).toHaveBeenCalledTimes(2);
    blitz.update(100);                               // same displayed second -> no extra tick
    expect(tick).toHaveBeenCalledTimes(2);
    expect(setScene).not.toHaveBeenCalled();         // clock still running
    expect(() => blitz.draw()).not.toThrow();
  });
});

// ---- misc callbacks + hint button ---------------------------------------------

describe('bomb defusal + hint button', () => {
  it('onBombsDefused feeds the achievement counter', () => {
    const { cascade } = enterBlitz();
    cascade.onBombsDefused(2);
    expect(storage.load().achievements.counters.bombsDefused).toBe(2);
  });

  it('clicking the hint button feeds a hint into the next draw', () => {
    const { cascade } = enterBlitz();
    drain(cascade);
    const btn = vi.spyOn(render, 'drawHitButton');
    blitz.draw();
    const hintBtn = btn.mock.calls.find(call => call[4] === '💡');
    hintBtn[5]();                                    // ready + idle -> findModestHint
    const board = vi.spyOn(render, 'drawBoard');
    blitz.draw();
    expect(board.mock.calls[0][1].hint).toBeTruthy();
  });
});
