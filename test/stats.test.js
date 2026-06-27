import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// stats imports render (-> main) and main directly; achievements only pulls storage.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import { setScene } from '../src/main.js';
import { ACHIEVEMENTS } from '../src/achievements.js';
import * as stats from '../src/scenes/stats.js';

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
});

function back() {
  const col = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  return { x: col.right - backW + backW / 2, y: backY + 16 };
}
const down = (x, y) => stats.onPointer({ type: 'down', x, y });
const drewText = (s) => render.ctxRef().__calls.some((c) => c[0] === 'fillText' && c[1][0] === s);
const drewTextStartsWith = (p) =>
  render.ctxRef().__calls.some((c) => c[0] === 'fillText' && typeof c[1][0] === 'string' && c[1][0].startsWith(p));

describe('stats: rendering', () => {
  it('fresh save: zeros everywhere, ellipsizes long descriptions, all locked', () => {
    stats.enter();
    stats.draw();
    expect(drewText('Stats & Achievements')).toBe(true);
    expect(drewText(`0 / ${ACHIEVEMENTS.length} unlocked`)).toBe(true);
    // Short descriptions render in full (ellipsize early-return path).
    expect(drewText('Make your first match.')).toBe(true);
    // Long ones get truncated with an ellipsis (binary-search path): the full
    // string is never drawn, but a clipped prefix + '…' is.
    expect(drewText('Spawn your first Color Bomb.')).toBe(false);
    expect(drewTextStartsWith('Spawn your first Color')).toBe(true);
    expect(render.ctxRef().__calls.some(
      (c) => c[0] === 'fillText' && typeof c[1][0] === 'string' && c[1][0].endsWith('…'),
    )).toBe(true);
  });

  it('populated save: shows real counters and an unlocked achievement', () => {
    storage.saveKey('achievements', {
      unlocked: { first_match: { at: 'x', shownAt: 'y' } },
      counters: { totalMatches: 500 },
    });
    storage.saveKey('zen', { bestScore: 1234, totalRunsPlayed: 5 });
    storage.saveKey('daily', { totalDaysPlayed: 3 });
    storage.saveKey('blitz', { bestScore: 777 });
    storage.saveKey('classic', { levels: { 1: {}, 2: {} } });

    stats.enter();
    stats.draw();
    expect(drewText(`1 / ${ACHIEVEMENTS.length} unlocked`)).toBe(true);
    expect(drewText('500')).toBe(true);     // totalMatches
    expect(drewText('1234')).toBe(true);    // zen best
    expect(drewText('777')).toBe(true);     // blitz best
    expect(drewText('2 / 300')).toBe(true); // classic levels beaten
  });

  it('handles a sparse state object missing whole sub-trees (defensive ?. / ||)', () => {
    const spy = vi.spyOn(storage, 'load').mockImplementation(() => ({}));
    stats.enter();
    expect(() => stats.draw()).not.toThrow();
    expect(drewText('Stats & Achievements')).toBe(true);
    spy.mockRestore();
  });

  it('no scroll thumb when the grid fits (tall viewport, maxScroll === 0)', () => {
    setViewport(800, 900, 1);
    render.setupCanvas();
    render.buildAtlas();
    stats.enter();
    stats.draw();
    expect(drewText('Stats & Achievements')).toBe(true);
  });

  it('renders on a narrow viewport (short back label, 2 columns)', () => {
    setViewport(400, 700, 1);
    render.setupCanvas();
    render.buildAtlas();
    stats.enter();
    stats.draw();
    expect(render.layout.isNarrow).toBe(true);
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('exit()/update() are no-ops', () => {
    expect(() => { stats.exit(); stats.update(16); }).not.toThrow();
  });
});

describe('stats: input', () => {
  it('tapping Back returns to title', () => {
    stats.enter();
    stats.draw();
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('wheel scrolls and clamps at both ends', () => {
    stats.enter();
    stats.draw(); // sets maxScroll (>0 at 800x600)
    stats.onWheel(5000);  // clamp to max
    stats.draw();
    stats.onWheel(-5000); // clamp to 0
    stats.draw();
    expect(drewText('Stats & Achievements')).toBe(true);
  });

  it('drag on empty space scrolls the grid; small move does not', () => {
    stats.enter();
    stats.draw();
    // onMove before any pointerdown is ignored.
    expect(() => stats.onMove(10, 10)).not.toThrow();
    // Press in the grid (not on the Back button) -> starts a potential drag.
    down(400, 400);
    stats.onMove(400, 397);  // |dy| < threshold -> no drag
    stats.onMove(400, 300);  // |dy| > threshold -> drag-scroll
    stats.onPointer({ type: 'up', x: 400, y: 300 });
    expect(setScene).not.toHaveBeenCalled();
  });

  it('pointercancel and unhandled event types are handled safely', () => {
    stats.enter();
    stats.draw();
    down(400, 400);
    expect(() => stats.onPointer({ type: 'cancel' })).not.toThrow();
    expect(() => stats.onPointer({ type: 'move', x: 1, y: 1 })).not.toThrow();
    expect(setScene).not.toHaveBeenCalled();
  });
});
