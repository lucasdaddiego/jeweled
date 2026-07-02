import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// gempedia imports render (-> main) and main directly.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import { setScene } from '../src/main.js';
import { POWERUP_SLOTS, POWERUP_META } from '../src/config.js';
import * as i18n from '../src/i18n.js';
import * as gempedia from '../src/scenes/gempedia.js';
import { ENTRIES } from '../src/scenes/gempedia.js';

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
});

function back() {
  const col = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  return { x: col.right - backW + backW / 2, y: backY + 16 };
}
const down = (x, y) => gempedia.onPointer({ type: 'down', x, y });
// draw() and return only the ctx calls recorded during THIS frame, so
// scroll-culling assertions aren't polluted by earlier frames on the same ctx.
function drawFrame() {
  const calls = render.ctxRef().__calls;
  const start = calls.length;
  gempedia.draw();
  return calls.slice(start);
}
const drew = (calls, s) => calls.some((c) => c[0] === 'fillText' && c[1][0] === s);

const GEM_IDS = [
  'line', 'colorBomb', 'areaBomb', 'star', 'fire',
  'lightning', 'wildcard', 'coin', 'gravity', 'timeBomb',
];

describe('gempedia: ENTRIES data', () => {
  it('lists every special gem followed by every power-up slot', () => {
    expect(ENTRIES.map((e) => e.id)).toEqual([...GEM_IDS, ...POWERUP_SLOTS]);
  });

  it('ids are unique', () => {
    const ids = ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every entry is complete and keys follow the gempedia.<id>.* pattern', () => {
    for (const e of ENTRIES) {
      expect(e.id).toBeTruthy();
      expect(e.emoji).toBeTruthy();
      expect(e.ring).toMatch(/^#[0-9a-f]{6}$/i);
      expect(e.nameKey).toBe(`gempedia.${e.id}.name`);
      expect(e.descKey).toBe(`gempedia.${e.id}.desc`);
      expect(e.howKey).toBe(`gempedia.${e.id}.how`);
    }
  });

  it('power-up entries reuse the POWERUP_META emoji and ring', () => {
    for (const slot of POWERUP_SLOTS) {
      const e = ENTRIES.find((x) => x.id === slot);
      expect(e.emoji).toBe(POWERUP_META[slot].emoji);
      expect(e.ring).toBe(POWERUP_META[slot].ring);
    }
  });
});

describe('gempedia: rendering', () => {
  it('draws title, subtitle, badge emoji, and only the visible cards', () => {
    gempedia.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('gempedia.title'))).toBe(true);
    expect(drew(calls, i18n.t('gempedia.subtitle'))).toBe(true);
    // First card fully rendered: emoji badge + name + desc + how line.
    expect(drew(calls, '↔️')).toBe(true);
    expect(drew(calls, i18n.t('gempedia.line.name'))).toBe(true);
    expect(drew(calls, i18n.t('gempedia.line.desc'))).toBe(true);
    expect(drew(calls, i18n.t('gempedia.line.how'))).toBe(true);
    // Cards below the fold are culled at scroll 0.
    expect(drew(calls, i18n.t('gempedia.recolor.name'))).toBe(false);
  });

  it('tall viewport: list fits, no culling, wheel clamps at zero (maxScroll = 0)', () => {
    // Tall enough that the whole catalog fits even if a few entries get added.
    setViewport(800, 2200, 1);
    render.setupCanvas();
    render.buildAtlas();
    gempedia.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('gempedia.line.name'))).toBe(true);
    expect(drew(calls, i18n.t('gempedia.recolor.name'))).toBe(true);
    gempedia.onWheel(500);
    const calls2 = drawFrame();
    expect(drew(calls2, i18n.t('gempedia.line.name'))).toBe(true);
  });

  it('renders on a narrow viewport (short back label) and Back works', () => {
    setViewport(400, 700, 1);
    render.setupCanvas();
    render.buildAtlas();
    gempedia.enter();
    const calls = drawFrame();
    expect(render.layout.isNarrow).toBe(true);
    expect(drew(calls, '←')).toBe(true);
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('enter() resets scroll; exit()/update() are no-ops', () => {
    gempedia.enter();
    gempedia.draw();
    gempedia.onWheel(5000);
    const scrolled = drawFrame();
    expect(drew(scrolled, i18n.t('gempedia.line.name'))).toBe(false);
    gempedia.enter();                 // back to scrollY = 0
    const fresh = drawFrame();
    expect(drew(fresh, i18n.t('gempedia.line.name'))).toBe(true);
    expect(() => { gempedia.exit(); gempedia.update(16); }).not.toThrow();
  });
});

describe('gempedia: input', () => {
  it('tapping Back returns to title; tapping a card does not (cards are not buttons)', () => {
    gempedia.enter();
    gempedia.draw();
    down(400, 140);                       // inside the first card
    gempedia.onPointer({ type: 'up', x: 400, y: 140 });
    expect(setScene).not.toHaveBeenCalled();
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('wheel scrolls (first card culled at max) and clamps at both ends', () => {
    gempedia.enter();
    gempedia.draw();                      // sets maxScroll (>0 at 800x600)
    gempedia.onWheel(5000);               // clamp to max
    const atMax = drawFrame();
    expect(drew(atMax, i18n.t('gempedia.line.name'))).toBe(false);
    expect(drew(atMax, i18n.t('gempedia.recolor.name'))).toBe(true);
    gempedia.onWheel(-5000);              // clamp back to 0
    const atTop = drawFrame();
    expect(drew(atTop, i18n.t('gempedia.line.name'))).toBe(true);
    expect(drew(atTop, i18n.t('gempedia.recolor.name'))).toBe(false);
  });

  it('drag on empty space scrolls the list; small move does not', () => {
    gempedia.enter();
    gempedia.draw();
    expect(() => gempedia.onMove(10, 10)).not.toThrow();   // ignored before pointerdown
    down(400, 400);
    gempedia.onMove(400, 397);            // |dy| < threshold → no drag yet
    const noDrag = drawFrame();
    expect(drew(noDrag, i18n.t('gempedia.line.name'))).toBe(true);
    gempedia.onMove(400, -5000);          // big upward drag → scroll, clamped to max
    gempedia.onMove(400, -5001);          // further move while already dragging
    gempedia.onPointer({ type: 'up', x: 400, y: -5001 });
    const dragged = drawFrame();
    expect(drew(dragged, i18n.t('gempedia.line.name'))).toBe(false);
    expect(drew(dragged, i18n.t('gempedia.recolor.name'))).toBe(true);
    // Drag downward past the top clamps back to 0.
    down(400, 100);
    gempedia.onMove(400, 5000);
    const backAtTop = drawFrame();
    expect(drew(backAtTop, i18n.t('gempedia.line.name'))).toBe(true);
    expect(setScene).not.toHaveBeenCalled();
  });

  it('pointercancel clears the drag; unhandled event types are safe', () => {
    gempedia.enter();
    gempedia.draw();
    down(400, 400);
    expect(() => gempedia.onPointer({ type: 'cancel' })).not.toThrow();
    // A stray move after cancel must not scroll from the stale drag origin.
    gempedia.onMove(400, -5000);
    const calls = drawFrame();
    expect(drew(calls, i18n.t('gempedia.line.name'))).toBe(true);
    expect(() => gempedia.onPointer({ type: 'move', x: 1, y: 1 })).not.toThrow();
    expect(setScene).not.toHaveBeenCalled();
  });
});
