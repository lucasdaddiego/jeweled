import { describe, it, expect, beforeEach, vi } from 'vitest';

// powerupOverlay → render → main; mock main so importing the overlay doesn't
// boot the whole game under jsdom (document.readyState === 'complete').
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as overlay from '../src/scenes/powerupOverlay.js';
import * as render from '../src/render.js';
import * as powerups from '../src/powerups.js';
import * as storage from '../src/storage.js';
import { Cascade, STATE } from '../src/cascade.js';
import { makeEmptyGrid, newCell } from '../src/grid.js';
import { mulberry32 } from '../src/rng.js';
import { POWERUP_SLOTS, POWERUP_MAX_CHARGES, SPECIAL } from '../src/config.js';
import { installCanvas, setViewport } from './helpers.js';

// ---- fixtures ---------------------------------------------------------------

// A full checkerboard (types 2/3) — no standing matches, valid for reshuffle.
function fullGrid() {
  const g = makeEmptyGrid();
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) g[r][c] = newCell((r + c) % 2 ? 2 : 3);
  return g;
}
function makeCascade(g) { return new Cascade(g, { rng: mulberry32(1) }); }

// Mutate the (cached) charge map in place — getCharges() reads this same object.
function setCharges(obj) {
  const ch = storage.load().powerups.charges;
  Object.assign(ch, obj);
}

function cellCenter(r, c) {
  const L = render.layout;
  return { x: L.boardX + c * L.cellSize + L.cellSize / 2, y: L.boardY + r * L.cellSize + L.cellSize / 2 };
}

// Draw the panel and return the pushed hit-rects.
function drawPanel(cursorX = -1, cursorY = -1) {
  const buttons = [];
  overlay.draw(cursorX, cursorY, buttons);
  return buttons;
}
function slotButtons(buttons) { return buttons.filter(b => b.kind === 'powerup'); }
function down(x, y) { return overlay.handlePointer({ type: 'down', x, y }); }

let grid, cascade;

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  render.setPanelWidth(72);   // wide → right-side vertical panel by default
  storage.reset();
  overlay.reset();
  grid = fullGrid();
  cascade = makeCascade(grid);
  overlay.bind(grid, cascade);
});

// ---- bind / reset / simple state -------------------------------------------

