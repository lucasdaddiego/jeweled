import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// dragInput.js imports render.js (-> main.js) plus cascade STATE and config.
// Mock main so importing render never boots the game.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as drag from '../src/dragInput.js';
import { STATE } from '../src/cascade.js';
import { GRID } from '../src/config.js';

// bind() resets the module's `active`, so re-binding in beforeEach fully clears
// drag state between cases (no resetModules needed — dragInput attaches no
// listeners of its own).
let grid, cascade;

function makeGrid() {
  const g = [];
  for (let r = 0; r < GRID; r++) {
    g[r] = [];
    for (let c = 0; c < GRID; c++) g[r][c] = { type: (r + c) % 7 };
  }
  return g;
}

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.layout.panelSize = 0;     // neutralize cross-test panel leakage
  render.setupCanvas();
  render.buildAtlas();
  grid = makeGrid();
  cascade = { state: STATE.IDLE, tryStartSwap: vi.fn(), bounceBack: vi.fn() };
  drag.bind(grid, cascade);
});

// Centre of grid cell (r,c). dragInput consumes raw numbers (not DOM events),
// so fractional pixel coords are fine and screenToCell floors them correctly.
function center(r, c) {
  const { boardX, boardY, cellSize } = render.layout;
  return { x: boardX + c * cellSize + cellSize / 2, y: boardY + r * cellSize + cellSize / 2 };
}
const cs = () => render.getCellSize();
function startDrag(r, c) {
  const p = center(r, c);
  drag.handle('down', p.x, p.y);
  return p;
}

describe('handle() routing', () => {
  it('routes down / cancel and ignores unknown event types', () => {
    const p = center(1, 1);
    drag.handle('down', p.x, p.y);
    expect(grid[1][1].scaleX).toBe(1.08);   // down ran
    drag.handle('sideways', p.x, p.y);       // unknown -> no branch matches
    drag.handle('cancel');
    expect(grid[1][1].scaleX).toBe(1);       // cancel ran
  });
});

describe('down', () => {
  it('lifts the gem under an occupied cell while idle', () => {
    startDrag(3, 4);
    expect(grid[3][4].scaleX).toBe(1.08);
    expect(grid[3][4].scaleY).toBe(1.08);
  });

  it('does nothing when grid is unbound', () => {
    drag.bind(null, cascade);
    const p = center(0, 0);
    expect(() => drag.handle('down', p.x, p.y)).not.toThrow();
    expect(grid[0][0].scaleX).toBeUndefined();
  });

  it('does nothing when cascade is unbound', () => {
    drag.bind(grid, null);
    const p = center(0, 0);
    drag.handle('down', p.x, p.y);
    expect(grid[0][0].scaleX).toBeUndefined();
  });

  it('does nothing while the cascade is not IDLE', () => {
    cascade.state = STATE.RESOLVING;
    drag.bind(grid, cascade);
    const p = center(0, 0);
    drag.handle('down', p.x, p.y);
    expect(grid[0][0].scaleX).toBeUndefined();
  });

  it('does nothing for a tap off the board', () => {
    drag.handle('down', 2, 2);   // screenToCell -> null
    drag.move(100, 100);          // no active drag -> move is a no-op
    expect(grid[0][0].renderCol).toBeUndefined();
  });

  it('does nothing on an empty (null) grid cell', () => {
    grid[2][2] = null;
    const p = center(2, 2);
    expect(() => drag.handle('down', p.x, p.y)).not.toThrow();
    drag.move(p.x + cs(), p.y);   // active never set -> no render override
    expect(grid[2][3].renderCol).toBeUndefined();
  });
});

