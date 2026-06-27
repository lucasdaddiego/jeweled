import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// puzzleSelect imports render (-> main) and main directly.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import { setScene } from '../src/main.js';
import { PUZZLES } from '../src/puzzles.js';
import * as ps from '../src/scenes/puzzleSelect.js';

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
});

// --- geometry helpers (mirror puzzleSelect.draw) ---
function geom() {
  const { h } = render.getViewport();
  const col = render.menuColumn();
  const cols = Math.min(3, Math.max(2, Math.floor(col.w / 230)));
  const gap = 14;
  const cellW = Math.floor((col.w - (cols - 1) * gap) / cols);
  const cellH = 110;
  const totalW = cols * cellW + (cols - 1) * gap;
  const ox = col.x + Math.floor((col.w - totalW) / 2);
  const listTop = h * 0.18;
  return { cols, gap, cellW, cellH, ox, listTop };
}
function tileCenter(i, scrollY = 0) {
  const { cols, gap, cellW, cellH, ox, listTop } = geom();
  const c = i % cols, r = Math.floor(i / cols);
  return { x: ox + c * (cellW + gap) + cellW / 2, y: listTop + r * (cellH + gap) - scrollY + cellH / 2 };
}
function back() {
  const col = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  return { x: col.right - backW + backW / 2, y: backY + 16 };
}
const downAt = (x, y) => ps.onPointer({ type: 'down', x, y });
const upAt = (x, y) => ps.onPointer({ type: 'up', x, y });
const tap = (x, y) => { downAt(x, y); upAt(x, y); };
const drewText = (s) => render.ctxRef().__calls.some((c) => c[0] === 'fillText' && c[1][0] === s);

describe('puzzleSelect: basics', () => {
  it('exit()/update() are no-ops', () => {
    expect(() => { ps.exit(); ps.update(16); }).not.toThrow();
  });

  it('fresh save: shows 0 solved and tapping a tile launches that puzzle', () => {
    ps.enter();
    ps.draw();
    expect(drewText(`0 / ${PUZZLES.length} solved`)).toBe(true);
    const c = tileCenter(0);
    tap(c.x, c.y);
    expect(setScene).toHaveBeenCalledWith('gamePuzzle', { puzzle: PUZZLES[0].id });
  });

  it('completed puzzles render a check, hovered uncompleted tiles highlight', () => {
    storage.saveKey('puzzle', { completed: { 1: { bestScore: 100, completedAt: 'x' } } });
    ps.enter();
    const c1 = tileCenter(1); // hover an uncompleted tile (id 2)
    ps.onMove(c1.x, c1.y);
    ps.draw();
    expect(drewText('✓')).toBe(true);                       // completed tile (id 1)
    expect(drewText(`1 / ${PUZZLES.length} solved`)).toBe(true);
  });

  it('Back returns to title', () => {
    ps.enter();
    ps.draw();
    const b = back();
    tap(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });
});

describe('puzzleSelect: scrolling', () => {
  it('wheel scrolls and clamps at both ends', () => {
    ps.enter();
    ps.draw(); // sets maxScroll (10 at 800x600)
    ps.onWheel(1000); // clamp to maxScroll
    ps.draw();
    ps.onWheel(-1000); // clamp to 0
    ps.draw();
    expect(drewText(`0 / ${PUZZLES.length} solved`)).toBe(true);
  });

  it('a tiny move is still a tap (launches the puzzle)', () => {
    ps.enter();
    ps.draw();
    const c = tileCenter(0);
    downAt(c.x, c.y);
    ps.onMove(c.x, c.y - 3); // |dy| < threshold -> not a drag
    upAt(c.x, c.y);
    expect(setScene).toHaveBeenCalledWith('gamePuzzle', { puzzle: PUZZLES[0].id });
  });

  it('a drag past the threshold scrolls and cancels the tap', () => {
    ps.enter();
    ps.draw();
    const c = tileCenter(0);
    downAt(c.x, c.y);
    ps.onMove(c.x, c.y - 40); // drag up -> didDragScroll
    upAt(c.x, c.y);
    expect(setScene).not.toHaveBeenCalled();
  });

  it('onMove without a pressed pointer is ignored', () => {
    ps.enter();
    ps.draw();
    expect(() => ps.onMove(5, 5)).not.toThrow(); // isPointerDown === false -> early return
  });

  it('pointercancel clears the drag so later moves do not scroll', () => {
    ps.enter();
    ps.draw();
    const c = tileCenter(0);
    downAt(c.x, c.y);
    ps.onPointer({ type: 'cancel' });
    expect(() => ps.onMove(c.x, c.y - 40)).not.toThrow(); // ignored, pointer no longer down
  });

  it('ignores pointer events of an unhandled type', () => {
    ps.enter();
    ps.draw();
    // Neither down/up/cancel -> falls through every branch (no-op).
    expect(() => ps.onPointer({ type: 'move', x: 1, y: 1 })).not.toThrow();
    expect(setScene).not.toHaveBeenCalled();
  });
});

describe('puzzleSelect: layout edge cases', () => {
  it('clamps a tile hit-rect to the clipped band (narrow, scrolled to a straddling row)', () => {
    setViewport(360, 500, 1);
    render.setupCanvas();
    render.buildAtlas();
    ps.enter();
    ps.draw();          // maxScroll = 340
    ps.onWheel(104);    // a row's bottom edge lands just above listTop
    ps.draw();          // exercises the `if (rb > ry)` false branch
    expect(render.layout.isNarrow).toBe(true);
  });

  it('does not draw a scroll thumb when everything fits (maxScroll === 0)', () => {
    setViewport(800, 900, 1);
    render.setupCanvas();
    render.buildAtlas();
    ps.enter();
    ps.draw();
    expect(drewText(`0 / ${PUZZLES.length} solved`)).toBe(true);
  });

  it('handles a state object with no puzzle key (defensive ?. and || {})', () => {
    const spy = vi.spyOn(storage, 'load').mockReturnValue({});
    ps.enter();
    ps.draw();
    expect(drewText(`0 / ${PUZZLES.length} solved`)).toBe(true);
    spy.mockRestore();
  });
});
