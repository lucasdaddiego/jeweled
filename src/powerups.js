// Power-up state + activation functions.
// Storage-backed charges, milestone-driven earning, target-based activations.

import { GRID, SPECIAL, POWERUP_MILESTONE, POWERUP_MAX_CHARGES, POWERUP_SLOTS, TYPES } from './config.js';
import * as storage from './storage.js';
import { swap as gridSwap, reshuffle, hasAnyValidMove } from './grid.js';
import { findMatches } from './matcher.js';

// === Charge management ===

export function getCharges() {
  return storage.load().powerups.charges;
}

export function canSpend(slot) {
  return getCharges()[slot] > 0;
}

export function isFull(slot) {
  return (getCharges()[slot] ?? 0) >= POWERUP_MAX_CHARGES;
}

export function hasAvailableSlot() {
  const charges = getCharges();
  return POWERUP_SLOTS.some(slot => (charges[slot] ?? 0) < POWERUP_MAX_CHARGES);
}

export function spendCharge(slot) {
  const state = storage.load();
  if (state.powerups.charges[slot] > 0) {
    state.powerups.charges[slot]--;
    storage.saveKey('powerups', state.powerups);
    return true;
  }
  return false;
}

export function addCharge(slot) {
  const state = storage.load();
  const cur = state.powerups.charges[slot] ?? 0;
  if (cur >= POWERUP_MAX_CHARGES) return false;
  state.powerups.charges[slot] = Math.min(POWERUP_MAX_CHARGES, cur + 1);
  storage.saveKey('powerups', state.powerups);
  return true;
}

// === Earning ===
export function milestoneFloorForScore(score) {
  return Math.max(0, Math.floor((score || 0) / POWERUP_MILESTONE) * POWERUP_MILESTONE);
}

// Returns { count, floor } for run-local milestones crossed since `lastFloor`.
export function consumeRunMilestones(currentScore, lastFloor = 0) {
  const delta = Math.floor(((currentScore || 0) - lastFloor) / POWERUP_MILESTONE);
  if (delta <= 0) return { count: 0, floor: lastFloor };
  return { count: delta, floor: lastFloor + delta * POWERUP_MILESTONE };
}

// How close are we to the next run-local milestone? Returns 0..1.
export function milestoneProgress(currentScore, lastFloor = 0) {
  return Math.min(1, Math.max(0, ((currentScore || 0) - lastFloor) / POWERUP_MILESTONE));
}

// === Activations ===
//
// Each activation returns either:
//   { ok: true, clears?: Set<"r,c">, replaced?: {r,c,special,type}, message?: string }
//   { ok: false, reason: string }
// The scene is responsible for triggering the cascade resolution on the returned clears.

// `rng` is required (no default) so a caller can't silently drop the seeded
// rng of Daily/Puzzle modes and break determinism. Pass `cascade.rng` from
// every call site — every cascade owns the rng for its mode.
export function activateShuffle(grid, rng) {
  if (typeof rng !== 'function') {
    throw new TypeError('activateShuffle: rng function is required');
  }
  reshuffle(grid, rng);
  return { ok: true, message: 'Shuffled' };
}

export function activateColorBlast(grid, targetType) {
  const cleared = new Set();
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const cell = grid[r][c];
      if (cell && cell.type === targetType) cleared.add(`${r},${c}`);
    }
  }
  if (cleared.size === 0) return { ok: false, reason: 'no gems of that color' };
  return { ok: true, clears: cleared };
}

export function activateBombDrop(grid, r, c) {
  const cell = grid[r][c];
  if (!cell) return { ok: false, reason: 'empty cell' };
  cell.special = SPECIAL.AREA_BOMB;
  return { ok: true, replaced: { r, c, special: SPECIAL.AREA_BOMB, type: cell.type } };
}

export function activateRecolor(grid, r, c, newType) {
  const cell = grid[r][c];
  if (!cell) return { ok: false, reason: 'empty cell' };
  if (cell.special) return { ok: false, reason: 'cannot recolor a special gem' };
  if (newType < 0 || newType >= TYPES) return { ok: false, reason: 'invalid color' };
  if (cell.type === newType) return { ok: false, reason: 'same color' };
  cell.type = newType;
  return { ok: true };
}

// Helper: does the cell at (r,c) target-mode-allow? (For UI dimming/feedback.)
export function isValidTarget(grid, r, c, mode) {
  const cell = grid[r]?.[c];
  if (!cell) return false;
  if (mode === 'recolor' && cell.special) return false;
  return true;
}
