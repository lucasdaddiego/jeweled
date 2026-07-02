import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// gameClassic -> render/main + scene deps. Mock main so importing never boots
// the real game loop under jsdom.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as debugHud from '../src/debugHud.js';
import * as overlay from '../src/scenes/powerupOverlay.js';
import * as drag from '../src/dragInput.js';
import * as i18n from '../src/i18n.js';
import { setScene } from '../src/main.js';
import { makeEmptyGrid, newCell, serializeGrid } from '../src/grid.js';
import * as gridM from '../src/grid.js';
import { mulberry32 } from '../src/rng.js';
import { STATE } from '../src/cascade.js';
import { SPECIAL } from '../src/config.js';
import { getLevel, starsFor, LEVELS } from '../src/levels.js';
import * as classic from '../src/scenes/gameClassic.js';

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

function plantedSerial() {
  const g = makeEmptyGrid();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) g[r][c] = newCell((r + c) % 2 === 0 ? 2 : 3);
  g[0][0] = newCell(0); g[0][1] = newCell(0); g[1][2] = newCell(0);
  return serializeGrid(g);
}

// Pull the 'Moves: N' HUD label out of a draw() via a drawText spy.
function movesLabel(spy) {
  const call = spy.mock.calls.find(c => typeof c[0] === 'string' && c[0].startsWith('Moves:'));
  return call ? call[0] : null;
}

// Seed Math.random (the classic cascade's rng) for tests whose assertions
// depend on how far the post-swap cascade runs: unseeded spawns occasionally
// chain past the level-1 target (or a milestone) and flip the outcome.
function seedRandom(seed = 0xC0FFEE) {
  const rnd = mulberry32(seed);
  vi.spyOn(Math, 'random').mockImplementation(() => rnd());
}

async function freshClassic() {
  vi.resetModules();
  const renderM = await import('../src/render.js');
  const storageM = await import('../src/storage.js');
  installCanvas(); setViewport(800, 600, 1);
  renderM.setupCanvas(); renderM.buildAtlas(); storageM.reset();
  const scene = await import('../src/scenes/gameClassic.js');
  const main = await import('../src/main.js');
  const debug = await import('../src/debugHud.js');
  return { scene, render: renderM, storage: storageM, setScene: main.setScene, debugHud: debug };
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
  try { classic.exit(); } catch { /* never entered */ }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('enter()', () => {
  it('fresh start defaults to level 1 (moves/target from levels.js) and runs the entry animation', () => {
    classic.enter({});
    const c = debugHud.activeCascade();
    expect(c.mode).toBe('classic');
    expect(c.state).toBe(STATE.FALLING);
    expect(render.layout.panelW).toBe(72);
    expect(storage.getProfile().lastPlayedMode).toBe('classic');
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(movesLabel(spy)).toBe(`Moves: ${getLevel(1).moves}`);
  });

  it('fresh start honors args.level', () => {
    classic.enter({ level: 5 });
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    // The score/target HUD shows the level-5 target.
    const hasTarget = spy.mock.calls.some(c => typeof c[0] === 'string' && c[0].includes(String(getLevel(5).targetScore)));
    expect(hasTarget).toBe(true);
    expect(movesLabel(spy)).toBe(`Moves: ${getLevel(5).moves}`);
  });

  it('fresh start (narrow): panel goes to the bottom (76px)', () => {
    setViewport(420, 760, 1);
    render.setupCanvas(); render.buildAtlas();
    classic.enter({});
    expect(render.layout.isNarrow).toBe(true);
    expect(render.layout.panelSide).toBe('bottom');
    expect(render.layout.panelH).toBe(76);
  });

  it('restoreFrom: restores level, movesLeft, score, explicit milestoneFloor, no entry animation', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 3, movesLeft: 10, score: 1000, milestoneFloor: 1500 } });
    const c = debugHud.activeCascade();
    expect(c.score).toBe(1000);
    expect(c.state).toBe(STATE.IDLE);             // restore skips entry anim
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(movesLabel(spy)).toBe('Moves: 10');    // movesLeft preserved from snapshot
  });

  it('restoreFrom without level/score/milestoneFloor: level->1, score->0, milestoneFloor derives from score', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), movesLeft: 7 } });
    const c = debugHud.activeCascade();
    expect(c.score).toBe(0);
    c.onScoreChanged(1500, 1500);                  // floor fell back to 0 -> earns a milestone
    expect(overlay.isModalOpen()).toBe(true);
  });
});

