import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// result.js imports render (-> main) and main directly; break the cycle + the
// import-time main.init(). dialogs.alert() returns a promise that only settles
// on a button press, so mock it to resolve immediately (the clipboard share
// path awaits it).
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));
vi.mock('../src/dialogs.js', () => ({ alert: vi.fn().mockResolvedValue(undefined) }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as dialogs from '../src/dialogs.js';
import { setScene } from '../src/main.js';
import { LEVELS } from '../src/levels.js';
import { PUZZLES } from '../src/puzzles.js';
import * as result from '../src/scenes/result.js';

const W = 800, H = 600;
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  installCanvas();
  setViewport(W, H, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
});

afterEach(() => {
  // Remove any navigator.share/clipboard we installed for share tests.
  try { Object.defineProperty(navigator, 'share', { value: undefined, configurable: true }); } catch { /* ignore */ }
  try { Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true }); } catch { /* ignore */ }
});

// --- geometry helpers (mirror result.draw's button stacking) ---
// Subtitle is N lines, each row +40 from y0 = H*0.30 + 60.
function firstActionCenter(nLines) {
  const y = H * 0.30 + 60 + 40 * nLines;
  const ay = y + 30;
  return { x: W / 2, y: ay + 25 }; // btnH=50 -> center +25
}
function titleCenter(nLines, hasAction) {
  const y = H * 0.30 + 60 + 40 * nLines;
  let ay = y + 30;
  if (hasAction) ay += 50 + 14; // one action button above (btnH + gap)
  return { x: W / 2, y: ay + 25 };
}
const down = (x, y) => result.onPointer({ type: 'down', x, y });
const ctxCalls = () => render.ctxRef().__calls;
const drewText = (s) => ctxCalls().some((c) => c[0] === 'fillText' && c[1][0] === s);

function setShare(fn) { Object.defineProperty(navigator, 'share', { value: fn, configurable: true, writable: true }); }
function setClipboard(obj) { Object.defineProperty(navigator, 'clipboard', { value: obj, configurable: true, writable: true }); }