describe('bind / unbind / reset', () => {
  it('reset clears all transient panel state', () => {
    overlay.notifyMilestoneEarned(1);
    expect(overlay.isModalOpen()).toBe(true);
    overlay.reset();
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('unbind drops refs and resets state', () => {
    overlay.notifyMilestoneEarned(1);
    overlay.unbind();
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('setMilestoneFloor stores the floor, defaulting falsy to 0', () => {
    // Both branches of `floor || 0`. Observable via the progress ring arg, but
    // here we just assert it doesn't throw and the panel still draws.
    overlay.setMilestoneFloor(3000);
    expect(() => drawPanel()).not.toThrow();
    overlay.setMilestoneFloor();          // undefined → 0
    expect(() => drawPanel()).not.toThrow();
  });

  it('isModalOpen reflects recolor picker, popup, or neither', () => {
    expect(overlay.isModalOpen()).toBe(false);          // neither
    overlay.notifyMilestoneEarned(1);
    expect(overlay.isModalOpen()).toBe(true);           // popup (2nd operand)
    overlay.reset();
    // recolor picker open (1st operand) — set it via a recolor target tap.
    setCharges({ recolor: 1 });
    const btns = slotButtons(drawPanel());
    btns[POWERUP_SLOTS.indexOf('recolor')].onClick();   // pendingPowerup = recolor
    const cc = cellCenter(4, 4);
    down(cc.x, cc.y);                                    // → recolorPickerAt set
    expect(overlay.isModalOpen()).toBe(true);
  });

  it('notifyMilestoneEarned ignores a non-positive count', () => {
    overlay.notifyMilestoneEarned(0);
    expect(overlay.isModalOpen()).toBe(false);
  });
});

// ---- panel drawing ----------------------------------------------------------

describe('panel drawing', () => {
  it('draws the vertical (right) panel and registers one button per slot', () => {
    setCharges({ shuffle: 1, colorBlast: 2 });
    const buttons = slotButtons(drawPanel());
    expect(buttons).toHaveLength(POWERUP_SLOTS.length);
  });

  it('draws the horizontal (bottom) panel on a narrow viewport, hover included', () => {
    setViewport(400, 800, 1);
    render.setupCanvas();
    render.setPanelWidth(72);
    expect(render.layout.panelSide).toBe('bottom');
    const buttons = slotButtons(drawPanel());
    expect(buttons).toHaveLength(POWERUP_SLOTS.length);
    // Redraw with the cursor over a horizontal slot so its hover test runs true.
    const b = buttons[0];
    expect(() => drawPanel(b.x + b.w / 2, b.y + b.h / 2)).not.toThrow();
  });

  it('marks a slot hovered + active when the cursor is over the selected powerup', () => {
    setCharges({ colorBlast: 2 });
    const ci = POWERUP_SLOTS.indexOf('colorBlast');
    slotButtons(drawPanel())[ci].onClick();             // select colorBlast
    const sel = slotButtons(drawPanel())[ci];
    // Redraw with the cursor centred on the active slot → hover && isActive true.
    expect(() => drawPanel(sel.x + sel.w / 2, sel.y + sel.h / 2)).not.toThrow();
  });
});

// ---- slot clicks ------------------------------------------------------------

describe('onPowerupSlotClicked', () => {
  it('does nothing when the slot has no charges', () => {
    const ci = POWERUP_SLOTS.indexOf('colorBlast');
    slotButtons(drawPanel())[ci].onClick();             // 0 charges → no-op
    expect(down(0, 0)).toBe(false);                     // not in target mode
  });

  it('does nothing while the cascade is busy', () => {
    setCharges({ colorBlast: 1 });
    cascade.state = STATE.SWAPPING;
    const ci = POWERUP_SLOTS.indexOf('colorBlast');
    slotButtons(drawPanel())[ci].onClick();
    expect(down(0, 0)).toBe(false);                     // never entered target mode
  });

  it('shuffle spends a charge and reshuffles immediately', () => {
    setCharges({ shuffle: 2 });
    const ids = new Set();
    for (const row of grid) for (const cell of row) ids.add(cell.id);
    const si = POWERUP_SLOTS.indexOf('shuffle');
    slotButtons(drawPanel())[si].onClick();
    expect(powerups.getCharges().shuffle).toBe(1);
    // same gems, reshuffled in place (no target mode entered)
    const after = new Set();
    for (const row of grid) for (const cell of row) after.add(cell.id);
    expect(after).toEqual(ids);
    expect(down(0, 0)).toBe(false);
  });

  it('toggles target mode on and off for a targeted powerup', () => {
    setCharges({ colorBlast: 2 });
    const ci = POWERUP_SLOTS.indexOf('colorBlast');
    slotButtons(drawPanel())[ci].onClick();             // on
    expect(down(0, 0)).toBe(true);                      // pendingPowerup set → handled
    overlay.reset();
    setCharges({ colorBlast: 2 });
    slotButtons(drawPanel())[ci].onClick();             // on
    slotButtons(drawPanel())[ci].onClick();             // off (same slot toggles)
    expect(down(0, 0)).toBe(false);                     // no longer in target mode
  });
});

// ---- target taps ------------------------------------------------------------

describe('handleTargetTap', () => {
  function enterMode(slot, charges = 2) {
    setCharges({ [slot]: charges });
    const i = POWERUP_SLOTS.indexOf(slot);
    slotButtons(drawPanel())[i].onClick();
  }

  it('colorBlast clears the tapped colour and spends a charge', () => {
    enterMode('colorBlast');
    const applySpy = vi.spyOn(cascade, 'applyExternalClears');
    const cc = cellCenter(4, 4);
    expect(down(cc.x, cc.y)).toBe(true);
    expect(powerups.getCharges().colorBlast).toBe(1);
    expect(applySpy).toHaveBeenCalled();
    expect(down(0, 0)).toBe(false);                     // mode cleared after use
  });

  it('colorBlast on an empty cell is a no-op (no charge spent)', () => {
    enterMode('colorBlast');
    grid[4][4] = null;
    const cc = cellCenter(4, 4);
    down(cc.x, cc.y);
    expect(powerups.getCharges().colorBlast).toBe(2);   // unchanged
  });

  it('colorBlast that fails to clear spends nothing (defensive ok:false path)', () => {
    enterMode('colorBlast');
    vi.spyOn(powerups, 'activateColorBlast').mockReturnValue({ ok: false, reason: 'x' });
    const cc = cellCenter(4, 4);
    down(cc.x, cc.y);
    expect(powerups.getCharges().colorBlast).toBe(2);   // not spent
    expect(down(0, 0)).toBe(false);                     // mode cleared
  });

  it('bombDrop converts a gem to an area bomb and spends a charge', () => {
    enterMode('bombDrop');
    const cc = cellCenter(3, 3);
    down(cc.x, cc.y);
    expect(grid[3][3].special).toBe(SPECIAL.AREA_BOMB);
    expect(powerups.getCharges().bombDrop).toBe(1);
  });

  it('bombDrop on an empty cell spends nothing (ok:false path)', () => {
    enterMode('bombDrop');
    grid[3][3] = null;
    const cc = cellCenter(3, 3);
    down(cc.x, cc.y);
    expect(powerups.getCharges().bombDrop).toBe(2);     // unchanged
  });

  it('recolor opens the colour picker for a plain gem', () => {
    enterMode('recolor');
    grid[2][2] = newCell(0);
    const cc = cellCenter(2, 2);
    down(cc.x, cc.y);
    expect(overlay.isModalOpen()).toBe(true);           // recolor picker open
  });

  it('recolor rejects a special gem (invalid target)', () => {
    enterMode('recolor');
    grid[2][2] = newCell(0, SPECIAL.AREA_BOMB);
    const cc = cellCenter(2, 2);
    down(cc.x, cc.y);
    expect(overlay.isModalOpen()).toBe(false);          // no picker opened
  });
});

// ---- recolor picker ---------------------------------------------------------

describe('recolor colour picker', () => {
  function openPicker(type = 0) {
    setCharges({ recolor: 2 });
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('recolor')].onClick();
    grid[2][2] = newCell(type);
    const cc = cellCenter(2, 2);
    down(cc.x, cc.y);                                   // recolorPickerAt = {2,2}
  }
  function colorButtons() {
    const buttons = [];
    overlay.draw(-1, -1, buttons);
    return buttons.filter(b => b.kind === 'colorPick');
  }

  it('recolors to a new colour, spends a charge, and closes the picker', () => {
    openPicker(0);
    const picks = colorButtons();
    picks[3].onClick();                                  // pick colour 3 (≠ 0)
    expect(grid[2][2].type).toBe(3);
    expect(powerups.getCharges().recolor).toBe(1);
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('rejects recolouring to the same colour (no charge spent)', () => {
    openPicker(0);
    const picks = colorButtons();
    picks[0].onClick();                                  // pick colour 0 (== gem)
    expect(grid[2][2].type).toBe(0);
    expect(powerups.getCharges().recolor).toBe(2);      // unchanged
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('a stale colour-pick after the picker closed is a guarded no-op', () => {
    openPicker(0);
    const picks = colorButtons();
    picks[3].onClick();                                  // closes the picker
    expect(() => picks[3].onClick()).not.toThrow();      // recolorPickerAt now null
    expect(powerups.getCharges().recolor).toBe(1);      // not spent a second time
  });
});

// ---- milestone popup --------------------------------------------------------

describe('milestone popup', () => {
  function milestoneButtons() {
    const buttons = [];
    overlay.draw(-1, -1, buttons);
    return buttons.filter(b => b.kind === 'milestone');
  }

  it('allocates an earned charge to a chosen slot and closes when none remain', () => {
    overlay.notifyMilestoneEarned(1);
    const picks = milestoneButtons();
    expect(picks.length).toBeGreaterThan(0);
    picks[0].onClick();                                  // allocate → pending hits 0
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('keeps the popup open while more charges are pending', () => {
    overlay.notifyMilestoneEarned(2);
    milestoneButtons()[0].onClick();                    // pending 2 → 1
    expect(overlay.isModalOpen()).toBe(true);
  });

  it('renders full slots as un-clickable (no button) and dims them', () => {
    setCharges({ shuffle: POWERUP_MAX_CHARGES });        // shuffle full
    overlay.notifyMilestoneEarned(1);
    const picks = milestoneButtons();
    // 4 slots, one full → only 3 clickable buttons.
    expect(picks).toHaveLength(POWERUP_SLOTS.length - 1);
  });

  it('hovers a non-full slot when the cursor is over it', () => {
    overlay.notifyMilestoneEarned(1);
    const b = milestoneButtons()[0];
    const buttons = [];
    expect(() => overlay.draw(b.x + b.w / 2, b.y + b.h / 2, buttons)).not.toThrow();
  });

  it('a stale milestone pick whose slot filled meanwhile is a guarded no-op', () => {
    overlay.notifyMilestoneEarned(2);
    const picks = milestoneButtons();
    const slotOf = picks[0];
    // Fill the slot AFTER drawing its button, before the (stale) click.
    setCharges(Object.fromEntries(POWERUP_SLOTS.map(s => [s, POWERUP_MAX_CHARGES])));
    expect(() => slotOf.onClick()).not.toThrow();        // addCharge → false → early return
    expect(overlay.isModalOpen()).toBe(true);            // pending not decremented
  });
});

// ---- pointer routing --------------------------------------------------------

describe('handlePointer routing', () => {
  it('ignores non-down events', () => {
    expect(overlay.handlePointer({ type: 'move', x: 0, y: 0 })).toBe(false);
    expect(overlay.handlePointer({ type: 'up', x: 0, y: 0 })).toBe(false);
  });

  it('dismisses the milestone popup on a tap', () => {
    overlay.notifyMilestoneEarned(1);
    expect(down(0, 0)).toBe(true);
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('dismisses the recolor picker on a tap', () => {
    setCharges({ recolor: 1 });
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('recolor')].onClick();
    grid[4][4] = newCell(0);
    let cc = cellCenter(4, 4);
    down(cc.x, cc.y);                                    // open picker
    expect(overlay.isModalOpen()).toBe(true);
    expect(down(0, 0)).toBe(true);                       // tap dismisses
    expect(overlay.isModalOpen()).toBe(false);
  });

  it('cancels target mode when tapping outside the board', () => {
    setCharges({ colorBlast: 1 });
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('colorBlast')].onClick();
    expect(down(render.layout.boardX + 5, 0)).toBe(true);  // y above board → no cell
    expect(down(0, 0)).toBe(false);                        // mode cancelled
  });

  it('returns false when nothing is active', () => {
    expect(down(10, 10)).toBe(false);
  });
});

// ---- target-mode overlay drawing -------------------------------------------

describe('target-mode overlay', () => {
  function enterTargetMode() {
    setCharges({ colorBlast: 2 });
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('colorBlast')].onClick();
  }

  it('dims the strips around the board (right-side panel cancel hint)', () => {
    enterTargetMode();
    expect(() => drawPanel(10, 10)).not.toThrow();       // pendingPowerup → overlay drawn
  });

  it('places the cancel hint above the board with a bottom panel', () => {
    setViewport(400, 800, 1);
    render.setupCanvas();
    render.setPanelWidth(72);
    enterTargetMode();
    expect(() => drawPanel(10, 10)).not.toThrow();
  });

  it('skips zero-area dim strips when the board fills the viewport', () => {
    enterTargetMode();
    // Force a board flush to all edges → every `if (strip > 0)` guard is false.
    const { w, h } = render.getViewport();
    render.layout.boardX = 0;
    render.layout.boardY = 0;
    render.layout.boardSize = Math.max(w, h) + 100;
    expect(() => drawPanel(10, 10)).not.toThrow();
  });

  it('reopens the milestone popup after an activation when a charge is pending', () => {
    overlay.notifyMilestoneEarned(1);
    down(0, 0);                                          // dismiss popup, pending stays 1
    expect(overlay.isModalOpen()).toBe(false);
    setCharges({ bombDrop: 1 });
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('bombDrop')].onClick();
    const cc = cellCenter(3, 3);
    down(cc.x, cc.y);                                    // activation → maybeShowSavedMilestone
    expect(overlay.isModalOpen()).toBe(true);
  });

  it('does NOT reopen the popup when no slot is available', () => {
    overlay.notifyMilestoneEarned(1);
    down(0, 0);                                          // pending 1, popup closed
    setCharges({ bombDrop: 1 });
    vi.spyOn(powerups, 'hasAvailableSlot').mockReturnValue(false);
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('bombDrop')].onClick();
    const cc = cellCenter(3, 3);
    down(cc.x, cc.y);
    expect(overlay.isModalOpen()).toBe(false);          // && short-circuit: no slot
  });

  it('does NOT reopen the popup when nothing is pending', () => {
    setCharges({ bombDrop: 1 });
    slotButtons(drawPanel())[POWERUP_SLOTS.indexOf('bombDrop')].onClick();
    const cc = cellCenter(3, 3);
    down(cc.x, cc.y);                                    // pendingMilestones 0
    expect(overlay.isModalOpen()).toBe(false);
  });
});
