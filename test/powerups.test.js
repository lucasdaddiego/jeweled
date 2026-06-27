import { describe, it, expect, beforeEach } from 'vitest';

import * as storage from '../src/storage.js';
import * as powerups from '../src/powerups.js';
import { makeEmptyGrid, newCell, createBoard, hasAnyValidMove } from '../src/grid.js';
import { findMatches } from '../src/matcher.js';
import { mulberry32 } from '../src/rng.js';
import {
  SPECIAL, TYPES, STORAGE_KEY,
  POWERUP_MAX_CHARGES, POWERUP_MILESTONE, POWERUP_SLOTS,
} from '../src/config.js';

// powerups.js reads/writes charges through the storage.js singleton, whose cache
// persists across tests in this file. reset() gives every test a fresh default
// state ({ shuffle:0, colorBlast:0, bombDrop:0, recolor:0 }) and clears any
// pending debounced write so a saveKey() from one test can't bleed into another.
beforeEach(() => {
  storage.reset();
});

// --- small grid fixtures -----------------------------------------------------
function idSet(g) {
  const s = new Set();
  for (const row of g) for (const cell of row) if (cell) s.add(cell.id);
  return s;
}

describe('charge management', () => {
  it('getCharges returns the default all-zero slots', () => {
    expect(powerups.getCharges()).toEqual({ shuffle: 0, colorBlast: 0, bombDrop: 0, recolor: 0 });
  });

  it('canSpend is false on an empty slot and true once it has a charge', () => {
    expect(powerups.canSpend('shuffle')).toBe(false);
    powerups.addCharge('shuffle');
    expect(powerups.canSpend('shuffle')).toBe(true);
  });

  it('isFull is false below the cap and true at it', () => {
    expect(powerups.isFull('shuffle')).toBe(false);
    for (let i = 0; i < POWERUP_MAX_CHARGES; i++) powerups.addCharge('shuffle');
    expect(powerups.isFull('shuffle')).toBe(true);
  });

  it('isFull treats an unknown slot as empty (nullish coalesce)', () => {
    expect(powerups.isFull('does-not-exist')).toBe(false);
  });

  it('hasAvailableSlot is true while any slot has room', () => {
    expect(powerups.hasAvailableSlot()).toBe(true);
  });

  it('hasAvailableSlot is false once every slot is capped', () => {
    for (const slot of POWERUP_SLOTS) {
      for (let i = 0; i < POWERUP_MAX_CHARGES; i++) powerups.addCharge(slot);
    }
    expect(powerups.hasAvailableSlot()).toBe(false);
  });

  it('hasAvailableSlot tolerates a charges object missing a slot', () => {
    // Simulates an older save written before a new slot was added: the slot key
    // is simply absent, so the per-slot `?? 0` fallback must treat it as 0.
    const charges = storage.load().powerups.charges;
    delete charges.shuffle;
    expect(powerups.hasAvailableSlot()).toBe(true);
  });

  it('spendCharge decrements and returns true when a charge exists', () => {
    powerups.addCharge('colorBlast');
    expect(powerups.spendCharge('colorBlast')).toBe(true);
    expect(powerups.getCharges().colorBlast).toBe(0);
  });

  it('spendCharge returns false and changes nothing when empty', () => {
    expect(powerups.spendCharge('colorBlast')).toBe(false);
    expect(powerups.getCharges().colorBlast).toBe(0);
  });

  it('addCharge increments and returns true below the cap', () => {
    expect(powerups.addCharge('bombDrop')).toBe(true);
    expect(powerups.getCharges().bombDrop).toBe(1);
  });

  it('addCharge returns false (no overflow) at the cap', () => {
    for (let i = 0; i < POWERUP_MAX_CHARGES; i++) powerups.addCharge('bombDrop');
    expect(powerups.getCharges().bombDrop).toBe(POWERUP_MAX_CHARGES);
    expect(powerups.addCharge('bombDrop')).toBe(false);
    expect(powerups.getCharges().bombDrop).toBe(POWERUP_MAX_CHARGES);
  });

  it('addCharge initialises an unknown slot from zero (nullish coalesce)', () => {
    expect(powerups.addCharge('mystery')).toBe(true);
    expect(powerups.getCharges().mystery).toBe(1);
  });

  it('persists a gained charge through storage', () => {
    powerups.addCharge('recolor');
    storage.flush(); // force the debounced write through synchronously
    const persisted = JSON.parse(localStorage.getItem(STORAGE_KEY));
    expect(persisted.powerups.charges.recolor).toBe(1);
  });
});

