import { describe, it, expect, beforeEach, vi } from 'vitest';

// gamePuzzle imports ../main.js (setScene, clockMs). Mock it so importing the
// scene under jsdom doesn't boot the game, and so transitions are assertable.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as puzzle from '../src/scenes/gamePuzzle.js';
import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as drag from '../src/dragInput.js';
import * as debugHud from '../src/debugHud.js';
import { setScene } from '../src/main.js';
import { STATE } from '../src/cascade.js';
import { newCell, findModestHint } from '../src/grid.js';
import { SPECIAL } from '../src/config.js';
import { getPuzzle } from '../src/puzzles.js';
import { installCanvas, setViewport } from './helpers.js';

// ---- helpers ----------------------------------------------------------------

function enterPuzzle(args) {
  const spy = vi.spyOn(debugHud, 'setActiveCascade');
  puzzle.enter(args);
  const cascade = spy.mock.calls[0][0];
  spy.mockRestore();
  return { cascade, grid: cascade.grid };
}

function drain(cascade, cap = 4000) {
  let n = 0;
  while (cascade.state !== STATE.IDLE && n < cap) { puzzle.update(64); n++; }
  return n;
}

function cellCenter(r, c) {
  const L = render.layout;
  return { x: L.boardX + c * L.cellSize + L.cellSize / 2, y: L.boardY + r * L.cellSize + L.cellSize / 2 };
}

function plantMatch(grid) {
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) grid[r][c] = newCell((r + c) % 2 ? 2 : 3);
  grid[0][0] = newCell(0); grid[0][1] = newCell(0); grid[0][2] = newCell(1); grid[0][3] = newCell(0);
  grid[1][2] = newCell(0);
}

function swap(a, b) {
  const ca = cellCenter(a.r, a.c), cb = cellCenter(b.r, b.c);
  puzzle.onPointer({ type: 'down', x: ca.x, y: ca.y });
  puzzle.onMove(cb.x, cb.y);
  puzzle.onPointer({ type: 'up', x: cb.x, y: cb.y });
}

// Read back the HUD "Moves: N" label.
function readMoves() {
  const spy = vi.spyOn(render, 'drawText');
  puzzle.draw();
  const call = spy.mock.calls.find(c => typeof c[0] === 'string' && c[0].startsWith('Moves'));
  spy.mockRestore();
  return call ? call[0] : null;
}

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
});

// ---- enter() callbacks (FIRST so lastClearCenter starts null) ----------------

describe('enter() wires the cascade callbacks', () => {
  it('routes match / score / special callbacks to progress + achievements', () => {
    const { cascade } = enterPuzzle({ puzzle: 1 });

    // delta > 0 but no clear centre yet → no floater (`&& lastClearCenter` false).
    expect(() => cascade.onScoreChanged(50, 50)).not.toThrow();
    expect(() => cascade.onScoreChanged(50, 0)).not.toThrow();   // delta <= 0

    // A depth-4 clear records colour progress, depth, and unlocks cascade_3.
    cascade.onMatchCleared([{ r: 1, c: 1, type: 0, special: null }], 4);
    expect(storage.load().achievements.unlocked.cascade_3).toBeTruthy();
    // A shallower follow-up clear does NOT lower the recorded max depth
    // (covers the `depth > maxCascadeDepth` false branch).
    cascade.onMatchCleared([{ r: 2, c: 2, type: 1, special: null }], 1);

    // Now delta > 0 AND a clear centre exists → score floater path runs.
    expect(() => cascade.onScoreChanged(120, 120)).not.toThrow();

    expect(() => cascade.onSpecialActivated({ r: 0, c: 0, special: SPECIAL.STAR, targets: [{ r: 1, c: 0 }] })).not.toThrow();
    expect(() => cascade.onSpecialSpawned(SPECIAL.LINE_H)).not.toThrow();
  });

  it('onBombsDefused feeds the defuse counter', () => {
    const { cascade } = enterPuzzle({ puzzle: 1 });
    cascade.onBombsDefused(3);
    expect(storage.load().achievements.counters.bombsDefused).toBe(3);
  });
});

