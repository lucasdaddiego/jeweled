import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// gameZen -> render/main + many scene deps. Mock main so importing the scene
// never boots the real game loop under jsdom (document.readyState === 'complete').
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as debugHud from '../src/debugHud.js';
import * as overlay from '../src/scenes/powerupOverlay.js';
import * as drag from '../src/dragInput.js';
import { setScene } from '../src/main.js';
import { makeEmptyGrid, newCell, serializeGrid } from '../src/grid.js';
import { STATE } from '../src/cascade.js';
import { SPECIAL } from '../src/config.js';
import * as zen from '../src/scenes/gameZen.js';

// --- helpers ---------------------------------------------------------------

// Pixel center of board cell (r,c) using the live layout.
function cellXY(r, c) {
  const cs = render.getCellSize();
  return { x: render.layout.boardX + c * cs + cs / 2, y: render.layout.boardY + r * cs + cs / 2 };
}

// Tick the SCENE (not just the cascade) until the cascade rests, so scene.update
// + tickEffects + tickHint are exercised too. dt large so each wave settles fast.
function runToIdle(scene, c, dt = 1000, cap = 400) {
  let n = 0;
  while (c.state !== STATE.IDLE && n < cap) { scene.update(dt); n++; }
  return n;
}

// Drive a swap from a->b through the scene's pointer handlers (covers onPointer
// down/up, onMove, drag + screenToCell).
function dragSwap(scene, a, b) {
  const A = cellXY(a.r, a.c), B = cellXY(b.r, b.c);
  scene.onPointer({ type: 'down', x: A.x, y: A.y });
  scene.onMove(B.x, B.y);
  scene.onPointer({ type: 'up', x: B.x, y: B.y });
}

// Serialized board: checker of types 2/3 (no pre-match) with a planted setup so
// swapping (0,2)<->(1,2) forms a row-0 triple of type 0.
function plantedSerial() {
  const g = makeEmptyGrid();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) g[r][c] = newCell((r + c) % 2 === 0 ? 2 : 3);
  g[0][0] = newCell(0); g[0][1] = newCell(0); g[1][2] = newCell(0);
  return serializeGrid(g);
}

async function freshZen() {
  vi.resetModules();
  const renderM = await import('../src/render.js');
  const storageM = await import('../src/storage.js');
  installCanvas(); setViewport(800, 600, 1);
  renderM.setupCanvas(); renderM.buildAtlas(); storageM.reset();
  const scene = await import('../src/scenes/gameZen.js');
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
  // Reset module-level scene + overlay state so a left-open modal / bound drag
  // can't leak into the next case. exit() is safe to call repeatedly.
  try { zen.exit(); } catch { /* never entered */ }
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('enter()', () => {
  it('fresh start (wide): builds a board, plays the entry animation, reserves a 72px panel, sets debug handle', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    expect(c).toBeTruthy();
    expect(c.mode).toBe('zen');
    expect(c.state).toBe(STATE.FALLING);                 // entry animation running
    expect(render.layout.panelSide).toBe('right');
    expect(render.layout.panelW).toBe(72);
    expect(storage.getProfile().lastPlayedMode).toBe('zen');
    expect(window.__zen).toBeTruthy();                   // isDebugHost() true (jsdom localhost)
    expect(window.__zen.cascade).toBe(c);
  });

  it('fresh start (narrow): puts the power-up panel at the bottom (76px)', () => {
    setViewport(400, 720, 1);
    render.setupCanvas(); render.buildAtlas();
    zen.enter({});
    expect(render.layout.isNarrow).toBe(true);
    expect(render.layout.panelSide).toBe('bottom');
    expect(render.layout.panelH).toBe(76);
    expect(render.layout.panelW).toBe(0);
  });

  it('restoreFrom: restores score + explicit milestoneFloor, no entry animation', () => {
    zen.enter({ restoreFrom: { grid: plantedSerial(), score: 1234, milestoneFloor: 1500 } });
    const c = debugHud.activeCascade();
    expect(c.score).toBe(1234);
    expect(c.scoreShown).toBe(1234);
    expect(c.state).toBe(STATE.IDLE);                    // restore path skips entry anim
  });

  it('restoreFrom without score/milestoneFloor: score defaults to 0, milestoneFloor derives from score', () => {
    zen.enter({ restoreFrom: { grid: plantedSerial() } });
    const c = debugHud.activeCascade();
    expect(c.score).toBe(0);
    // milestoneFloor fell back to milestoneFloorForScore(0)=0 -> a score crossing
    // 1500 still earns a milestone.
    c.onScoreChanged(1500, 1500);
    expect(overlay.isModalOpen()).toBe(true);
  });
});

