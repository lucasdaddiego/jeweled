import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// gallery imports render (-> main) and main directly.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as i18n from '../src/i18n.js';
import { setScene } from '../src/main.js';
import * as gallery from '../src/scenes/gallery.js';

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
  i18n.init();
});

// Fixed past dates so the labels can never collide with "today"; the third
// item has no `at` and exercises the new Date() fallback label.
const ITEMS = [
  { dataUrl: 'data:image/png;base64,AAAA', at: '2024-03-05T12:00:00.000Z' },
  { dataUrl: 'data:image/png;base64,BBBB', at: '2024-02-29T08:30:00.000Z' },
  { dataUrl: 'data:image/png;base64,CCCC' },
];
const seed = () => storage.saveKey('zen', { gallery: ITEMS.map((x) => ({ ...x })) });

// Expected tile geometry — mirrors the scene's layout math exactly (same
// float op order) so fillText coordinates can be compared with ===.
function tiles(count) {
  const { w, h } = render.getViewport();
  const colM = render.menuColumn();
  const cols = render.layout.isNarrow ? 2 : 3;
  const gap = 14;
  const tile = Math.floor((colM.w - (cols - 1) * gap) / cols);
  const titleY = h * 0.07 + render.layout.safeTop;
  const oy = titleY + 56;
  const out = [];
  for (let i = 0; i < count; i++) {
    const x = colM.x + (i % cols) * (tile + gap);
    const y = oy + Math.floor(i / cols) * (tile + 26 + gap);
    out.push({ x, y, tile, labelX: x + tile / 2, labelY: y + tile + 6 });
  }
  return out;
}

function back() {
  const col = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  return { x: col.right - backW + backW / 2, y: backY + 16 };
}
const down = (x, y) => gallery.onPointer({ type: 'down', x, y });
// draw() and return only the ctx calls recorded during THIS frame.
function drawFrame() {
  const calls = render.ctxRef().__calls;
  const start = calls.length;
  gallery.draw();
  return calls.slice(start);
}
const drew = (calls, s) => calls.some((c) => c[0] === 'fillText' && c[1][0] === s);
const labelAt = (calls, x, y) =>
  calls.find((c) => c[0] === 'fillText' && c[1][1] === x && c[1][2] === y);

// jsdom never loads image resources, so the module-level Image cache keeps
// complete=false forever. To reach the drawImage branch we override the
// prototype accessors — the cached instances have no own properties, so the
// patch reaches them all. Restored in finally.
function patchImages({ complete, naturalWidth }, fn) {
  const proto = window.HTMLImageElement.prototype;
  const origC = Object.getOwnPropertyDescriptor(proto, 'complete');
  const origW = Object.getOwnPropertyDescriptor(proto, 'naturalWidth');
  Object.defineProperty(proto, 'complete', { configurable: true, get: () => complete });
  Object.defineProperty(proto, 'naturalWidth', { configurable: true, get: () => naturalWidth });
  try {
    return fn();
  } finally {
    Object.defineProperty(proto, 'complete', origC);
    Object.defineProperty(proto, 'naturalWidth', origW);
  }
}

describe('gallery: rendering', () => {
  it('empty gallery shows the empty hint (and enter() clears a leftover body class)', () => {
    document.body.className = 'daily-bg'; // arrived from the daily scenes
    gallery.enter();
    expect(document.body.className).toBe('');
    const calls = drawFrame();
    expect(drew(calls, i18n.t('gallery.title'))).toBe(true);
    expect(drew(calls, i18n.t('gallery.empty'))).toBe(true);
  });

  it('missing gallery blob (pre-gallery save shape) also shows the empty hint', () => {
    storage.saveKey('zen', { gallery: null });
    gallery.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('gallery.empty'))).toBe(true);
  });

  it('seeded gallery: 3 tiles in one wide row with date labels; images not yet decoded', () => {
    seed();
    gallery.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('gallery.empty'))).toBe(false);
    // Tile backgrounds: 3 roundRect paths + the Back button; each tile clips.
    expect(calls.filter((c) => c[0] === 'beginPath').length).toBe(4);
    expect(calls.filter((c) => c[0] === 'clip').length).toBe(3);
    // jsdom images stay complete=false, so nothing is blitted.
    expect(calls.some((c) => c[0] === 'drawImage')).toBe(false);
    // Wide viewport → 3 columns: all three labels sit on the same row.
    const t = tiles(3);
    expect(t[0].labelY).toBe(t[2].labelY);
    const l0 = labelAt(calls, t[0].labelX, t[0].labelY);
    const l1 = labelAt(calls, t[1].labelX, t[1].labelY);
    const l2 = labelAt(calls, t[2].labelX, t[2].labelY);
    expect(l0[1][0]).toBe(i18n.formatDate(new Date(ITEMS[0].at)));
    expect(l1[1][0]).toBe(i18n.formatDate(new Date(ITEMS[1].at)));
    // No `at` → labeled with "now"; just require a non-empty label there.
    expect(l2[1][0].length).toBeGreaterThan(0);
  });

  it('decoded images are drawn into their tiles (complete + naturalWidth gates)', () => {
    seed();
    gallery.enter();
    // complete=true but naturalWidth=0 (broken decode) → still no blit.
    patchImages({ complete: true, naturalWidth: 0 }, () => {
      const calls = drawFrame();
      expect(calls.some((c) => c[0] === 'drawImage')).toBe(false);
    });
    // Fully decoded → one drawImage per tile, at the tile rect.
    patchImages({ complete: true, naturalWidth: 2 }, () => {
      const calls = drawFrame();
      const blits = calls.filter((c) => c[0] === 'drawImage');
      expect(blits.map((c) => c[1].slice(1))).toEqual(
        tiles(3).map(({ x, y, tile }) => [x, y, tile, tile]),
      );
    });
  });

  it('narrow viewport: 2 columns (third tile wraps), short back label, Back works', () => {
    setViewport(400, 700, 1);
    render.setupCanvas();
    render.buildAtlas();
    seed();
    gallery.enter();
    const calls = drawFrame();
    expect(render.layout.isNarrow).toBe(true);
    expect(drew(calls, i18n.t('common.backShort'))).toBe(true);
    const t = tiles(3);
    // Third tile starts a new row under the first column.
    expect(t[2].x).toBe(t[0].x);
    expect(t[2].y).toBeGreaterThan(t[0].y);
    expect(labelAt(calls, t[0].labelX, t[0].labelY)[1][0]).toBe(i18n.formatDate(new Date(ITEMS[0].at)));
    expect(labelAt(calls, t[2].labelX, t[2].labelY)).toBeTruthy();
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });
});

describe('gallery: input', () => {
  it('tapping Back returns to title (with hover tracked via onMove)', () => {
    gallery.enter();
    gallery.draw();
    const b = back();
    gallery.onMove(b.x, b.y); // hover the button, then redraw + tap
    gallery.draw();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('taps that miss on every side do nothing; non-down events are ignored', () => {
    seed();
    gallery.enter();
    gallery.draw();
    const b = back();
    down(b.x - 200, b.y);  // left of the button
    down(b.x + 200, b.y);  // right of the button
    down(b.x, 2);          // above
    down(b.x, 300);        // below (inside the tile grid — tiles are not buttons)
    gallery.onPointer({ type: 'up', x: b.x, y: b.y });
    gallery.onPointer({ type: 'cancel' });
    expect(setScene).not.toHaveBeenCalled();
  });

  it('exit()/update() are no-ops', () => {
    expect(() => { gallery.exit(); gallery.update(16); }).not.toThrow();
  });
});