describe('result: lifecycle + default/unknown mode', () => {
  it('enter() with no args defaults to {} and draws the generic "Run Ended" screen', () => {
    result.enter(); // default param a = {}
    result.draw();
    expect(drewText('Run Ended')).toBe(true);
  });

  it('enter(null) coalesces to {} via `a || {}`', () => {
    result.enter(null); // a is non-undefined -> exercises the `|| {}` branch
    result.draw();
    expect(drewText('Run Ended')).toBe(true);
  });

  it('the Title button returns to the title scene (only button in generic mode)', () => {
    result.enter({ score: 500 });
    result.draw();
    const t = titleCenter(1, false);
    down(t.x, t.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('exit() and update() are no-ops that do not throw', () => {
    expect(() => { result.exit(); result.update(16); }).not.toThrow();
  });

  it('onMove records the cursor; onPointer ignores non-down events', () => {
    result.enter({ score: 1 });
    result.draw();
    result.onMove(W / 2, firstActionCenter(1).y); // hover the (title) button
    result.onPointer({ type: 'up', x: W / 2, y: firstActionCenter(1).y });
    result.onPointer({ type: 'move', x: 0, y: 0 });
    expect(setScene).not.toHaveBeenCalled();
  });
});

describe('result: classic mode', () => {
  it('win below max level: shows stars + Next Level, which advances', () => {
    result.enter({ mode: 'classic', outcome: 'win', level: 1, stars: 2, score: 1000, target: 500 });
    result.draw();
    expect(drewText('Level Complete!')).toBe(true);
    expect(drewText('★★☆')).toBe(true); // star subtitle line

    const a = firstActionCenter(2);
    down(a.x, a.y);
    expect(setScene).toHaveBeenCalledWith('gameClassic', { level: 2 });

    const t = titleCenter(2, true);
    down(t.x, t.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('win at the final level: no Next Level button (only Title)', () => {
    result.enter({ mode: 'classic', outcome: 'win', level: LEVELS.length, stars: 3, score: 9, target: 1 });
    result.draw();
    expect(drewText('Level Complete!')).toBe(true);
    // No Next Level -> the only button sits at the first-action slot.
    const t = titleCenter(2, false);
    down(t.x, t.y);
    expect(setScene).toHaveBeenCalledExactlyOnceWith('title');
  });

  it('lose: shows Out of Moves + Retry, which replays the same level', () => {
    result.enter({ mode: 'classic', outcome: 'lose', level: 5, score: 100, target: 500 });
    result.draw();
    expect(drewText('Out of Moves')).toBe(true);
    const a = firstActionCenter(1);
    down(a.x, a.y);
    expect(setScene).toHaveBeenCalledWith('gameClassic', { level: 5 });
  });
});

describe('result: blitz mode', () => {
  it('new best: shows the New best line and Again restarts blitz', () => {
    result.enter({ mode: 'blitz', score: 9999, isNewBest: true });
    result.draw();
    expect(drewText('⚡ Blitz Done')).toBe(true);
    expect(drewText('🏆 New best!')).toBe(true);
    const a = firstActionCenter(2);
    down(a.x, a.y);
    expect(setScene).toHaveBeenCalledWith('gameBlitz');
  });

  it('not new best, prevBest given: shows prior best', () => {
    result.enter({ mode: 'blitz', score: 50, isNewBest: false, prevBest: 300 });
    result.draw();
    expect(drewText('Best: 300')).toBe(true);
  });

  it('not new best, prevBest absent: falls back to 0 via `?? 0`', () => {
    result.enter({ mode: 'blitz', score: 50, isNewBest: false });
    result.draw();
    expect(drewText('Best: 0')).toBe(true);
  });
});

describe('result: daily mode', () => {
  it('new best: header + New best line', () => {
    result.enter({ mode: 'daily', score: 1234, date: '2026-06-26', isNewBest: true });
    result.draw();
    expect(drewText('Daily — 2026-06-26')).toBe(true);
    expect(drewText('🏆 New best!')).toBe(true);
  });

  it('not new best with prevBest: uses the passed-in prior best', () => {
    result.enter({ mode: 'daily', score: 10, date: '2026-06-26', isNewBest: false, prevBest: 999 });
    result.draw();
    expect(drewText('Best ever: 999')).toBe(true);
  });

  it('not new best without prevBest: reads daily.bestEver from storage (?? right side)', () => {
    storage.saveKey('daily', { bestEver: 4242 });
    result.enter({ mode: 'daily', score: 10, date: '2026-06-26', isNewBest: false });
    result.draw();
    expect(drewText('Best ever: 4242')).toBe(true);
  });

  it('Share uses navigator.share when available', async () => {
    const share = vi.fn().mockResolvedValue(undefined);
    setShare(share);
    result.enter({ mode: 'daily', score: 1234, date: '2026-06-26', isNewBest: true });
    result.draw();
    const a = firstActionCenter(2);
    down(a.x, a.y);
    await tick();
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ title: 'Jeweled' }));
  });

  it('Share falls back to clipboard + alert when navigator.share is absent', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    result.enter({ mode: 'daily', score: 1234, date: '2026-06-26', isNewBest: true });
    result.draw();
    const a = firstActionCenter(2);
    down(a.x, a.y);
    await tick();
    expect(writeText).toHaveBeenCalled();
    expect(dialogs.alert).toHaveBeenCalled();
  });

  it('Share is a no-op when neither share nor clipboard exist', async () => {
    // both undefined (afterEach/default)
    result.enter({ mode: 'daily', score: 1234, date: '2026-06-26', isNewBest: true });
    result.draw();
    const a = firstActionCenter(2);
    expect(() => down(a.x, a.y)).not.toThrow();
    await tick();
    expect(dialogs.alert).not.toHaveBeenCalled();
  });

  it('Share swallows errors from navigator.share (catch branch)', async () => {
    const share = vi.fn().mockRejectedValue(new Error('user cancelled'));
    setShare(share);
    result.enter({ mode: 'daily', score: 1234, date: '2026-06-26', isNewBest: true });
    result.draw();
    const a = firstActionCenter(2);
    expect(() => down(a.x, a.y)).not.toThrow();
    await tick();
    expect(share).toHaveBeenCalled();
  });
});

describe('result: puzzle mode', () => {
  it('win with a next puzzle: Next puzzle advances by id', () => {
    result.enter({ mode: 'puzzle', outcome: 'win', puzzleNum: 1, score: 200 });
    result.draw();
    expect(drewText('🧩 Solved!')).toBe(true);
    const a = firstActionCenter(2);
    down(a.x, a.y);
    expect(setScene).toHaveBeenCalledWith('gamePuzzle', { puzzle: 2 });
  });

  it('win on the last puzzle: All puzzles returns to puzzleSelect', () => {
    result.enter({ mode: 'puzzle', outcome: 'win', puzzleNum: PUZZLES.length, score: 200 });
    result.draw();
    const a = firstActionCenter(2);
    down(a.x, a.y);
    expect(setScene).toHaveBeenCalledWith('puzzleSelect');
  });

  it('lose on an unknown puzzle id: blank name, Retry replays it', () => {
    result.enter({ mode: 'puzzle', outcome: 'lose', puzzleNum: 999, score: 50 });
    result.draw();
    expect(drewText('Puzzle Failed')).toBe(true);
    const a = firstActionCenter(2);
    down(a.x, a.y);
    expect(setScene).toHaveBeenCalledWith('gamePuzzle', { puzzle: 999 });
  });
});
