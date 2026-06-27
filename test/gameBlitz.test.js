import { describe, it, expect, beforeEach, vi } from 'vitest';

// gameBlitz imports ../main.js (setScene). Mock it so importing the scene under
// jsdom doesn't boot the whole game, and so we can assert scene transitions.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as blitz from '../src/scenes/gameBlitz.js';
import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as drag from '../src/dragInput.js';
import * as debugHud from '../src/debugHud.js';
import { setScene } from '../src/main.js';
import { STATE } from '../src/cascade.js';
import { newCell } from '../src/grid.js';
import { mulberry32 } from '../src/rng.js';
import { SPECIAL, BLITZ_DURATION_MS } from '../src/config.js';
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
