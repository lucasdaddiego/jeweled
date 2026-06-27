import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// gameDaily -> render/main + scene deps. Mock main so importing never boots the
// real game loop under jsdom.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as debugHud from '../src/debugHud.js';
import { setScene } from '../src/main.js';
import { findModestHint } from '../src/grid.js';
import { STATE } from '../src/cascade.js';
import { SPECIAL, DAILY_MOVES } from '../src/config.js';
import { todayISO } from '../src/rng.js';
import * as daily from '../src/scenes/gameDaily.js';

// --- helpers ---------------------------------------------------------------

function cellXY(r, c) {
  const cs = render.getCellSize();
  return { x: render.layout.boardX + c * cs + cs / 2, y: render.layout.boardY + r * cs + cs / 2 };
}

function runToIdle(scene, c, dt = 1000, cap = 400) {
  let n = 0;
  while (c.state !== STATE.IDLE && n < cap) { scene.update(dt); n++; }
  return n;
}

function dragSwap(scene, a, b) {
  const A = cellXY(a.r, a.c), B = cellXY(b.r, b.c);
  scene.onPointer({ type: 'down', x: A.x, y: A.y });
  scene.onMove(B.x, B.y);
  scene.onPointer({ type: 'up', x: B.x, y: B.y });
}

function spendMoves(c, n) { for (let i = 0; i < n; i++) c.onMoveCommitted(); }

function movesLabel(spy) {
  const call = spy.mock.calls.find(c => typeof c[0] === 'string' && c[0].startsWith('Moves left:'));
  return call ? call[0] : null;
}

async function freshDaily() {
  vi.resetModules();
  const renderM = await import('../src/render.js');
  const storageM = await import('../src/storage.js');
  installCanvas(); setViewport(800, 600, 1);
  renderM.setupCanvas(); renderM.buildAtlas(); storageM.reset();
  const scene = await import('../src/scenes/gameDaily.js');
  const debug = await import('../src/debugHud.js');
  return { scene, render: renderM, storage: storageM, debugHud: debug };
}

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  try { daily.exit(); } catch { /* never entered */ }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('enter()', () => {
  it('seeds a deterministic board, sets the daily background, starts the entry animation', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    expect(c.mode).toBe('daily');
    expect(typeof c.rng).toBe('function');         // seeded rng (not Math.random)
    expect(c.rng).not.toBe(Math.random);
    expect(c.state).toBe(STATE.FALLING);           // playEntryAnimation always runs
    expect(document.body.className).toBe('daily-bg');
    expect(storage.getProfile().lastPlayedMode).toBe('daily');
  });

  it('the same calendar day produces the same seeded board (determinism)', () => {
    daily.enter({});
    const g1 = debugHud.activeCascade().grid.map(row => row.map(x => x && x.type));
    daily.exit();
    daily.enter({});
    const g2 = debugHud.activeCascade().grid.map(row => row.map(x => x && x.type));
    expect(g2).toEqual(g1);
  });

  it('flags a replay when today was already submitted', () => {
    storage.saveKey('daily', { todaySubmittedDate: todayISO(), bestEver: 4242 });
    daily.enter({});
    const spy = vi.spyOn(render, 'drawText');
    daily.draw();
    const hasReplayTag = spy.mock.calls.some(c => c[0] === 'Replay (does not count)');
    expect(hasReplayTag).toBe(true);
  });

  it('exit() resets the body background', () => {
    daily.enter({});
    daily.exit();
    expect(document.body.className).toBe('');
  });
});