describe('paintingMode true', () => {
  it('initialises + enables the painting overlay', async () => {
    const painting = await import('../src/painting.js');
    storage.saveKey('settings', { paintingMode: true });
    zen.enter({});
    expect(painting.isEnabled()).toBe(true);
  });
});

describe('cascade callbacks', () => {
  it('onSpecialSpawned unlocks the matching achievement', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    c.onSpecialSpawned(SPECIAL.COLOR_BOMB);
    expect(storage.load().achievements.unlocked.special_color).toBeTruthy();
  });

  it('onSpecialActivated runs the FX handler without throwing', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    expect(() => c.onSpecialActivated({ r: 0, c: 0, special: SPECIAL.COLOR_BOMB, targets: [{ r: 0, c: 1 }] })).not.toThrow();
  });

  it('onScoreChanged with a positive delta + a known clear center spawns a score floater', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    // Set lastClearCenter via the match-cleared handler, then a score delta.
    c.onMatchCleared([{ r: 0, c: 0, type: 0, special: null }], 2);
    expect(() => c.onScoreChanged(100, 100)).not.toThrow();
    expect(storage.load().achievements.counters.totalMatches).toBeGreaterThan(0); // notifyMatchCleared ran
  });

  it('onScoreChanged with delta <= 0 skips the floater (still processes milestones)', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    expect(() => c.onScoreChanged(100, 0)).not.toThrow();
  });

  it('onScoreChanged with a positive delta but no clear center yet skips the floater', async () => {
    // Fresh module guarantees lastClearCenter === null (no prior match).
    const f = await freshZen();
    f.scene.enter({});
    const c = f.debugHud.activeCascade();
    expect(() => c.onScoreChanged(100, 100)).not.toThrow();
  });
});

describe('swap → match → cascade → score → idle snapshot (integration via pointer)', () => {
  it('a valid drag scores, then the idle snapshot persists a resumable save state', () => {
    zen.enter({ restoreFrom: { grid: plantedSerial(), score: 0, milestoneFloor: 0 } });
    const c = debugHud.activeCascade();
    expect(c.state).toBe(STATE.IDLE);
    zen.draw();                                   // populate buttons[] (board tap must miss them)
    dragSwap(zen, { r: 0, c: 2 }, { r: 1, c: 2 }); // forms the planted row-0 triple
    expect(c.state).toBe(STATE.SWAPPING);
    runToIdle(zen, c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBeGreaterThanOrEqual(30);   // >= scoreForClear(3,1)
    expect(storage.load().zen.saveState).toBeTruthy(); // onIdleReached -> snapshotSaveState
    expect(storage.load().zen.saveState.score).toBe(c.score);
  });

  it('an invalid drag (no match) just reverts and stays in play', () => {
    zen.enter({ restoreFrom: { grid: plantedSerial(), score: 0, milestoneFloor: 0 } });
    const c = debugHud.activeCascade();
    zen.draw();
    // (0,0) and (0,1) are both type 0; swapping identical gems forms no run.
    dragSwap(zen, { r: 0, c: 0 }, { r: 0, c: 1 });
    runToIdle(zen, c);
    expect(c.state).toBe(STATE.IDLE);
    expect(c.score).toBe(0);
  });
});

describe('update + draw', () => {
  it('draw (wide): End button caps the panel column width (72)', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    const spy = vi.spyOn(render, 'drawHitButton');
    zen.draw();
    const end = spy.mock.calls[0];
    expect(end[4]).toBe('End');
    expect(end[2]).toBe(72);                       // btnW === panelW
  });

  it('draw (narrow): End button uses the 56px fallback width', () => {
    setViewport(400, 720, 1);
    render.setupCanvas(); render.buildAtlas();
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    const spy = vi.spyOn(render, 'drawHitButton');
    zen.draw();
    expect(spy.mock.calls[0][2]).toBe(56);
  });

  it('draw (wide, no panel reserved): End falls back to the 76px width', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    render.layout.panelW = 0;                      // wide viewport but no panel column
    const spy = vi.spyOn(render, 'drawHitButton');
    zen.draw();
    expect(spy.mock.calls[0][2]).toBe(76);
  });
});