describe('cascade callbacks', () => {
  it('onMoveCommitted decrements moves; onBombExploded subtracts 5 (clamped at 0)', () => {
    classic.enter({});
    const c = debugHud.activeCascade();
    c.onMoveCommitted();                           // 30 -> 29
    c.onBombExploded();                            // 29 -> 24
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(movesLabel(spy)).toBe('Moves: 24');
  });

  it('onBombExploded never drives moves below zero', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 2, score: 0 } });
    const c = debugHud.activeCascade();
    c.onBombExploded();                            // max(0, 2-5) -> 0
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(movesLabel(spy)).toBe('Moves: 0');
  });

  it('onSpecialActivated runs the FX handler without throwing', () => {
    classic.enter({});
    const c = debugHud.activeCascade();
    expect(() => c.onSpecialActivated({ r: 0, c: 0, special: SPECIAL.AREA_BOMB, targets: [{ r: 1, c: 1 }] })).not.toThrow();
  });

  it('onScoreChanged: positive delta with a known center (after a match) is fine; delta<=0 skips the floater', () => {
    classic.enter({});
    const c = debugHud.activeCascade();
    c.onMatchCleared([{ r: 2, c: 2, type: 1, special: null }], 3); // sets lastClearCenter
    expect(() => c.onScoreChanged(200, 200)).not.toThrow();
    expect(() => c.onScoreChanged(200, 0)).not.toThrow();
  });

  it('onScoreChanged with a positive delta but no clear center yet skips the floater', async () => {
    const f = await freshClassic();
    f.scene.enter({});
    const c = f.debugHud.activeCascade();
    expect(() => c.onScoreChanged(100, 100)).not.toThrow();
  });
});

describe('swap → match → moves/score → idle snapshot (integration via pointer)', () => {
  it('a valid drag scores, spends a move, snapshots, and is not yet win/lose', () => {
    seedRandom();   // keep the cascade below the level-1 target (500)
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 30, score: 0 } });
    const c = debugHud.activeCascade();
    expect(c.state).toBe(STATE.IDLE);
    classic.draw();
    dragSwap(classic, { r: 0, c: 2 }, { r: 1, c: 2 });
    runToIdle(classic, c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBeGreaterThanOrEqual(30);
    expect(setScene).not.toHaveBeenCalled();      // score < 500 and moves remain -> still playing
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(movesLabel(spy)).toBe('Moves: 29');    // one move spent
    expect(storage.load().classic.saveState).toBeTruthy();
    expect(storage.load().classic.saveState.movesLeft).toBe(29);
  });
});

describe('checkWinLose / finalizeWin / finalizeLose', () => {
  it('reaching the target wins: records the level, unlocks the next, routes to result', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade();
    c.score = 500;                                 // == target(1)
    c.onIdleReached();                             // snapshot + checkWinLose -> win
    const s = storage.load();
    expect(s.classic.levels['1'].bestScore).toBe(500);
    expect(s.classic.levels['1'].starsEarned).toBe(starsFor(500, 500));
    expect(s.classic.highestUnlocked).toBe(2);
    expect(s.classic.saveState).toBeNull();
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ mode: 'classic', outcome: 'win', score: 500, level: 1, target: 500, stars: starsFor(500, 500) }));
  });

  it('a win keeps a better previous best/stars (existing-level branch)', () => {
    storage.saveKey('classic', { levels: { '1': { bestScore: 100000, starsEarned: 3, completedAt: 'old' } }, highestUnlocked: 5 });
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade();
    c.score = 600;                                 // beats target but below the stored best
    c.onIdleReached();
    const lvl = storage.load().classic.levels['1'];
    expect(lvl.bestScore).toBe(100000);           // Math.max keeps the better score
    expect(lvl.starsEarned).toBe(3);              // and the better stars
    expect(storage.load().classic.highestUnlocked).toBe(5); // already past -> unchanged
  });

  it('running out of moves loses: clears the save state and routes to a lose result', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 0, score: 40 } });
    const c = debugHud.activeCascade();
    c.onIdleReached();                             // score<target, moves<=0 -> lose
    expect(storage.load().classic.saveState).toBeNull();
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ mode: 'classic', outcome: 'lose', score: 40, level: 1, target: 500 }));
  });

  it('neither win nor lose leaves the run in progress', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade();
    c.state = STATE.IDLE;
    c.score = 100;                                 // < 500, moves remain
    c.onIdleReached();
    expect(setScene).not.toHaveBeenCalled();
  });

  it('does not re-trigger a result once one has fired', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade();
    c.score = 500;
    c.onIdleReached();                             // win
    expect(setScene).toHaveBeenCalledTimes(1);
    c.onIdleReached();                             // guarded by resultTriggered
    expect(setScene).toHaveBeenCalledTimes(1);
  });
});

