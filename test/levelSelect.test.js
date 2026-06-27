import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// levelSelect imports render (-> main) and main directly.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import { setScene } from '../src/main.js';
import { pageCount, pageOfLevel } from '../src/levels.js';
import * as ls from '../src/scenes/levelSelect.js';

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
});

// --- geometry helpers (mirror levelSelect.draw) ---
function gridGeom() {
  const { h } = render.getViewport();
  const titleY = h * 0.06 + render.layout.safeTop;
  const col = render.menuColumn();
  const cols = 4, rows = 5;
  const gap = render.layout.isNarrow ? 10 : 14;
  const maxCellW = render.layout.isNarrow ? 84 : 110;
  const topMargin = titleY + 70;
  const bottomMargin = 100;
  const availH = Math.max(1, h - topMargin - bottomMargin);
  const cellByW = Math.floor((col.w - (cols - 1) * gap) / cols);
  const cellByH = Math.floor((availH - (rows - 1) * gap) / rows);
  const cellW = Math.max(40, Math.min(maxCellW, cellByW, cellByH));
  const cellH = cellW;
  const totalW = cols * cellW + (cols - 1) * gap;
  const totalH = rows * cellH + (rows - 1) * gap;
  const ox = col.x + Math.floor((col.w - totalW) / 2);
  const oy = topMargin + Math.max(0, Math.floor((availH - totalH) / 2));
  return { cols, gap, cellW, cellH, ox, oy };
}
function tileCenter(ln, currentPage) {
  const { cols, gap, cellW, cellH, ox, oy } = gridGeom();
  const idx = ln - ((currentPage - 1) * 20 + 1);
  const c = idx % cols, r = Math.floor(idx / cols);
  return { x: ox + c * (cellW + gap) + cellW / 2, y: oy + r * (cellH + gap) + cellH / 2 };
}
function pag() {
  const { w, h } = render.getViewport();
  const ctrlY = h - 60;
  const btnW = render.layout.isNarrow ? 52 : 70;
  const btnH = 40;
  return {
    prev: { x: w / 2 - btnW - 100 + btnW / 2, y: ctrlY + btnH / 2 },
    next: { x: w / 2 + 100 + btnW / 2, y: ctrlY + btnH / 2 },
  };
}
function back() {
  const col = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  return { x: col.right - backW + backW / 2, y: backY + 16 };
}
const down = (x, y) => ls.onPointer({ type: 'down', x, y });
const drewText = (s) => render.ctxRef().__calls.some((c) => c[0] === 'fillText' && c[1][0] === s);

describe('levelSelect: enter()', () => {
  it('jumps to page 1 for a fresh save (highestUnlocked = 1)', () => {
    ls.enter();
    ls.draw();
    expect(drewText(`Page 1 / ${pageCount()}`)).toBe(true);
  });

  it('jumps to the page containing the highest unlocked level', () => {
    storage.saveKey('classic', { highestUnlocked: 25 });
    ls.enter();
    ls.draw();
    expect(drewText(`Page ${pageOfLevel(25)} / ${pageCount()}`)).toBe(true);
  });

  it('exit() and update() do not throw', () => {
    expect(() => { ls.exit(); ls.update(16); }).not.toThrow();
  });
});

describe('levelSelect: tiles', () => {
  it('tapping an unlocked tile starts that Classic level', () => {
    ls.enter(); // page 1, only level 1 unlocked
    ls.draw();
    const c = tileCenter(1, 1);
    down(c.x, c.y);
    expect(setScene).toHaveBeenCalledWith('gameClassic', { level: 1 });
  });

  it('tapping a locked tile does nothing (not registered as a button)', () => {
    ls.enter(); // highest = 1, so level 5 is locked
    ls.draw();
    const c = tileCenter(5, 1);
    down(c.x, c.y);
    expect(setScene).not.toHaveBeenCalled();
  });

  it('renders stars + best score for completed levels and hover for the cursor tile', () => {
    storage.saveKey('classic', {
      highestUnlocked: 10,
      levels: { 1: { starsEarned: 3, bestScore: 5000 }, 2: { starsEarned: 0, bestScore: 0 } },
    });
    ls.enter(); // page 1
    const c = tileCenter(1, 1);
    ls.onMove(c.x, c.y); // hover the unlocked level-1 tile
    ls.draw();
    expect(drewText('★★★')).toBe(true);   // level 1 stars
    expect(drewText('5000')).toBe(true);  // level 1 best score
    expect(drewText('🔒')).toBe(true);    // locked tiles (11..20)
  });
});

describe('levelSelect: pagination', () => {
  it('Next advances the page; Prev (enabled) goes back', () => {
    storage.saveKey('classic', { highestUnlocked: 25 });
    ls.enter(); // page 2
    ls.onMove(pag().prev.x, pag().prev.y); // hover an enabled Prev
    ls.draw();
    expect(drewText(`Page 2 / ${pageCount()}`)).toBe(true);

    down(pag().next.x, pag().next.y); // -> page 3
    ls.draw();
    expect(drewText(`Page 3 / ${pageCount()}`)).toBe(true);

    down(pag().prev.x, pag().prev.y); // -> page 2
    ls.draw();
    expect(drewText(`Page 2 / ${pageCount()}`)).toBe(true);
  });

  it('Prev is disabled on page 1 (no-op when its stale rect is tapped twice)', () => {
    storage.saveKey('classic', { highestUnlocked: 25 });
    ls.enter(); // page 2, Prev enabled
    ls.draw();
    down(pag().prev.x, pag().prev.y); // -> page 1
    // buttons[] is now stale (still page 2's). Tapping the stale Prev again with
    // currentPage === 1 exercises the inner `if (currentPage > 1)` false branch.
    down(pag().prev.x, pag().prev.y); // no-op
    ls.draw();
    expect(drewText(`Page 1 / ${pageCount()}`)).toBe(true);
  });

  it('Next is disabled on the last page (inner-guard false branch via stale tap)', () => {
    storage.saveKey('classic', { highestUnlocked: 270 }); // page 14
    ls.enter();
    ls.draw();
    down(pag().next.x, pag().next.y); // -> page 15 (last)
    // Stale Next rect tapped again with currentPage === totalPages: inner
    // `if (currentPage < totalPages)` false branch.
    down(pag().next.x, pag().next.y); // no-op
    ls.draw();
    expect(drewText(`Page ${pageCount()} / ${pageCount()}`)).toBe(true);
  });

  it('on the very last page Next is drawn disabled (not clickable)', () => {
    storage.saveKey('classic', { highestUnlocked: 300 }); // page 15
    ls.enter();
    ls.draw();
    down(pag().next.x, pag().next.y); // Next disabled -> not in buttons -> no-op
    expect(setScene).not.toHaveBeenCalled();
  });
});

describe('levelSelect: back + input plumbing', () => {
  it('Back returns to the title scene', () => {
    ls.enter();
    ls.draw();
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('onPointer ignores non-down events', () => {
    ls.enter();
    ls.draw();
    ls.onPointer({ type: 'up', x: back().x, y: back().y });
    expect(setScene).not.toHaveBeenCalled();
  });

  it('renders on a narrow viewport (short labels + tighter grid)', () => {
    setViewport(400, 700, 1);
    render.setupCanvas();
    render.buildAtlas();
    ls.enter();
    ls.draw();
    expect(render.layout.isNarrow).toBe(true);
    expect(drewText(`Page 1 / ${pageCount()}`)).toBe(true);
    // Back uses the short label on narrow viewports.
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });
});