describe('milestone earning math', () => {
  it('uses the configured milestone size', () => {
    // Guards the literal expectations below against a config tuning change.
    expect(POWERUP_MILESTONE).toBe(1500);
  });

  it('milestoneFloorForScore floors to the nearest milestone', () => {
    expect(powerups.milestoneFloorForScore(3200)).toBe(3000);
    expect(powerups.milestoneFloorForScore(1500)).toBe(1500);
    expect(powerups.milestoneFloorForScore(1499)).toBe(0);
  });

  it('milestoneFloorForScore returns 0 for falsy / undefined scores', () => {
    expect(powerups.milestoneFloorForScore(0)).toBe(0);
    expect(powerups.milestoneFloorForScore()).toBe(0);
  });

  it('milestoneFloorForScore clamps a negative score to 0', () => {
    expect(powerups.milestoneFloorForScore(-100)).toBe(0);
  });

  it('consumeRunMilestones counts milestones crossed from the default floor', () => {
    expect(powerups.consumeRunMilestones(3200)).toEqual({ count: 2, floor: 3000 });
  });

  it('consumeRunMilestones reports none when no new milestone is crossed', () => {
    expect(powerups.consumeRunMilestones(1000, 0)).toEqual({ count: 0, floor: 0 });
  });

  it('consumeRunMilestones handles a falsy current score', () => {
    expect(powerups.consumeRunMilestones(0)).toEqual({ count: 0, floor: 0 });
  });

  it('consumeRunMilestones advances incrementally from a prior floor', () => {
    expect(powerups.consumeRunMilestones(4600, 3000)).toEqual({ count: 1, floor: 4500 });
  });

  it('milestoneProgress reports the fraction toward the next milestone', () => {
    expect(powerups.milestoneProgress(750)).toBeCloseTo(0.5, 10);
    expect(powerups.milestoneProgress(0)).toBe(0);
  });

  it('milestoneProgress clamps to [0,1]', () => {
    expect(powerups.milestoneProgress(5000, 0)).toBe(1);    // far past → 1
    expect(powerups.milestoneProgress(100, 1500)).toBe(0);  // below floor → 0
  });
});

describe('activateShuffle', () => {
  it('throws when rng is not a function', () => {
    const g = makeEmptyGrid();
    expect(() => powerups.activateShuffle(g, undefined)).toThrow(TypeError);
  });

  it('reshuffles in place, preserving the gems and leaving a playable board', () => {
    const g = createBoard(mulberry32(1));
    const before = idSet(g);
    const res = powerups.activateShuffle(g, mulberry32(2));
    expect(res).toEqual({ ok: true, message: 'Shuffled' });
    // Same gem objects, just rearranged — nothing created or destroyed.
    expect(idSet(g)).toEqual(before);
    // reshuffle guarantees a board with no standing matches and at least one move.
    expect(findMatches(g, null).cleared.size).toBe(0);
    expect(hasAnyValidMove(g)).toBe(true);
  });
});