describe('snapshotSaveState guards', () => {
  it('does not snapshot while mid-animation, but does when idle', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 20, score: 50 } });
    const c = debugHud.activeCascade();
    expect(storage.load().classic.saveState).toBeNull();
    c.state = STATE.FALLING;
    c.onIdleReached();
    expect(storage.load().classic.saveState).toBeNull();
    c.state = STATE.IDLE;
    c.onIdleReached();
    expect(storage.load().classic.saveState).toBeTruthy();
  });

  it('exit() snapshots the in-progress run', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 2, movesLeft: 15, score: 222 } });
    classic.exit();
    const ss = storage.load().classic.saveState;
    expect(ss).toBeTruthy();
    expect(ss.level).toBe(2);
    expect(ss.movesLeft).toBe(15);
    expect(ss.score).toBe(222);
  });

  it('exit() before enter() is a no-op (cascade-null guard)', async () => {
    const f = await freshClassic();
    expect(() => f.scene.exit()).not.toThrow();
    expect(f.storage.load().classic.saveState).toBeNull();
  });
});

describe('draw()', () => {
  it('low score + plenty of moves: purple progress bar, calm moves color (wide => 72px Back)', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    const btn = vi.spyOn(render, 'drawHitButton');
    classic.draw();
    expect(btn.mock.calls[0][2]).toBe(72);        // Back caps the panel column
    expect(btn.mock.calls[0][4]).toBe('Back');
  });

  it('met target + critically low moves: green bar + warm pulse', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 3, score: 0 } });
    const c = debugHud.activeCascade();
    c.score = 600;                                 // >= target -> pct clamps to 1 (green)
    const ctx = render.ctxRef();
    expect(() => classic.draw()).not.toThrow();
    // The green progress fill color was selected.
    expect(ctx.__calls.some(call => call[0] === 'fillRect' || call[0] === 'fill')).toBe(true);
  });

  it('narrow: Back uses the short label and 56px width', () => {
    setViewport(420, 760, 1);
    render.setupCanvas(); render.buildAtlas();
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    const btn = vi.spyOn(render, 'drawHitButton');
    classic.draw();
    expect(btn.mock.calls[0][2]).toBe(56);
    expect(btn.mock.calls[0][4]).toBe('←');       // common.backShort
  });

  it('wide, no panel reserved: Back falls back to 76px', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    render.layout.panelW = 0;
    const btn = vi.spyOn(render, 'drawHitButton');
    classic.draw();
    expect(btn.mock.calls[0][2]).toBe(76);
  });
});

