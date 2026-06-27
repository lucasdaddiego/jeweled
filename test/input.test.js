import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// input.js imports screenToCell from render.js, which imports main.js (whose
// import-time init() would boot the whole game under jsdom). Mock main so the
// render import is inert.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

// Fresh modules per test: input keeps pointer state (activePointerId,
// pointerIsDown) at module scope with no reset export, so resetModules gives
// clean isolation. The hoisted main mock is re-applied after each resetModules.
let render, input, cb;

beforeEach(async () => {
  vi.resetModules();
  render = await import('../src/render.js');
  input = await import('../src/input.js');
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  input.setup();
  cb = {
    onTapCell: vi.fn(), onMove: vi.fn(), onUp: vi.fn(),
    onWheel: vi.fn(), onCancel: vi.fn(),
  };
  input.on(cb);
});

const canvas = () => document.getElementById('game');

// An integer point inside grid cell (r,c). Integer so the value survives the
// PointerEvent round-trip and screenToCell maps it back to (r,c).
function cellPoint(r, c, dx = 10, dy = 10) {
  const { boardX, boardY, cellSize } = render.layout;
  return { x: boardX + c * cellSize + dx, y: boardY + r * cellSize + dy };
}
function fire(type, props) { canvas().dispatchEvent(new PointerEvent(type, { bubbles: true, ...props })); }
const down = (x, y, id = 1) => fire('pointerdown', { clientX: x, clientY: y, pointerId: id });
const move = (x, y, id = 1) => fire('pointermove', { clientX: x, clientY: y, pointerId: id });
const up = (x, y, id = 1) => fire('pointerup', { clientX: x, clientY: y, pointerId: id });
const cancel = (x, y, id = 1) => fire('pointercancel', { clientX: x, clientY: y, pointerId: id });

describe('pointer down', () => {
  it('maps the tap to a grid cell and marks the pointer down', () => {
    expect(input.isPointerDown()).toBe(false);
    const p = cellPoint(2, 3);
    down(p.x, p.y);
    expect(cb.onTapCell).toHaveBeenCalledTimes(1);
    expect(cb.onTapCell).toHaveBeenCalledWith({ r: 2, c: 3 }, p.x, p.y);
    expect(input.isPointerDown()).toBe(true);
  });

  it('reports a null cell for a tap outside the board', () => {
    down(3, 4); // top-left of the viewport, before boardX/boardY
    expect(cb.onTapCell).toHaveBeenCalledWith(null, 3, 4);
  });

  it('ignores a second pointer while one is already active (multi-touch guard)', () => {
    const a = cellPoint(0, 0);
    down(a.x, a.y, 1);
    expect(cb.onTapCell).toHaveBeenCalledTimes(1);
    const b = cellPoint(1, 1);
    down(b.x, b.y, 2);           // activePointerId already set -> ignored
    expect(cb.onTapCell).toHaveBeenCalledTimes(1);
  });
});

describe('pointer move', () => {
  it('reports the move coordinates for the active pointer', () => {
    const p = cellPoint(0, 0);
    down(p.x, p.y, 1);
    move(200, 210, 1);
    expect(cb.onMove).toHaveBeenCalledWith(200, 210);
  });

  it('reports moves even with no active pointer (hover, no capture)', () => {
    move(123, 456);             // activePointerId === null -> left of && short-circuits
    expect(cb.onMove).toHaveBeenCalledWith(123, 456);
  });

  it('ignores moves from a different pointer while one is active', () => {
    const p = cellPoint(0, 0);
    down(p.x, p.y, 1);
    cb.onMove.mockClear();
    move(300, 300, 2);          // pointerId 2 !== active 1 -> ignored
    expect(cb.onMove).not.toHaveBeenCalled();
  });
});

describe('pointer up', () => {
  it('reports coordinates and clears the down state', () => {
    const p = cellPoint(0, 0);
    down(p.x, p.y, 1);
    expect(input.isPointerDown()).toBe(true);
    up(150, 160, 1);
    expect(cb.onUp).toHaveBeenCalledWith(150, 160);
    expect(input.isPointerDown()).toBe(false);
  });

  it('ignores an up from a pointer that is not the active one', () => {
    const p = cellPoint(0, 0);
    down(p.x, p.y, 1);
    up(150, 160, 2);            // activePointerId(1) !== 2 -> ignored
    expect(cb.onUp).not.toHaveBeenCalled();
    expect(input.isPointerDown()).toBe(true);
  });
});

describe('pointer cancel', () => {
  it('reports the last seen coordinates and clears the down state', () => {
    const p = cellPoint(1, 1);
    down(p.x, p.y, 1);
    move(p.x + 11, p.y + 12, 1); // updates lastPointerX/Y
    cancel(0, 0, 1);
    expect(cb.onCancel).toHaveBeenCalledWith(p.x + 11, p.y + 12);
    expect(input.isPointerDown()).toBe(false);
  });

  it('ignores a cancel from a non-active pointer', () => {
    const p = cellPoint(1, 1);
    down(p.x, p.y, 1);
    cancel(0, 0, 2);            // e.pointerId(2) !== active(1) -> ignored
    expect(cb.onCancel).not.toHaveBeenCalled();
    expect(input.isPointerDown()).toBe(true);
  });

  it('still fires when no pointer is active (active===null branch)', () => {
    cancel(0, 0, 9);            // activePointerId null: first guard short-circuits
    expect(cb.onCancel).toHaveBeenCalledWith(0, 0);
    expect(input.isPointerDown()).toBe(false);
  });
});

describe('window blur', () => {
  it('cancels an in-flight drag using the last coordinates', () => {
    const p = cellPoint(2, 2);
    down(p.x, p.y, 1);
    expect(input.isPointerDown()).toBe(true);
    window.dispatchEvent(new Event('blur')); // handler calls onPointerCancel() with no event
    expect(cb.onCancel).toHaveBeenCalledTimes(1);
    expect(cb.onCancel).toHaveBeenCalledWith(p.x, p.y);
    expect(input.isPointerDown()).toBe(false);
  });
});

describe('wheel', () => {
  it('reports deltaY + coords and prevents the default page scroll', () => {
    const e = new WheelEvent('wheel', { deltaY: 42, clientX: 7, clientY: 8, cancelable: true, bubbles: true });
    canvas().dispatchEvent(e);
    expect(cb.onWheel).toHaveBeenCalledWith(42, 7, 8);
    expect(e.defaultPrevented).toBe(true);
  });

  it('does not preventDefault when no onWheel handler is registered', () => {
    input.on({ onWheel: null });
    const e = new WheelEvent('wheel', { deltaY: 1, cancelable: true, bubbles: true });
    canvas().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('context menu', () => {
  it('prevents the long-press context menu', () => {
    const e = new Event('contextmenu', { cancelable: true, bubbles: true });
    canvas().dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });
});

describe('no callbacks registered', () => {
  it('every pointer path runs as a no-op without throwing', () => {
    input.on({ onTapCell: null, onMove: null, onUp: null, onWheel: null, onCancel: null });
    const p = cellPoint(3, 3);
    expect(() => {
      down(p.x, p.y, 1);
      move(p.x + 5, p.y, 1);
      up(p.x + 5, p.y, 1);
    }).not.toThrow();
    expect(input.isPointerDown()).toBe(false);
    down(p.x, p.y, 1);
    expect(() => cancel(p.x, p.y, 1)).not.toThrow();
    expect(input.isPointerDown()).toBe(false);
  });
});