describe('cascade callbacks', () => {
  it('onMoveCommitted decrements the move budget', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    spendMoves(c, 1);
    const spy = vi.spyOn(render, 'drawText');
    daily.draw();
    expect(movesLabel(spy)).toBe(`Moves left: ${DAILY_MOVES - 1}`);
  });

  it('onSpecialSpawned unlocks the matching achievement', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    c.onSpecialSpawned(SPECIAL.STAR);
    expect(storage.load().achievements.unlocked.special_star).toBeTruthy();
  });

  it('onSpecialActivated runs the FX handler without throwing', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    expect(() => c.onSpecialActivated({ r: 0, c: 0, special: SPECIAL.LIGHTNING, targets: [{ r: 1, c: 0 }] })).not.toThrow();
  });

  it('onScoreChanged: positive delta with a center spawns a floater; delta<=0 skips it', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    c.onMatchCleared([{ r: 4, c: 4, type: 2, special: null }], 2); // sets lastClearCenter
    expect(() => c.onScoreChanged(150, 150)).not.toThrow();
    expect(() => c.onScoreChanged(150, 0)).not.toThrow();
  });

  it('onScoreChanged with a positive delta but no clear center yet skips the floater', async () => {
    const f = await freshDaily();
    f.scene.enter({});
    const c = f.debugHud.activeCascade();
    expect(() => c.onScoreChanged(100, 100)).not.toThrow();
  });

  it('onIdleReached does nothing while moves remain', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    c.onIdleReached();                              // movesLeft === 30 > 0
    expect(setScene).not.toHaveBeenCalled();
  });
});

describe('swap → match → score (integration via pointer on the seeded board)', () => {
  it('a hinted valid drag scores and spends exactly one move', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    runToIdle(daily, c);                            // drain the entry animation
    daily.draw();
    const hint = findModestHint(c.grid);            // a guaranteed-valid swap
    expect(hint).toBeTruthy();
    dragSwap(daily, hint.a, hint.b);
    expect(c.state).not.toBe(STATE.IDLE);           // a swap is in flight
    runToIdle(daily, c);
    expect(c.score).toBeGreaterThan(0);
    const spy = vi.spyOn(render, 'drawText');
    daily.draw();
    expect(movesLabel(spy)).toBe(`Moves left: ${DAILY_MOVES - 1}`);
  });
});

describe('finalize() on running out of moves', () => {
  it('a first-of-day, new-best run writes progress and reports a new best', () => {
    storage.saveKey('daily', { bestEver: 100 });
    daily.enter({});
    const today = todayISO();
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    c.score = 500;
    spendMoves(c, DAILY_MOVES);                     // movesLeft -> 0
    c.onIdleReached();                              // -> finalize
    const s = storage.load();
    expect(s.daily.bestEver).toBe(500);
    expect(s.daily.totalDaysPlayed).toBe(1);
    expect(s.daily.todaySubmittedDate).toBe(today);
    expect(s.daily.history[today]).toEqual({ score: 500, movesUsed: DAILY_MOVES });
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ mode: 'daily', outcome: 'done', score: 500, date: today, isReplay: false, isNewBest: true, prevBest: 100 }));
  });

  it('a first-of-day run that misses the best still records the day but is not a new best', () => {
    storage.saveKey('daily', { bestEver: 1000 });
    daily.enter({});
    const today = todayISO();
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    c.score = 500;
    spendMoves(c, DAILY_MOVES);
    c.onIdleReached();
    const s = storage.load();
    expect(s.daily.bestEver).toBe(1000);           // Math.max keeps the higher best
    expect(s.daily.totalDaysPlayed).toBe(1);
    expect(s.daily.history[today].score).toBe(500);
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ isReplay: false, isNewBest: false, prevBest: 1000 }));
  });

  it('a replay does NOT raise bestEver, bump totals, or overwrite the day (known-bug guard)', () => {
    const today = todayISO();
    storage.saveKey('daily', {
      todaySubmittedDate: today, bestEver: 5000, totalDaysPlayed: 7,
      history: { [today]: { score: 5000, movesUsed: 12 } },
    });
    daily.enter({});                               // isReplay = true
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    c.score = 99999;                               // a huge replay score...
    spendMoves(c, DAILY_MOVES);
    c.onIdleReached();
    const s = storage.load();
    expect(s.daily.bestEver).toBe(5000);           // ...must NOT raise the best
    expect(s.daily.totalDaysPlayed).toBe(7);       // ...nor bump totals
    expect(s.daily.history[today]).toEqual({ score: 5000, movesUsed: 12 }); // ...nor overwrite
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ isReplay: true, isNewBest: false, prevBest: 5000, score: 99999 }));
  });

  it('does not finalize twice if idle is reached again after the result fired', () => {
    daily.enter({});
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    c.score = 200;
    spendMoves(c, DAILY_MOVES);
    c.onIdleReached();
    expect(setScene).toHaveBeenCalledTimes(1);
    c.onIdleReached();                             // resultTriggered guard
    expect(setScene).toHaveBeenCalledTimes(1);
  });

  it('finalize uses the date the board was SEEDED from, even across midnight (known-bug guard)', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 5, 26, 23, 59, 30)); // 2026-06-26, just before midnight
    storage.saveKey('daily', { bestEver: 0 });
    daily.enter({});                               // captures dailyDate = '2026-06-26'
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    c.score = 333;
    spendMoves(c, DAILY_MOVES);
    vi.setSystemTime(new Date(2026, 5, 27, 0, 0, 30)); // cross into 2026-06-27
    c.onIdleReached();                             // finalize must use the CAPTURED date
    const s = storage.load();
    expect(s.daily.history['2026-06-26']).toEqual({ score: 333, movesUsed: DAILY_MOVES });
    expect(s.daily.history['2026-06-27']).toBeUndefined();
    expect(s.daily.todaySubmittedDate).toBe('2026-06-26');
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ date: '2026-06-26', score: 333 }));
  });
});