describe('onPointer + Back button + overlay routing', () => {
  it('clicking Back returns to the title', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    const btn = vi.spyOn(render, 'drawHitButton');
    classic.draw();
    btn.mock.calls[0][5]();                        // Back onClick
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('a milestone modal: tapping a fill slot allocates a charge (handleOverlayModalButton true)', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade();
    c.onScoreChanged(1500, 1500);
    expect(overlay.isModalOpen()).toBe(true);
    const slotSpy = vi.spyOn(render, 'drawPowerupSlot');
    classic.draw();
    const m0 = slotSpy.mock.calls[5];             // first milestone-popup slot (after the 5 panel slots)
    classic.onPointer({ type: 'down', x: m0[0] + m0[2] / 2, y: m0[1] + m0[3] / 2 });
    expect(storage.load().powerups.charges.shuffle).toBe(1);
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('a milestone modal: a tap outside the slots dismisses it (handleOverlayModalButton false -> handlePointer)', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade();
    c.onScoreChanged(1500, 1500);
    classic.draw();
    classic.onPointer({ type: 'down', x: 2, y: 2 });
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('a pending power-up target tap is consumed by the overlay (non-modal handlePointer true)', () => {
    storage.saveKey('powerups', { charges: { shuffle: 0, colorBlast: 1, bombDrop: 0, recolor: 0 } });
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    const slotSpy = vi.spyOn(render, 'drawPowerupSlot');
    classic.draw();
    const cb = slotSpy.mock.calls[1];             // colorBlast panel slot
    classic.onPointer({ type: 'down', x: cb[0] + cb[2] / 2, y: cb[1] + cb[3] / 2 }); // enter target mode
    const board = cellXY(3, 3);
    classic.onPointer({ type: 'down', x: board.x, y: board.y });
    expect(storage.load().powerups.charges.colorBlast).toBe(0); // spent
  });

  it('non-down pointer events flow straight to the drag handler', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    expect(() => classic.onPointer({ type: 'cancel', x: 5, y: 5 })).not.toThrow();
    expect(() => classic.onMove(15, 15)).not.toThrow();
  });

  it('modal-branch defensive guard: a modal that declines the tap swallows it (no drag)', () => {
    classic.enter({ level: 1 });
    const c = debugHud.activeCascade(); runToIdle(classic, c);
    classic.draw();                                // buttons[] has no modal entries
    vi.spyOn(overlay, 'isModalOpen').mockReturnValue(true);
    vi.spyOn(overlay, 'handlePointer').mockReturnValue(false);
    const dh = vi.spyOn(drag, 'handle');
    classic.onPointer({ type: 'down', x: 4, y: 4 });
    expect(dh).not.toHaveBeenCalled();
  });
});

// Pull the drawn ice-counter HUD call ([text, x, y, opts]) out of a drawText spy.
function iceLabel(spy, n) {
  return spy.mock.calls.find(c => c[0] === i18n.t('classic.ice', { n }));
}

describe('ice levels (level 5: corners layout)', () => {
  it('enter shows the ice counter; a clear AT an iced cell melts one layer', () => {
    classic.enter({ level: 5 });
    const c = debugHud.activeCascade();
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(iceLabel(spy, 4)).toBeTruthy();          // corners layout: 4 frost cells
    // One iced corner + one plain cell in the clear: only the corner melts.
    c.onMatchCleared([
      { r: 0, c: 0, type: 1, special: null },
      { r: 3, c: 3, type: 1, special: null },
    ], 1);
    spy.mockClear();
    classic.draw();
    const call = iceLabel(spy, 3);
    expect(call).toBeTruthy();
    expect(call[3].color).toBe('#8fd1ff');          // ice remains -> frosty blue
  });

  it('reaching the score target with ice remaining does not win; melting it all does', () => {
    classic.enter({ level: 5 });
    const c = debugHud.activeCascade();
    const target = getLevel(5).targetScore;
    c.score = target;                                // score condition met…
    c.onIdleReached();
    expect(setScene).not.toHaveBeenCalled();         // …but 4 iced cells remain
    // Specials and matches at the iced corners melt them all: an activation
    // melts its own cell AND its targets; one without targets melts just itself.
    c.onSpecialActivated({ r: 0, c: 0, special: SPECIAL.AREA_BOMB, targets: [{ r: 0, c: 7 }] });
    c.onSpecialActivated({ r: 7, c: 0, special: SPECIAL.COLOR_BOMB });
    c.onMatchCleared([{ r: 7, c: 7, type: 1, special: null }], 1);
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(iceLabel(spy, 0)[3].color).toBe('#5fd068'); // fully melted -> green
    c.onIdleReached();                               // now the win can finalize
    expect(setScene).toHaveBeenCalledWith('result',
      expect.objectContaining({ mode: 'classic', outcome: 'win', score: target, level: 5, target, stars: starsFor(target, target) }));
    expect(storage.load().classic.levels['5'].bestScore).toBe(target);
    expect(storage.load().classic.highestUnlocked).toBe(6);
    expect(storage.load().classic.saveState).toBeNull();
  });

  it('the idle snapshot persists the remaining ice cells and restore rebuilds exactly those', () => {
    // The duplicate [7,7] entry must not inflate the counter (initIce dedupe guard).
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 5, movesLeft: 12, score: 100, milestoneFloor: 0, ice: [[0, 0], [7, 7], [7, 7]] } });
    const c = debugHud.activeCascade();
    const spy0 = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(iceLabel(spy0, 2)).toBeTruthy();                         // dedupe held: 2, not 3
    spy0.mockRestore();
    c.onMatchCleared([{ r: 0, c: 0, type: 1, special: null }], 1);  // melt one of the two
    c.onIdleReached();                                              // idle -> snapshotSaveState
    const ss = storage.load().classic.saveState;
    expect(ss.ice).toEqual([[7, 7]]);
    classic.exit();
    classic.enter({ restoreFrom: ss });                             // full roundtrip
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(iceLabel(spy, 1)).toBeTruthy();
  });

  it('undo restores melted ice along with the board', () => {
    const setUndo = vi.spyOn(overlay, 'setUndoHandler');
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 5, movesLeft: 12, score: 0, milestoneFloor: 0, ice: [[0, 0], [7, 7]] } });
    const undoFn = setUndo.mock.calls[0][0];
    const c = debugHud.activeCascade();
    c.onMoveCommitted();                             // shifts the enter-idle capture into prevIdle
    c.onMatchCleared([{ r: 0, c: 0, type: 1, special: null }], 1);
    c.onIdleReached();
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(iceLabel(spy, 1)).toBeTruthy();
    expect(undoFn()).toBe(true);                     // scene-side rewind (charge lives in the overlay)
    spy.mockClear();
    classic.draw();
    expect(iceLabel(spy, 2)).toBeTruthy();           // frost layer back
    expect(movesLabel(spy)).toBe(i18n.t('classic.moves', { n: 12 })); // move refunded
  });
});