describe('activateColorBlast', () => {
  it('collects every cell of the target color (skipping nulls and other colors)', () => {
    const g = makeEmptyGrid();
    g[0][0] = newCell(0);
    g[0][1] = newCell(0);
    g[2][3] = newCell(1); // other color — skipped
    // every other cell is null — skipped
    const res = powerups.activateColorBlast(g, 0);
    expect(res.ok).toBe(true);
    expect([...res.clears].sort()).toEqual(['0,0', '0,1']);
  });

  it('fails when no gem of that color is present', () => {
    const g = makeEmptyGrid();
    g[0][0] = newCell(1);
    expect(powerups.activateColorBlast(g, 5)).toEqual({ ok: false, reason: 'no gems of that color' });
  });
});

describe('activateBombDrop', () => {
  it('converts a gem into an area bomb', () => {
    const g = makeEmptyGrid();
    g[1][1] = newCell(2);
    const res = powerups.activateBombDrop(g, 1, 1);
    expect(res).toEqual({ ok: true, replaced: { r: 1, c: 1, special: SPECIAL.AREA_BOMB, type: 2 } });
    expect(g[1][1].special).toBe(SPECIAL.AREA_BOMB);
  });

  it('fails on an empty cell', () => {
    const g = makeEmptyGrid();
    expect(powerups.activateBombDrop(g, 0, 0)).toEqual({ ok: false, reason: 'empty cell' });
  });
});

describe('activateRecolor', () => {
  it('recolors a plain gem to a new valid color', () => {
    const g = makeEmptyGrid();
    g[1][1] = newCell(0);
    expect(powerups.activateRecolor(g, 1, 1, 3)).toEqual({ ok: true });
    expect(g[1][1].type).toBe(3);
  });

  it('fails on an empty cell', () => {
    const g = makeEmptyGrid();
    expect(powerups.activateRecolor(g, 0, 0, 3)).toEqual({ ok: false, reason: 'empty cell' });
  });

  it('refuses to recolor a special gem', () => {
    const g = makeEmptyGrid();
    g[2][2] = newCell(0, SPECIAL.AREA_BOMB);
    expect(powerups.activateRecolor(g, 2, 2, 3)).toEqual({ ok: false, reason: 'cannot recolor a special gem' });
  });

  it('rejects a negative color index', () => {
    const g = makeEmptyGrid();
    g[3][3] = newCell(0);
    expect(powerups.activateRecolor(g, 3, 3, -1)).toEqual({ ok: false, reason: 'invalid color' });
  });

  it('rejects a color index at or above TYPES', () => {
    const g = makeEmptyGrid();
    g[3][3] = newCell(0);
    expect(powerups.activateRecolor(g, 3, 3, TYPES)).toEqual({ ok: false, reason: 'invalid color' });
  });

  it('rejects recoloring to the same color', () => {
    const g = makeEmptyGrid();
    g[4][4] = newCell(2);
    expect(powerups.activateRecolor(g, 4, 4, 2)).toEqual({ ok: false, reason: 'same color' });
  });
});

describe('isValidTarget', () => {
  it('accepts a plain gem as a recolor target', () => {
    const g = makeEmptyGrid();
    g[1][1] = newCell(0);
    expect(powerups.isValidTarget(g, 1, 1, 'recolor')).toBe(true);
  });

  it('rejects a special gem in recolor mode but accepts it in other modes', () => {
    const g = makeEmptyGrid();
    g[2][2] = newCell(0, SPECIAL.AREA_BOMB);
    expect(powerups.isValidTarget(g, 2, 2, 'recolor')).toBe(false);
    expect(powerups.isValidTarget(g, 2, 2, 'bombDrop')).toBe(true);
  });

  it('rejects an empty cell', () => {
    const g = makeEmptyGrid();
    expect(powerups.isValidTarget(g, 0, 0, 'recolor')).toBe(false);
  });

  it('rejects an out-of-bounds row (optional-chain short-circuit)', () => {
    const g = makeEmptyGrid();
    expect(powerups.isValidTarget(g, 99, 0, 'recolor')).toBe(false);
  });
});