describe('End button + finalizeRun', () => {
  it('clicking End (no painting) finalizes a new best and goes to title', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    c.score = 500;
    const spy = vi.spyOn(render, 'drawHitButton');
    zen.draw();
    spy.mock.calls[0][5]();                        // End onClick
    expect(setScene).toHaveBeenCalledWith('title');
    expect(storage.load().zen.bestScore).toBe(500);
    expect(storage.load().zen.totalRunsPlayed).toBe(1);
    expect(storage.load().zen.saveState).toBeNull();
  });

  it('finalizeRun does not lower an existing better best score', () => {
    storage.saveKey('zen', { bestScore: 999999 });
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    c.score = 500;
    zen.exit();                                    // exit finalizes (score>0, runEndedScore null)
    expect(storage.load().zen.bestScore).toBe(999999);
    expect(storage.load().zen.totalRunsPlayed).toBe(1);
  });

  it('exit finalizes once; a prior End click prevents a double count', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    c.score = 300;
    const spy = vi.spyOn(render, 'drawHitButton');
    zen.draw();
    spy.mock.calls[0][5]();                        // End -> finalizeRun (runEndedScore set)
    expect(storage.load().zen.totalRunsPlayed).toBe(1);
    zen.exit();                                    // must NOT finalize again
    expect(storage.load().zen.totalRunsPlayed).toBe(1);
  });

  it('exit with a zero score does not finalize', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    expect(c.score).toBe(0);
    zen.exit();
    expect(storage.load().zen.totalRunsPlayed).toBe(0);
  });
});

describe('offerSavePainting (End with painting enabled)', () => {
  async function clickEndWithPainting() {
    storage.saveKey('settings', { paintingMode: true });
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    c.score = 120;
    const spy = vi.spyOn(render, 'drawHitButton');
    zen.draw();
    return spy.mock.calls[0][5];                   // End onClick (fires offerSavePainting)
  }

  it('confirm + a real blob downloads the painting then navigates to title', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    vi.useFakeTimers();
    const endOnClick = await clickEndWithPainting();
    endOnClick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); // confirm -> true
    await vi.advanceTimersByTimeAsync(1100);       // flush awaits + fire the revoke setTimeout
    expect(createSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();
    expect(revokeSpy).toHaveBeenCalled();
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('confirm but a null blob still navigates to title (no download)', async () => {
    const orig = OffscreenCanvas.prototype.convertToBlob;
    OffscreenCanvas.prototype.convertToBlob = () => Promise.resolve(null);
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    try {
      const endOnClick = await clickEndWithPainting();
      endOnClick();
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
      await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
      expect(createSpy).not.toHaveBeenCalled();    // blob null -> download skipped
      expect(setScene).toHaveBeenCalledWith('title');
    } finally {
      OffscreenCanvas.prototype.convertToBlob = orig;
    }
  });

  it('cancelling the dialog navigates to title without downloading', async () => {
    const createSpy = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const endOnClick = await clickEndWithPainting();
    endOnClick();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); // confirm -> false
    await Promise.resolve(); await Promise.resolve();
    expect(createSpy).not.toHaveBeenCalled();
    expect(setScene).toHaveBeenCalledWith('title');
  });
});