describe('hint button', () => {
  it('tapped while idle, it feeds a hint into the next draw', () => {
    const { cascade, grid } = enterPuzzle({ puzzle: 1 });
    drain(cascade);
    puzzle.draw();                                  // registers the 💡 hit rect
    const L = render.layout;
    const btnW = L.isNarrow ? 56 : 76;
    // Hint button: 36×32 at (boardR - btnW - 42, hudY + 2).
    puzzle.onPointer({ type: 'down', x: render.boardRight() - btnW - 42 + 18, y: L.hudY + 2 + 16 });
    const spy = vi.spyOn(render, 'drawBoard');
    puzzle.draw();
    expect(spy.mock.calls[0][1].hint).toEqual(findModestHint(grid));
  });
});

// ---- enter redirects ---------------------------------------------------------

describe('enter() guards a missing puzzle', () => {
  // The redirect is deferred to a microtask and uses replace so the invalid
  // gamePuzzle history entry (pushed by the outer setScene after enter()
  // returns) is overwritten instead of orphaned on top of the stack.
  it('redirects (deferred, replacing) to the puzzle select when no id is given', async () => {
    puzzle.enter();
    expect(setScene).not.toHaveBeenCalled();          // deferred past enter()
    await Promise.resolve();                          // flush the microtask
    expect(setScene).toHaveBeenCalledWith('puzzleSelect', {}, { replace: true });
  });

  it('redirects when the id matches no puzzle', async () => {
    puzzle.enter({ puzzle: 999 });
    await Promise.resolve();
    expect(setScene).toHaveBeenCalledWith('puzzleSelect', {}, { replace: true });
  });
});

// ---- enter / exit / setup ----------------------------------------------------

describe('enter / exit', () => {
  it('builds a deterministic board, records mode, and starts the entry animation', () => {
    const { cascade } = enterPuzzle({ puzzle: 1 });
    expect(storage.getProfile().lastPlayedMode).toBe('puzzle');
    expect(cascade.state).toBe(STATE.FALLING);
    expect(render.layout.panelW).toBe(0);
    drain(cascade);
    expect(cascade.state).toBe(STATE.IDLE);
  });

  it('exit unbinds and clears the body class', () => {
    enterPuzzle({ puzzle: 1 });
    document.body.className = 'puzzle';
    puzzle.exit();
    expect(document.body.className).toBe('');
  });
});

// ---- hand-laid boards (13+) ----------------------------------------------------

describe('hand-laid boards', () => {
  it('puzzle 13 builds the literal grid from its board digits and is playable', () => {
    const p13 = getPuzzle(13);
    const { cascade, grid } = enterPuzzle({ puzzle: 13 });

    // The grid mirrors the authored digit rows cell-for-cell (spot checks
    // across corners + the mid-board 5s that shape the designed T).
    for (const [r, c] of [[0, 0], [0, 7], [1, 3], [2, 2], [3, 4], [5, 2], [7, 7]]) {
      expect(grid[r][c].type).toBe(Number(p13.board[r][c]));
    }

    // Entry animation settles without clearing anything: an authored board has
    // no pre-existing matches, so every type survives to IDLE intact.
    drain(cascade);
    expect(cascade.state).toBe(STATE.IDLE);
    expect(grid.map(row => row.map(cell => cell.type)))
      .toEqual(p13.board.map(row => [...row].map(Number)));
    expect(cascade.score).toBe(0);

    // Playable: at least one legal move exists, and performing it matches.
    const hint = findModestHint(grid);
    expect(hint).toBeTruthy();
    swap(hint.a, hint.b);
    puzzle.update(200);
    drain(cascade);
    expect(cascade.score).toBeGreaterThan(0);
    expect(readMoves()).toBe(`Moves: ${p13.moves - 1}`);
  });

  it('every authored board (13-15) enters clean: literal grid, no pre-matches, a valid move', () => {
    for (const id of [13, 14, 15]) {
      const p = getPuzzle(id);
      const { cascade, grid } = enterPuzzle({ puzzle: id });
      drain(cascade);
      expect(grid.map(row => row.map(cell => cell.type)),
        `puzzle ${id} board`).toEqual(p.board.map(row => [...row].map(Number)));
      expect(findModestHint(grid), `puzzle ${id} has a move`).toBeTruthy();
      puzzle.exit();
    }
  });
});

// ---- drawing -----------------------------------------------------------------