describe('draw()', () => {
  it('wide: Back button uses the 76px width and shows todayLabel (not a replay)', () => {
    daily.enter({});
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    const btn = vi.spyOn(render, 'drawHitButton');
    const txt = vi.spyOn(render, 'drawText');
    daily.draw();
    expect(btn.mock.calls[0][2]).toBe(76);
    expect(btn.mock.calls[0][4]).toBe('Back');
    // Not a replay -> the right-aligned label is the formatted date, not the replay tag.
    expect(txt.mock.calls.some(call => call[0] === 'Replay (does not count)')).toBe(false);
  });

  it('narrow: Back uses the short label and 56px width', () => {
    setViewport(420, 760, 1);
    render.setupCanvas(); render.buildAtlas();
    daily.enter({});
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    const btn = vi.spyOn(render, 'drawHitButton');
    daily.draw();
    expect(btn.mock.calls[0][2]).toBe(56);
    expect(btn.mock.calls[0][4]).toBe('←');
  });

  it('moves color: calm (>5), amber (<=5), and warm pulse (<=3)', () => {
    daily.enter({});
    const c = debugHud.activeCascade();
    expect(() => daily.draw()).not.toThrow();      // movesLeft 30 -> else branch
    spendMoves(c, DAILY_MOVES - 5);                // -> 5
    expect(() => daily.draw()).not.toThrow();      // <= 5 branch
    spendMoves(c, 2);                              // -> 3
    expect(() => daily.draw()).not.toThrow();      // <= 3 pulse branch
  });
});

describe('onPointer + onMove', () => {
  it('clicking Back (via a real pointer tap on its hit rect) returns to the title', () => {
    daily.enter({});
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    const btn = vi.spyOn(render, 'drawHitButton');
    daily.draw();
    const back = btn.mock.calls[0];                 // [x, y, w, h, ...]
    daily.onPointer({ type: 'down', x: back[0] + back[2] / 2, y: back[1] + back[3] / 2 });
    expect(setScene).toHaveBeenCalledWith('title'); // onPointer button loop -> onClick -> return
  });

  it('a board tap misses the buttons and reaches the drag handler; non-down events too', () => {
    daily.enter({});
    const c = debugHud.activeCascade(); runToIdle(daily, c);
    daily.draw();
    const board = cellXY(4, 4);
    expect(() => daily.onPointer({ type: 'down', x: board.x, y: board.y })).not.toThrow();
    expect(() => daily.onMove(board.x + 5, board.y)).not.toThrow();
    expect(() => daily.onPointer({ type: 'up', x: board.x + 5, y: board.y })).not.toThrow();
    expect(() => daily.onPointer({ type: 'cancel', x: 1, y: 1 })).not.toThrow();
  });
});
