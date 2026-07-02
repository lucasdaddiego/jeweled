import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport, makeStubCtx, flushRAF, pendingRAFCount, StubOffscreenCanvas } from './helpers.js';

// Break the render.js -> main.js import cycle (main.init() would boot the game
// under jsdom). clockMs is a controllable mock so wobble/pulse math is testable.
vi.mock('../src/main.js', () => ({ clockMs: vi.fn(() => 0), setScene: vi.fn() }));

import * as render from '../src/render.js';
import { clockMs } from '../src/main.js';
import { SPECIAL, GRID, DEFAULT_EMOJI, SHAPES_EMOJI } from '../src/config.js';
import { newCell, makeEmptyGrid } from '../src/grid.js';
import * as debugHud from '../src/debugHud.js';
import * as painting from '../src/painting.js';

// --- helpers ---------------------------------------------------------------

// Build a full 8x8 board exercising every SPECIAL plus the per-cell render
// states drawBoard branches on (renderRow/Col, clearAlpha, scaleX/Y, flashAlpha,
// null cell). Returns the grid.
function buildFullBoard() {
  const g = makeEmptyGrid();
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      g[r][c] = newCell((r + c) % 7);

  // Row 0 — specials A
  g[0][0] = newCell(0, SPECIAL.LINE_H);
  g[0][1] = newCell(1, SPECIAL.LINE_V);
  g[0][2] = newCell(2, SPECIAL.COLOR_BOMB);
  g[0][3] = newCell(3, SPECIAL.AREA_BOMB);
  g[0][4] = newCell(4, SPECIAL.GRAVITY);
  g[0][5] = newCell(5, SPECIAL.TIME_BOMB, 7);   // countdown > 3 -> orange
  g[0][6] = newCell(6, SPECIAL.TIME_BOMB, 2);   // countdown <= 3 -> red
  g[0][7] = newCell(0, SPECIAL.TIME_BOMB, null); // bombCountdown null -> no number

  // Row 1 — specials B + alpha states
  g[1][0] = newCell(1, SPECIAL.WILDCARD);
  g[1][1] = newCell(2, SPECIAL.COIN);        // no Fluent mapping -> OS fallback
  g[1][2] = newCell(3, SPECIAL.FIRE);
  g[1][3] = newCell(4, SPECIAL.LIGHTNING);
  g[1][4] = newCell(5, SPECIAL.STAR);
  g[1][5] = null;                            // !cell -> continue
  g[1][6] = newCell(6); g[1][6].clearAlpha = 0.01; // alpha < 0.02 -> skip
  g[1][7] = newCell(0); g[1][7].clearAlpha = 0.5;  // alpha provided, drawn

  // Row 2 — squash / flash / render offset
  g[2][0] = newCell(1); g[2][0].scaleX = 0.8; g[2][0].flashAlpha = 0.5; // squash + flash>0
  g[2][1] = newCell(2); g[2][1].scaleY = 0.8;                            // squash via sy, flash null
  g[2][2] = newCell(3); g[2][2].scaleX = 0.9; g[2][2].flashAlpha = 0;    // squash + flash<=0
  g[2][3] = newCell(4); g[2][3].flashAlpha = 0.5;                        // no squash + flash>0
  g[2][4] = newCell(5); g[2][4].flashAlpha = 0;                          // no squash + flash<=0
  g[2][5] = newCell(6); g[2][5].renderRow = 4; g[2][5].renderCol = 6;    // render offsets
  g[2][6] = newCell(0, SPECIAL.TIME_PLUS);                               // ⏱ badge (Blitz-only gem)

  return g;
}

// A board of plain gems only (no specials, no squash) so the only translate a
// frame can produce is the board-level screen-shake.
function plainBoard() {
  const g = makeEmptyGrid();
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      g[r][c] = newCell((r + c) % 7);
  return g;
}

function mainCalls() { return render.ctxRef().__calls; }
function names(calls) { return calls.map(c => c[0]); }
function countOf(calls, name) { return calls.filter(c => c[0] === name).length; }

beforeEach(() => {
  clockMs.mockReturnValue(0);
  debugHud.setEnabled(false);
  painting.setEnabled(false);
  installCanvas();
  setViewport(800, 600, 1);
  render.layout.panelSize = 0;     // neutralize cross-test panel leakage
  render.setupCanvas();
  render.buildAtlas();
});

afterEach(() => {
  debugHud.setEnabled(false);
  painting.setEnabled(false);
  vi.unstubAllGlobals();
  document.documentElement.style.removeProperty('--sat');
});