describe('move (dominant-axis lock + edge bounds)', () => {
  it('horizontal drag offsets the column, clamped to one cell', () => {
    const p = startDrag(4, 4);
    drag.move(p.x + cs() * 2, p.y);   // dx=2 -> clamp 1
    expect(grid[4][4].renderCol).toBe(5);
    expect(grid[4][4].renderRow).toBe(4);
  });

  it('vertical drag offsets the row, clamped to one cell', () => {
    const p = startDrag(4, 4);
    drag.move(p.x, p.y + cs() * 2);   // dy=2 -> clamp 1
    expect(grid[4][4].renderRow).toBe(5);
    expect(grid[4][4].renderCol).toBe(4);
  });

  it('interior left drag offsets the column negatively', () => {
    const p = startDrag(4, 4);
    drag.move(p.x - cs() * 2, p.y);
    expect(grid[4][4].renderCol).toBe(3);
  });

  it('interior up drag offsets the row negatively', () => {
    const p = startDrag(4, 4);
    drag.move(p.x, p.y - cs() * 2);
    expect(grid[4][4].renderRow).toBe(3);
  });

  it('cannot drag right past the right edge', () => {
    const p = startDrag(4, GRID - 1);
    drag.move(p.x + cs(), p.y);        // mx>0 at rightmost column -> forced 0
    expect(grid[4][GRID - 1].renderCol).toBe(GRID - 1);
  });

  it('cannot drag left past the left edge', () => {
    const p = startDrag(4, 0);
    drag.move(p.x - cs(), p.y);        // mx<0 at column 0 -> forced 0
    expect(grid[4][0].renderCol).toBe(0);
  });

  it('cannot drag down past the bottom edge', () => {
    const p = startDrag(GRID - 1, 4);
    drag.move(p.x, p.y + cs());        // my>0 at bottom row -> forced 0
    expect(grid[GRID - 1][4].renderRow).toBe(GRID - 1);
  });

  it('cannot drag up past the top edge', () => {
    const p = startDrag(0, 4);
    drag.move(p.x, p.y - cs());        // my<0 at row 0 -> forced 0
    expect(grid[0][4].renderRow).toBe(0);
  });

  it('is a no-op with no active drag', () => {
    expect(() => drag.move(100, 100)).not.toThrow();
  });
});