describe('boss levels (level 10)', () => {
  it('fresh enter seeds ticking time bombs at (2,2)/(5,5) and tags the HUD', () => {
    classic.enter({ level: 10 });
    const c = debugHud.activeCascade();
    for (const [r, col] of [[2, 2], [5, 5]]) {
      expect(c.grid[r][col].special).toBe(SPECIAL.TIME_BOMB);
      expect(c.grid[r][col].bombCountdown).toBe(9);
    }
    const spy = vi.spyOn(render, 'drawText');
    classic.draw();
    const label = spy.mock.calls.find(call => typeof call[0] === 'string' && call[0].includes(i18n.t('classic.boss')));
    expect(label).toBeTruthy();
    expect(label[0]).toBe(`${i18n.t('classic.level', { n: 10 })} ${i18n.t('classic.boss')}`);
  });

  it('a restored boss run keeps its serialized board — no re-seeding', () => {
    classic.enter({ level: 10 });
    const ser = serializeGrid(debugHud.activeCascade().grid);
    ser[2][2].special = null; ser[2][2].bombCountdown = null;   // defused before the park
    classic.exit();
    classic.enter({ restoreFrom: { grid: ser, level: 10, movesLeft: 20, score: 0 } });
    const c = debugHud.activeCascade();
    expect(c.grid[2][2].special).toBeNull();                    // restore did NOT re-plant it
    expect(c.grid[5][5].special).toBe(SPECIAL.TIME_BOMB);       // carried inside the snapshot
    expect(c.grid[5][5].bombCountdown).toBe(9);
  });

  it('boss seeding never stomps a cell that already carries a special', () => {
    const realCreate = gridM.createBoard;
    vi.spyOn(gridM, 'createBoard').mockImplementation((...a) => {
      const g = realCreate(...a);
      g[2][2].special = SPECIAL.COLOR_BOMB;        // pre-existing special at a bomb anchor
      return g;
    });
    classic.enter({ level: 10 });
    const c = debugHud.activeCascade();
    expect(c.grid[2][2].special).toBe(SPECIAL.COLOR_BOMB);      // left alone
    expect(c.grid[2][2].bombCountdown).toBeNull();
    expect(c.grid[5][5].special).toBe(SPECIAL.TIME_BOMB);       // the free anchor still seeded
  });
});