// ---------------------------------------------------------------------------

describe('exported constants / palettes', () => {
  it('GEM_COLORS + derived particle palettes are well-formed', () => {
    expect(render.GEM_COLORS).toHaveLength(7);
    expect(render.GEM_PARTICLE_PALETTES).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      const pal = render.GEM_PARTICLE_PALETTES[i];
      expect(pal).toHaveLength(3);
      expect(pal[0]).toBe(render.GEM_COLORS[i]);
      // shaded variants are valid #rrggbb
      expect(pal[1]).toMatch(/^#[0-9a-f]{6}$/);
      expect(pal[2]).toMatch(/^#[0-9a-f]{6}$/);
    }
    expect(render.MENU_COLUMN_MAX_W).toBe(720);
  });
});

describe('layout / resize', () => {
  it('wide viewport: HUD strip, board centered, no panel', () => {
    expect(render.layout.isNarrow).toBe(false);
    expect(render.layout.hudH).toBe(96);   // wide -> 96 + safeTop(0)
    expect(render.layout.hudY).toBe(22);
    expect(render.layout.cellSize).toBeGreaterThan(0);
    expect(render.getCellSize()).toBe(render.layout.cellSize);
    expect(render.boardRight()).toBe(render.layout.boardX + render.layout.boardSize);
    expect(render.contentRight()).toBe(render.boardRight()); // no panel
  });

  it('narrow viewport sets isNarrow and a shorter HUD', () => {
    setViewport(400, 800, 1);
    render.resize();
    expect(render.layout.isNarrow).toBe(true);
    expect(render.layout.hudH).toBe(80);
  });

  it('safe-area inset (--sat) is added to the HUD offsets', () => {
    document.documentElement.style.setProperty('--sat', '20px');
    render.resize();
    expect(render.layout.safeTop).toBe(20);
    expect(render.layout.hudY).toBe(42);   // 22 + 20
    expect(render.layout.hudH).toBe(116);  // 96 + 20
  });

  it('DPR drives the backing-store size; falls back to 1 when 0', () => {
    setViewport(800, 600, 3);
    render.resize();
    const cv = document.getElementById('game');
    expect(cv.width).toBe(2400);    // 800 * 3
    expect(cv.height).toBe(1800);

    setViewport(800, 600, 0);       // devicePixelRatio 0 -> || 1 fallback
    render.resize();
    expect(cv.width).toBe(800);     // 800 * 1
  });

  it('right-side panel on wide viewport (setPanelWidth)', () => {
    render.setPanelWidth(120);
    expect(render.layout.panelSide).toBe('right');
    expect(render.layout.panelW).toBe(120);
    expect(render.layout.panelH).toBe(0);
    expect(render.contentRight()).toBe(render.layout.panelX + render.layout.panelW);
    expect(render.contentRight()).toBeGreaterThan(render.boardRight());
    render.setPanelWidth(0);
    expect(render.layout.panelW).toBe(0);
    expect(render.contentRight()).toBe(render.boardRight());
  });

  it('bottom panel on narrow viewport', () => {
    setViewport(400, 800, 1);
    render.resize();
    render.setPanelWidth(90);
    expect(render.layout.panelSide).toBe('bottom');
    expect(render.layout.panelH).toBe(90);
    expect(render.layout.panelW).toBe(0);
    expect(render.contentRight()).toBe(render.boardRight()); // bottom panel -> board edge
    render.setPanelWidth(0);
  });

  it('registers a visualViewport resize listener when present', () => {
    const vv = { addEventListener: vi.fn() };
    window.visualViewport = vv;
    render.setupCanvas();
    expect(vv.addEventListener).toHaveBeenCalledWith('resize', expect.any(Function));
    delete window.visualViewport;
  });

  it('scheduleResize debounces via rAF and reruns resize+atlas', () => {
    // first resize event schedules one frame
    window.dispatchEvent(new Event('resize'));
    expect(pendingRAFCount()).toBe(1);
    // second event while one is pending is a no-op (resizeRaf guard)
    window.dispatchEvent(new Event('resize'));
    expect(pendingRAFCount()).toBe(1);
    // draining runs the scheduled resize+buildAtlas and clears the guard
    flushRAF();
    expect(pendingRAFCount()).toBe(0);
    // guard cleared -> a new event schedules again
    window.dispatchEvent(new Event('resize'));
    expect(pendingRAFCount()).toBe(1);
  });
});

describe('coordinate helpers + simple getters', () => {
  it('screenToCell maps inside hits and rejects out-of-bounds', () => {
    const { boardX, boardY, cellSize: cs } = render.layout;
    expect(render.screenToCell(boardX + cs * 1.5, boardY + cs * 2.5)).toEqual({ r: 2, c: 1 });
    expect(render.screenToCell(boardX - 1, boardY + cs)).toBeNull();           // c < 0
    expect(render.screenToCell(boardX + cs * GRID + 1, boardY + cs)).toBeNull(); // c >= GRID
    expect(render.screenToCell(boardX + cs, boardY - 1)).toBeNull();           // r < 0
    expect(render.screenToCell(boardX + cs, boardY + cs * GRID + 1)).toBeNull(); // r >= GRID
  });

  it('getViewport / boardCenterX / clearFrame / ctxRef', () => {
    expect(render.getViewport()).toEqual({ w: 800, h: 600 });
    expect(render.boardCenterX()).toBe(render.layout.boardX + render.layout.boardSize / 2);
    render.clearFrame();
    expect(names(mainCalls())).toContain('clearRect');
    expect(render.ctxRef()).toBe(document.getElementById('game').getContext('2d'));
  });

  it('responsiveFont scales down only when narrow', () => {
    expect(render.responsiveFont(20)).toBe(20);          // wide -> unchanged
    setViewport(400, 800, 1); render.resize();
    expect(render.responsiveFont(20)).toBe(15);          // floor(20*0.78)=15, max(14,15)
    expect(render.responsiveFont(10)).toBe(14);          // floor(7.8)=7, clamped to min 14
  });

  it('menuColumn centers a clamped content column', () => {
    const wide = render.menuColumn();
    expect(wide.w).toBe(720);                             // clamped to MENU_COLUMN_MAX_W
    expect(wide.x).toBe(Math.floor((800 - 720) / 2));
    expect(wide.right).toBe(wide.x + wide.w);
    setViewport(400, 800, 1); render.resize();
    const narrow = render.menuColumn();
    expect(narrow.w).toBe(400 - 32);                     // viewportW - 32
  });
});

describe('HUD helpers', () => {
  it('drawText honors defaults and explicit opts (incl. shadow)', () => {
    render.drawText('plain', 10, 10);
    expect(mainCalls().some(c => c[0] === 'fillText' && c[1][0] === 'plain')).toBe(true);

    render.drawText('fancy', 10, 40, {
      font: '12px x', color: '#abcabc', align: 'center', baseline: 'middle', shadow: true,
    });
    expect(mainCalls().some(c => c[0] === 'fillText' && c[1][0] === 'fancy')).toBe(true);
    // shadow path set the shadow color (stub restore is a no-op, so it persists)
    expect(render.ctxRef().shadowColor).toBe('rgba(0,0,0,0.7)');
  });

  it('roundRect builds a clamped rounded path', () => {
    const ctx = makeStubCtx();
    render.roundRect(ctx, 0, 0, 100, 40, 12);
    const ns = names(ctx.__calls);
    expect(ns).toContain('beginPath');
    expect(ns).toContain('quadraticCurveTo');
    expect(ns).toContain('closePath');
    // radius is clamped to half the short side without throwing
    render.roundRect(ctx, 0, 0, 10, 10, 999);
    expect(countOf(ctx.__calls, 'quadraticCurveTo')).toBe(8); // 4 corners x 2 calls
  });

  it('ellipsize: fits (cache miss then hit) vs truncates, and null text', () => {
    const ctx = makeStubCtx(); // measureText(s) => s.length*6
    expect(render.ellipsize(ctx, 'Hi', 30)).toBe('Hi');
    const after1 = countOf(ctx.__calls, 'measureText');
    expect(render.ellipsize(ctx, 'Hi', 30)).toBe('Hi');          // cache hit
    expect(countOf(ctx.__calls, 'measureText')).toBe(after1);    // no new measure
    expect(render.ellipsize(ctx, 'ABCDEFGHIJ', 30)).toBe('ABCD…'); // 5*6=30 fits
    expect(render.ellipsize(ctx, null, 30)).toBe('');            // text ?? ''
    expect(render.ellipsize(ctx, 123, 4000)).toBe('123');        // number coerced, fits
  });

  it('ellipsize soft-caps the cache at 256 entries (clear on overflow)', () => {
    const ctx = makeStubCtx();
    for (let i = 0; i < 300; i++) render.ellipsize(ctx, 'label-' + i, 50);
    // still correct after the overflow clear
    expect(render.ellipsize(ctx, 'x', 50)).toBe('x');
  });

  it('fillTextEllipsized draws the ellipsized text', () => {
    const ctx = makeStubCtx();
    render.fillTextEllipsized(ctx, 'ABCDEFGHIJ', 5, 5, 30);
    expect(ctx.__calls.some(c => c[0] === 'fillText' && c[1][0] === 'ABCD…')).toBe(true);
  });

  it('drawButton covers every style branch', () => {
    const draw = (label, opts) => render.drawButton(20, 20, 160, 48, label, opts);
    draw('default', {});                                   // default fill, no press
    draw('hover', { hover: true });                        // hover fill
    draw('pressed', { pressed: true });                   // pressed fill + scale
    draw('press+dis', { pressed: true, disabled: true }); // pressed && !disabled === false
    draw('disabled', { disabled: true });                 // disabled fill + #888 text
    draw('sub', { subtitle: 'tagline' });                 // two-line, default font
    draw('subFont', { subtitle: 'tagline', font: '14px x' }); // two-line, opts.font
    draw('font', { font: '14px x' });                     // single-line, opts.font
    const ns = names(mainCalls());
    expect(ns).toContain('fill');
    expect(ns).toContain('stroke');
    expect(mainCalls().some(c => c[0] === 'fillText' && c[1][0] === 'tagline')).toBe(true);
    expect(mainCalls().some(c => c[0] === 'scale')).toBe(true); // press depress
  });

  it('drawHitButton computes hover via the cursor and pushes a hit rect', () => {
    const buttons = [];
    const click = () => {};
    const X = 100, Y = 100, W = 80, H = 40;
    render.drawHitButton(X, Y, W, H, 'in', click, buttons, 140, 120);    // inside -> hover
    render.drawHitButton(X, Y, W, H, 'l', click, buttons, 90, 120);      // x < left
    render.drawHitButton(X, Y, W, H, 'r', click, buttons, 200, 120);     // x > right
    render.drawHitButton(X, Y, W, H, 't', click, buttons, 140, 90);      // y < top
    render.drawHitButton(X, Y, W, H, 'b', click, buttons, 140, 160, { kind: 'k', modal: true });
    expect(buttons).toHaveLength(5);
    expect(buttons[0]).toMatchObject({ x: X, y: Y, w: W, h: H, onClick: click });
    expect(buttons[4]).toMatchObject({ kind: 'k', modal: true });
  });

  it('drawPowerupSlot covers active/hover/charged/empty + ring states', () => {
    // activeMode + partial ring + some charges
    const rect = render.drawPowerupSlot(10, 10, 60, 70, '🔀', '#7c3aed', 2, 0.5, false, true);
    expect(rect).toEqual({ x: 10, y: 10, w: 60, h: 70 });
    // hover, full progress (ring suppressed at 1), max charges
    render.drawPowerupSlot(10, 90, 60, 70, '💥', '#ff5722', 3, 1, true, false);
    // charged, no progress
    render.drawPowerupSlot(10, 170, 60, 70, '🧨', '#ff8a3d', 1, 0, false, false);
    // empty (alpha 0.4) + partial ring
    render.drawPowerupSlot(10, 250, 60, 70, '🎯', '#26c6da', 0, 0.5, false, false);
    const ns = names(mainCalls());
    expect(ns).toContain('arc');       // ring + charge dots
    expect(ns).toContain('fill');
    expect(mainCalls().some(c => c[0] === 'fillText' && c[1][0] === '🔀')).toBe(true);
  });
});

describe('drawBoard + specials + effects', () => {
  it('draws background, all gems and every special overlay', () => {
    const g = buildFullBoard();
    render.drawBoard(g, {});
    const calls = mainCalls();
    // bg blit + 1 atlas drawImage per visible gem + overlay drawImages + vignette
    expect(countOf(calls, 'drawImage')).toBeGreaterThan(20);
    // TIME_BOMB countdown numbers drawn live on top of the baked badge
    expect(calls.some(c => c[0] === 'fillText' && c[1][0] === '7')).toBe(true);
    expect(calls.some(c => c[0] === 'fillText' && c[1][0] === '2')).toBe(true);
    // AREA_BOMB / WILDCARD / COIN etc. badges -> rounded-square fillText fallback
    // (Fluent never resolves under jsdom) OR drawImage of the cached badge layer.
    expect(countOf(calls, 'save')).toBeGreaterThan(0);
    expect(countOf(calls, 'restore')).toBeGreaterThan(0);
  });

  it('second identical frame hits all the layer caches', () => {
    const g = buildFullBoard();
    render.drawBoard(g, {});
    const firstImages = countOf(mainCalls(), 'drawImage');
    render.drawBoard(g, {});
    // cache hits still blit the same number of images on the second frame
    expect(countOf(mainCalls(), 'drawImage')).toBe(firstImages * 2);
  });

  it('screen shake translates the board when shakeAmp is significant', () => {
    const g = plainBoard(); // plain gems -> the only translate would be the shake
    const t0 = countOf(mainCalls(), 'translate');
    render.drawBoard(g, { shakeAmp: 0.05 });               // below 0.1 threshold
    const t1 = countOf(mainCalls(), 'translate');
    render.drawBoard(g, { shakeAmp: 8 });                  // above threshold
    const t2 = countOf(mainCalls(), 'translate');
    expect(t1 - t0).toBe(0);   // tiny shake -> no translate
    expect(t2 - t1).toBe(1);   // significant shake -> exactly one board translate
  });

  it('idle wobble rotates the board after 5s of inactivity', () => {
    const g = buildFullBoard();
    clockMs.mockReturnValue(600);            // non-zero so sin() != 0
    render.drawBoard(g, { idleMs: 9000 });
    expect(names(mainCalls())).toContain('rotate');
  });

  it('no wobble below the idle threshold', () => {
    const g = buildFullBoard();
    clockMs.mockReturnValue(600);
    render.drawBoard(g, { idleMs: 3000 });
    expect(names(mainCalls())).not.toContain('rotate');
  });

  it('hint highlight rings the two hinted gems', () => {
    const g = buildFullBoard();
    clockMs.mockReturnValue(250);
    render.drawBoard(g, { hint: { a: { r: 0, c: 0 }, b: { r: 3, c: 3 } } });
    const calls = mainCalls();
    expect(names(calls)).toContain('strokeRect'); // expanding glow ring
    expect(names(calls)).toContain('fillRect');   // body pulse
  });

  it('debug counter increments only when debug HUD is enabled', () => {
    const g = buildFullBoard();
    debugHud.setEnabled(true);
    const before = debugHud.counters.drawBoard;
    render.drawBoard(g, {});
    expect(debugHud.counters.drawBoard).toBe(before + 1);
    debugHud.setEnabled(false);
    const held = debugHud.counters.drawBoard;
    render.drawBoard(g, {});
    expect(debugHud.counters.drawBoard).toBe(held); // not incremented
  });

  it('painting layer is composited under the gems when enabled', () => {
    const g = buildFullBoard();
    painting.init(64, 64);
    painting.setEnabled(true);
    const before = countOf(mainCalls(), 'drawImage');
    render.drawBoard(g, {});
    expect(countOf(mainCalls(), 'drawImage')).toBeGreaterThan(before);
    painting.setEnabled(false);
  });

  it('clips the gem layer to the board frame', () => {
    render.drawBoard(plainBoard(), {});
    const calls = mainCalls();
    expect(names(calls)).toContain('clip');
    // The clip path is the board rect grown by the 8px frame pad.
    const rect = calls.find(c => c[0] === 'rect');
    const { boardX, boardY, boardSize } = render.layout;
    expect(rect[1]).toEqual([boardX - 8, boardY - 8, boardSize + 16, boardSize + 16]);
  });

  it('iceMap draws a frost overlay (round rect + strokes + crack) per iced cell', () => {
    const g = plainBoard();
    const iceMap = Array.from({ length: GRID }, () => Array(GRID).fill(0));
    render.drawBoard(g, { iceMap });                 // all zeros → no frost drawn
    const q0 = countOf(mainCalls(), 'quadraticCurveTo');
    const s0 = countOf(mainCalls(), 'stroke');
    expect(q0).toBe(0);                              // plain gems never round-rect

    iceMap[2][3] = 1;
    iceMap[5][5] = 2;                                // layer count > 1 still one overlay
    render.drawBoard(g, { iceMap });
    const calls = mainCalls();
    // 2 iced cells × one roundRect frost pane (4 corner curves each).
    expect(countOf(calls, 'quadraticCurveTo') - q0).toBe(8);
    // Each pane strokes twice: frost border + crack marks.
    expect(countOf(calls, 'stroke') - s0).toBe(4);
    // Crack polyline starts at (x + cs*0.3, y + cs*0.25) of the iced cell.
    const cs = render.layout.cellSize;
    const x = render.layout.boardX + 3 * cs, y = render.layout.boardY + 2 * cs;
    expect(calls.some(c => c[0] === 'moveTo'
      && c[1][0] === x + cs * 0.3 && c[1][1] === y + cs * 0.25)).toBe(true);
  });

  it('drawBoardBg blits the cached background layer', () => {
    render.clearFrame();
    render.drawBoardBg();
    expect(names(mainCalls())).toContain('drawImage');
  });

  it('buildAtlas re-entry reuses the in-flight Fluent load (no duplicate Image)', () => {
    // beforeEach already built once; building again while loads are pending
    // exercises loadFluent's in-flight short-circuit without throwing.
    expect(() => { render.buildAtlas(); render.buildAtlas(); }).not.toThrow();
  });
});

describe('setGemStyle', () => {
  it('rebuilds the atlas with SHAPES_EMOJI, is idempotent, and swaps back', () => {
    // Count atlas rebuilds by recording every OffscreenCanvas construction.
    const made = [];
    class CountingOC extends StubOffscreenCanvas {
      constructor(w, h) { super(w, h); made.push(this); }
    }
    vi.stubGlobal('OffscreenCanvas', CountingOC);

    render.setGemStyle('shapes');            // color → shapes: one rebuild
    expect(made).toHaveLength(1);
    const shapeCtx = made[0].getContext('2d');
    // The atlas is seeded with the OS-emoji fallback glyphs of the ACTIVE set
    // (Fluent SVGs never resolve under jsdom), one slot per gem type — except
    // the 🌙 token, which is vector-painted (backing disc + carved crescent)
    // instead of relying on the dark, off-center OS glyph.
    for (const emoji of SHAPES_EMOJI) {
      if (emoji === '🌙') continue;
      expect(shapeCtx.__calls.some(c => c[0] === 'fillText' && c[1][0] === emoji)).toBe(true);
    }
    expect(shapeCtx.__calls.some(c => c[0] === 'fillText' && c[1][0] === '🌙')).toBe(false);
    const slotPx = made[0].height;
    const moonSlot = SHAPES_EMOJI.indexOf('🌙');
    const moonCx = moonSlot * slotPx + slotPx / 2;
    // Backing disc + moon disc arcs centered in the slot, plus the offset
    // carve arc — three arcs total for the token.
    const tokenArcs = shapeCtx.__calls.filter(c => c[0] === 'arc'
      && c[1][0] >= moonSlot * slotPx && c[1][0] < (moonSlot + 1) * slotPx);
    expect(tokenArcs.length).toBe(3);
    expect(tokenArcs.some(c => Math.abs(c[1][0] - moonCx) < 0.5 && Math.abs(c[1][1] - slotPx / 2) < 0.5)).toBe(true);
    expect(made[0].width).toBe(made[0].height * SHAPES_EMOJI.length);

    render.setGemStyle('shapes');            // same style → no rebuild
    expect(made).toHaveLength(1);

    render.setGemStyle('color');             // back to the default set: rebuild
    expect(made).toHaveLength(2);
    const colorCtx = made[1].getContext('2d');
    expect(colorCtx.__calls.some(c => c[0] === 'fillText' && c[1][0] === DEFAULT_EMOJI[0])).toBe(true);
    expect(colorCtx.__calls.some(c => c[0] === 'fillText' && c[1][0] === SHAPES_EMOJI[2])).toBe(false);

    render.setGemStyle('color');             // idempotent in the default direction too
    expect(made).toHaveLength(2);
  });

  it('any non-"shapes" value maps to the default glyph set (no rebuild churn)', () => {
    const made = [];
    class CountingOC extends StubOffscreenCanvas {
      constructor(w, h) { super(w, h); made.push(this); }
    }
    vi.stubGlobal('OffscreenCanvas', CountingOC);
    render.setGemStyle(undefined);           // settings default / missing value
    render.setGemStyle('color');
    expect(made).toHaveLength(0);            // already on DEFAULT_EMOJI → no-ops
  });
});

describe('buildAtlas guard', () => {
  it('skips rebuild when cellSize is non-positive', () => {
    render.layout.cellSize = 0;
    expect(() => render.buildAtlas()).not.toThrow();
    expect(render.getCellSize()).toBe(0);
    // the previously-built atlas is still usable: a draw with the prior atlas
    // does not throw.
    render.layout.cellSize = 64;
    render.resize();
    render.buildAtlas();
  });
});