describe('onPointer: power-up overlay routing', () => {
  it('a milestone modal: tapping a fill slot adds a charge and closes the popup (handleOverlayModalButton true)', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    c.onScoreChanged(1500, 1500);                  // earns 1 milestone -> opens picker
    expect(overlay.isModalOpen()).toBe(true);
    const slotSpy = vi.spyOn(render, 'drawPowerupSlot');
    zen.draw();
    // panel draws 4 slots, then the milestone popup draws 4 more; first popup slot = index 4.
    const m0 = slotSpy.mock.calls[4];              // [x,y,w,h,...] for milestone slot 'shuffle'
    zen.onPointer({ type: 'down', x: m0[0] + m0[2] / 2, y: m0[1] + m0[3] / 2 });
    expect(storage.load().powerups.charges.shuffle).toBe(1);
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('a milestone modal: tapping outside any fill slot dismisses it (handleOverlayModalButton false -> handlePointer)', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    c.onScoreChanged(1500, 1500);
    zen.draw();
    zen.onPointer({ type: 'down', x: 3, y: 3 });   // corner: hits no modal button
    expect(overlay.isModalOpen()).toBe(false);     // overlay.handlePointer dismissed it
    expect(storage.load().powerups.charges.shuffle).toBe(0); // nothing allocated
  });

  it('a pending power-up target tap is consumed by the overlay (non-modal handlePointer true)', () => {
    storage.saveKey('powerups', { charges: { shuffle: 0, colorBlast: 1, bombDrop: 0, recolor: 0 } });
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    const slotSpy = vi.spyOn(render, 'drawPowerupSlot');
    zen.draw();
    const cb = slotSpy.mock.calls[1];              // panel slot index 1 = colorBlast
    zen.onPointer({ type: 'down', x: cb[0] + cb[2] / 2, y: cb[1] + cb[3] / 2 }); // enter target mode
    expect(overlay.isModalOpen()).toBe(false);
    const board = cellXY(3, 3);
    zen.onPointer({ type: 'down', x: board.x, y: board.y }); // target tap -> activateColorBlast
    expect(storage.load().powerups.charges.colorBlast).toBe(0); // spent
  });

  it('non-down pointer events flow straight to the drag handler (cancel is harmless)', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    expect(() => zen.onPointer({ type: 'cancel', x: 10, y: 10 })).not.toThrow();
    expect(() => zen.onMove(20, 20)).not.toThrow();
  });

  it('modal-branch defensive guard: a modal that declines the tap swallows it (no drag)', () => {
    zen.enter({});
    const c = debugHud.activeCascade(); runToIdle(zen, c);
    zen.draw();                                    // buttons[] has no modal entries
    vi.spyOn(overlay, 'isModalOpen').mockReturnValue(true);
    vi.spyOn(overlay, 'handlePointer').mockReturnValue(false);
    const dh = vi.spyOn(drag, 'handle');
    zen.onPointer({ type: 'down', x: 4, y: 4 });   // -> handleOverlayModalButton false -> handlePointer false -> swallow
    expect(dh).not.toHaveBeenCalled();
  });
});

describe('snapshotSaveState guards', () => {
  it('does not snapshot while the cascade is mid-animation', () => {
    zen.enter({ restoreFrom: { grid: plantedSerial(), score: 50, milestoneFloor: 0 } });
    const c = debugHud.activeCascade();
    expect(storage.load().zen.saveState).toBeNull();
    c.state = STATE.FALLING;
    c.onIdleReached();                              // wired callback -> snapshotSaveState
    expect(storage.load().zen.saveState).toBeNull(); // state !== IDLE -> skipped
    c.state = STATE.IDLE;
    c.onIdleReached();
    expect(storage.load().zen.saveState).toBeTruthy();
  });
});

describe('isDebugHost branches (enter sets window.__zen only on a debug host)', () => {
  it('localhost host installs the debug handle (default jsdom)', () => {
    zen.enter({});
    expect(window.__zen).toBeTruthy();
    zen.exit();
    expect(window.__zen).toBeUndefined();           // exit deletes it
  });

  it('127.0.0.1 host also installs the handle', () => {
    vi.stubGlobal('location', { hostname: '127.0.0.1', search: '' });
    zen.enter({});
    expect(window.__zen).toBeTruthy();
  });

  it('?debug=1 on a non-loopback host installs the handle', () => {
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '?debug=1' });
    zen.enter({});
    expect(window.__zen).toBeTruthy();
  });

  it('a plain production host does NOT install the handle', () => {
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    zen.enter({});
    expect(window.__zen).toBeUndefined();
  });

  it('a missing location is treated as not-debug', () => {
    vi.stubGlobal('location', undefined);
    zen.enter({});
    expect(window.__zen).toBeUndefined();
  });
});

describe('exit() SSR guard', () => {
  it('skips the window.__zen cleanup when window is undefined', () => {
    zen.enter({});
    const c = debugHud.activeCascade();
    c.score = 0;                                   // skip finalizeRun
    // setPanelWidth() -> resize() reads window; isolate it so exit() can run
    // with a stubbed-undefined window and exercise the typeof-window guard.
    vi.spyOn(render, 'setPanelWidth').mockImplementation(() => {});
    vi.stubGlobal('window', undefined);
    expect(() => zen.exit()).not.toThrow();
  });
});

describe('exit() before enter()', () => {
  it('is a no-op when no cascade exists yet (cascade-null guard)', async () => {
    const f = await freshZen();
    expect(() => f.scene.exit()).not.toThrow();
    expect(f.storage.load().zen.totalRunsPlayed).toBe(0); // no finalize
  });
});