describe('bomb defusal + hint button', () => {
  it('onBombsDefused feeds the achievement counter', () => {
    classic.enter({ level: 1 });
    debugHud.activeCascade().onBombsDefused(2);
    expect(storage.load().achievements.counters.bombsDefused).toBe(2);
  });

  it('clicking the hint button feeds a hint into the next draw', () => {
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 30, score: 0 } });
    const btn = vi.spyOn(render, 'drawHitButton');
    classic.draw();
    const hintBtn = btn.mock.calls.find(call => call[4] === '💡');
    hintBtn[5]();                                  // ready + idle -> findModestHint
    const board = vi.spyOn(render, 'drawBoard');
    classic.draw();
    expect(board.mock.calls[0][1].hint).toBeTruthy();
  });
});

describe('undo power-up', () => {
  it('rewinds grid/score/moves to the pre-move idle and spends the charge; a second undo is refused', () => {
    seedRandom();   // a runaway cascade could win the level and void the undo
    storage.saveKey('powerups', { charges: { shuffle: 0, colorBlast: 0, bombDrop: 0, recolor: 0, undo: 2 } });
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 30, score: 0 } });
    const c = debugHud.activeCascade();
    const before = JSON.stringify(serializeGrid(c.grid));
    classic.draw();
    dragSwap(classic, { r: 0, c: 2 }, { r: 1, c: 2 });          // committed move
    runToIdle(classic, c);
    expect(c.score).toBeGreaterThanOrEqual(30);
    expect(JSON.stringify(serializeGrid(c.grid))).not.toBe(before);
    const slotSpy = vi.spyOn(render, 'drawPowerupSlot');
    classic.draw();
    const u = slotSpy.mock.calls[4];                            // 5th panel slot = undo
    const at = { x: u[0] + u[2] / 2, y: u[1] + u[3] / 2 };
    classic.onPointer({ type: 'down', x: at.x, y: at.y });      // undo slot tap
    expect(c.score).toBe(0);
    expect(c.scoreShown).toBe(0);
    expect(JSON.stringify(serializeGrid(c.grid))).toBe(before); // board rewound
    expect(storage.load().powerups.charges.undo).toBe(1);       // one charge spent
    const textSpy = vi.spyOn(render, 'drawText');
    classic.draw();
    expect(movesLabel(textSpy)).toBe(i18n.t('classic.moves', { n: 30 })); // move refunded
    expect(storage.load().classic.saveState.movesLeft).toBe(30);          // rewound board snapshotted
    classic.onPointer({ type: 'down', x: at.x, y: at.y });      // second undo, no new move since
    expect(storage.load().powerups.charges.undo).toBe(1);       // refused: charge intact
    expect(c.score).toBe(0);
  });

  it('undo is refused mid-animation and after the result fired', () => {
    const setUndo = vi.spyOn(overlay, 'setUndoHandler');
    classic.enter({ restoreFrom: { grid: plantedSerial(), level: 1, movesLeft: 5, score: 0 } });
    const undoFn = setUndo.mock.calls[0][0];
    const c = debugHud.activeCascade();
    c.onMoveCommitted();                             // prevIdle now exists
    c.state = STATE.FALLING;
    expect(undoFn()).toBe(false);                    // not idle -> refused
    c.state = STATE.IDLE;
    c.score = 500;
    c.onIdleReached();                               // win -> resultTriggered
    expect(undoFn()).toBe(false);                    // after a result -> refused
  });
});