describe('up (commit / bounce)', () => {
  it('cleans up without swapping when the cascade left IDLE between down and up', () => {
    const p = startDrag(4, 4);
    drag.move(p.x + cs(), p.y);
    cascade.state = STATE.SWAPPING;   // resolution kicked in mid-drag
    drag.handle('up', p.x + cs(), p.y);
    expect(cascade.tryStartSwap).not.toHaveBeenCalled();
    const cell = grid[4][4];
    expect(cell.renderRow).toBeNull();
    expect(cell.renderCol).toBeNull();
    expect(cell.scaleX).toBe(1);
    expect(cell.scaleY).toBe(1);
  });

  it('commits a swap to the right past the threshold', () => {
    const p = startDrag(4, 4);
    drag.handle('up', p.x + cs() * 0.5, p.y);
    expect(cascade.tryStartSwap).toHaveBeenCalledWith({ r: 4, c: 4 }, { r: 4, c: 5 });
  });

  it('commits a swap to the left', () => {
    const p = startDrag(4, 4);
    drag.handle('up', p.x - cs() * 0.5, p.y);
    expect(cascade.tryStartSwap).toHaveBeenCalledWith({ r: 4, c: 4 }, { r: 4, c: 3 });
  });

  it('commits a swap downward', () => {
    const p = startDrag(4, 4);
    drag.handle('up', p.x, p.y + cs() * 0.5);
    expect(cascade.tryStartSwap).toHaveBeenCalledWith({ r: 4, c: 4 }, { r: 5, c: 4 });
  });

  it('commits a swap upward', () => {
    const p = startDrag(4, 4);
    drag.handle('up', p.x, p.y - cs() * 0.5);
    expect(cascade.tryStartSwap).toHaveBeenCalledWith({ r: 4, c: 4 }, { r: 3, c: 4 });
  });

  it('resets the lift scale on commit', () => {
    const p = startDrag(4, 4);
    drag.handle('up', p.x + cs() * 0.5, p.y);
    expect(grid[4][4].scaleX).toBe(1);
    expect(grid[4][4].scaleY).toBe(1);
  });

  it('bounces back on a too-small horizontal drag', () => {
    const p = startDrag(4, 4);
    drag.move(p.x + cs() * 0.2, p.y);
    drag.handle('up', p.x + cs() * 0.2, p.y); // |dx| < COMMIT_THRESHOLD -> no target
    expect(cascade.tryStartSwap).not.toHaveBeenCalled();
    expect(cascade.bounceBack).toHaveBeenCalledWith({ r: 4, c: 4 });
  });

  it('bounces back on a too-small vertical drag', () => {
    const p = startDrag(4, 4);
    drag.handle('up', p.x, p.y + cs() * 0.1); // vertical, below threshold
    expect(cascade.bounceBack).toHaveBeenCalledWith({ r: 4, c: 4 });
  });

  it('bounces back when the target falls off the right edge', () => {
    const p = startDrag(4, GRID - 1);
    drag.handle('up', p.x + cs() * 0.5, p.y);  // target c = GRID -> out of bounds
    expect(cascade.tryStartSwap).not.toHaveBeenCalled();
    expect(cascade.bounceBack).toHaveBeenCalledWith({ r: 4, c: GRID - 1 });
  });

  it('bounces back when the target falls off the left edge', () => {
    const p = startDrag(4, 0);
    drag.handle('up', p.x - cs() * 0.5, p.y);  // target c = -1
    expect(cascade.bounceBack).toHaveBeenCalledWith({ r: 4, c: 0 });
  });

  it('bounces back when the target falls off the bottom edge', () => {
    const p = startDrag(GRID - 1, 4);
    drag.handle('up', p.x, p.y + cs() * 0.5);  // target r = GRID
    expect(cascade.bounceBack).toHaveBeenCalledWith({ r: GRID - 1, c: 4 });
  });

  it('bounces back when the target falls off the top edge', () => {
    const p = startDrag(0, 4);
    drag.handle('up', p.x, p.y - cs() * 0.5);  // target r = -1
    expect(cascade.bounceBack).toHaveBeenCalledWith({ r: 0, c: 4 });
  });

  it('falls back to clearing render state when the cascade has no bounceBack', () => {
    const noBounce = { state: STATE.IDLE, tryStartSwap: vi.fn() }; // no bounceBack fn
    drag.bind(grid, noBounce);
    const p = center(4, 4);
    drag.handle('down', p.x, p.y);
    drag.move(p.x + cs() * 0.2, p.y);
    drag.handle('up', p.x + cs() * 0.2, p.y);  // below threshold -> else-if branch
    expect(noBounce.tryStartSwap).not.toHaveBeenCalled();
    expect(grid[4][4].renderRow).toBeNull();
    expect(grid[4][4].renderCol).toBeNull();
  });

  it('is a no-op with no active drag', () => {
    expect(() => drag.handle('up', 100, 100)).not.toThrow();
    expect(cascade.tryStartSwap).not.toHaveBeenCalled();
    expect(cascade.bounceBack).not.toHaveBeenCalled();
  });
});

describe('cancel', () => {
  it('clears the dragged gem render + scale state', () => {
    const p = startDrag(2, 2);
    drag.move(p.x + cs(), p.y);
    const cell = grid[2][2];
    expect(cell.scaleX).toBe(1.08);
    drag.handle('cancel');
    expect(cell.renderRow).toBeNull();
    expect(cell.renderCol).toBeNull();
    expect(cell.scaleX).toBe(1);
    expect(cell.scaleY).toBe(1);
  });

  it('is a no-op with no active drag', () => {
    expect(() => drag.cancel()).not.toThrow();
  });
});

describe('bind / unbind', () => {
  it('unbind clears an in-progress drag and detaches grid + cascade', () => {
    const p = startDrag(3, 3);
    drag.move(p.x + cs(), p.y);
    const cell = grid[3][3];
    drag.unbind();
    expect(cell.renderRow).toBeNull();
    expect(cell.renderCol).toBeNull();
    expect(cell.scaleX).toBe(1);
    // grid detached -> a subsequent down does nothing
    const q = center(0, 0);
    drag.handle('down', q.x, q.y);
    expect(grid[0][0].scaleX).toBeUndefined();
  });

  it('unbind with no active drag is safe', () => {
    drag.bind(grid, cascade); // active reset to null
    expect(() => drag.unbind()).not.toThrow();
  });
});