describe('drawing', () => {
  it('renders the goal/progress/moves HUD on a wide viewport', () => {
    enterPuzzle({ puzzle: 1 });
    expect(readMoves()).toBe('Moves: 10');
  });

  it('uses the urgent pulsing colour when moves run low', () => {
    const { cascade } = enterPuzzle({ puzzle: 1 });
    for (let i = 0; i < 8; i++) cascade.onMoveCommitted();   // 10 → 2
    expect(readMoves()).toBe('Moves: 2');                    // movesLeft <= 2 branch
  });

  it('draws the compact back button on a narrow viewport', () => {
    setViewport(420, 760, 1);
    render.setupCanvas();
    enterPuzzle({ puzzle: 1 });
    expect(render.layout.isNarrow).toBe(true);
    expect(() => puzzle.draw()).not.toThrow();
  });
});

// ---- pointer input -----------------------------------------------------------

describe('pointer input', () => {
  it('a valid drag-swap scores points and consumes a move', () => {
    const { cascade, grid } = enterPuzzle({ puzzle: 11 });   // high goal → no early win
    drain(cascade);
    plantMatch(grid);
    expect(readMoves()).toBe('Moves: 20');
    swap({ r: 0, c: 2 }, { r: 1, c: 2 });
    puzzle.update(200);
    drain(cascade);
    expect(cascade.score).toBeGreaterThan(0);
    expect(readMoves()).toBe('Moves: 19');                   // onMoveCommitted fired
  });

  it('tapping Back returns to the puzzle select', () => {
    enterPuzzle({ puzzle: 1 });
    puzzle.draw();
    const L = render.layout;
    const btnW = L.isNarrow ? 56 : 76;
    const x = render.boardRight() - btnW + btnW / 2;
    const y = L.hudY + 2 + 16;
    puzzle.onPointer({ type: 'down', x, y });
    expect(setScene).toHaveBeenCalledWith('puzzleSelect');
  });

  it('onMove updates the cursor without an active drag', () => {
    enterPuzzle({ puzzle: 1 });
    expect(() => puzzle.onMove(100, 100)).not.toThrow();
  });
});

// ---- win / lose --------------------------------------------------------------

describe('objective completion', () => {
  it('wins when the goal is met → result + first completion record', () => {
    const { cascade } = enterPuzzle({ puzzle: 1 });   // goal: totalScore 200
    drain(cascade);
    cascade.score = 250;
    cascade.onScoreChanged(250, 250);                 // progress.score = 250
    cascade.onIdleReached();                          // checkComplete → win
    expect(setScene).toHaveBeenCalledWith('result', expect.objectContaining({
      mode: 'puzzle', outcome: 'win', score: 250, puzzleNum: 1,
    }));
    expect(storage.load().puzzle.completed['1'].bestScore).toBe(250);
    expect(storage.load().achievements.unlocked.first_puzzle).toBeTruthy();

    // Re-entering checkComplete after the result is a guarded no-op.
    cascade.onIdleReached();
    expect(setScene).toHaveBeenCalledTimes(1);
  });

  it('keeps the higher best score across repeat completions', () => {
    storage.saveKey('puzzle', { completed: { '1': { bestScore: 1000, completedAt: 'x' } } });
    const { cascade } = enterPuzzle({ puzzle: 1 });
    drain(cascade);
    cascade.score = 250;
    cascade.onScoreChanged(250, 250);
    cascade.onIdleReached();
    expect(storage.load().puzzle.completed['1'].bestScore).toBe(1000);   // Math.max keeps prior
  });

  it('loses when moves run out before the goal is met', () => {
    const { cascade } = enterPuzzle({ puzzle: 1 });   // 10 moves, goal 200
    drain(cascade);
    for (let i = 0; i < 10; i++) cascade.onMoveCommitted();   // movesLeft → 0
    cascade.onIdleReached();                                  // checkComplete → lose
    expect(setScene).toHaveBeenCalledWith('result', expect.objectContaining({
      mode: 'puzzle', outcome: 'lose', score: 0, puzzleNum: 1,
    }));
    expect(Object.keys(storage.load().playHistory)).toHaveLength(1);   // recordPlayDay
    expect(storage.load().puzzle.completed['1']).toBeUndefined();      // not completed
  });
});
