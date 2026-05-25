// Board state + pure grid operations: swap, gravity (down or up), spawn.

import { GRID, TYPES, SPECIAL, SPAWN_RATES, TIME_BOMB_START } from './config.js';
import { findMatches, wouldSwapMatch } from './matcher.js';

// Cell shape: { type: 0..TYPES-1, special: SPECIAL.*, bombCountdown: null | int, id: int }
let nextId = 1;
export function newCell(type, special = SPECIAL.NONE, bombCountdown = null) {
  return { type, special, bombCountdown, id: nextId++ };
}

export function makeEmptyGrid() {
  const g = new Array(GRID);
  for (let r = 0; r < GRID; r++) {
    g[r] = new Array(GRID).fill(null);
  }
  return g;
}

// Create a fresh playable board: no pre-existing matches, at least one valid move.
export function createBoard(rng = Math.random) {
  let attempts = 0;
  while (attempts++ < 100) {
    const g = makeEmptyGrid();
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        g[r][c] = newCell(pickTypeNoMatch(g, r, c, rng));
      }
    }
    if (findMatches(g, null).cleared.size === 0 && hasAnyValidMove(g)) return g;
  }
  // Fallback (extremely rare — 100 failed attempts): build a random board then
  // reshuffle until it's playable. reshuffle() guarantees both no-pre-match and
  // at-least-one-valid-move (or falls back to a full re-randomize).
  const g = makeEmptyGrid();
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      g[r][c] = newCell((rng() * TYPES) | 0);
    }
  }
  reshuffle(g, rng);
  return g;
}

function pickTypeNoMatch(g, r, c, rng) {
  // Avoid creating a 3-in-row with cells above or to the left.
  const banned = new Set();
  if (r >= 2 && g[r-1][c] && g[r-2][c] && g[r-1][c].type === g[r-2][c].type) banned.add(g[r-1][c].type);
  if (c >= 2 && g[r][c-1] && g[r][c-2] && g[r][c-1].type === g[r][c-2].type) banned.add(g[r][c-1].type);
  let t;
  do { t = (rng() * TYPES) | 0; } while (banned.has(t));
  return t;
}

export function swap(g, a, b) {
  const tmp = g[a.r][a.c];
  g[a.r][a.c] = g[b.r][b.c];
  g[b.r][b.c] = tmp;
}

export function areAdjacent(a, b) {
  const dr = Math.abs(a.r - b.r), dc = Math.abs(a.c - b.c);
  return (dr + dc) === 1;
}

// Apply gravity (down or up). Returns list of movements: [{from:{r,c}, to:{r,c}, cell}]
export function applyGravity(g, direction = 'down') {
  const moves = [];
  for (let c = 0; c < GRID; c++) {
    if (direction === 'down') {
      // Compact downward
      let writeRow = GRID - 1;
      for (let r = GRID - 1; r >= 0; r--) {
        if (g[r][c] !== null) {
          if (r !== writeRow) {
            moves.push({ from: { r, c }, to: { r: writeRow, c }, cell: g[r][c] });
            g[writeRow][c] = g[r][c];
            g[r][c] = null;
          }
          writeRow--;
        }
      }
    } else {
      // Compact upward
      let writeRow = 0;
      for (let r = 0; r < GRID; r++) {
        if (g[r][c] !== null) {
          if (r !== writeRow) {
            moves.push({ from: { r, c }, to: { r: writeRow, c }, cell: g[r][c] });
            g[writeRow][c] = g[r][c];
            g[r][c] = null;
          }
          writeRow++;
        }
      }
    }
  }
  return moves;
}

// Spawn new gems in empty cells. `direction` matches the gravity that was just applied —
// 'down' means empties are at the TOP and gems fall in from above; 'up' means empties are at the BOTTOM.
// Returns list of spawns: [{r, c, cell, fromY}] where fromY is the off-board start (-1 or GRID).
//
// After random spawning, the board is checked: if no valid move exists, one of the
// just-spawned gems has its type swapped to the smallest change that re-enables play.
// This keeps the existing board layout intact (no reshuffle) while ensuring the
// player always has at least one move waiting.
export function spawnNew(g, rng = Math.random, direction = 'down') {
  const spawns = [];
  for (let c = 0; c < GRID; c++) {
    if (direction === 'down') {
      for (let r = 0; r < GRID; r++) {
        if (g[r][c] === null) {
          const cell = pickSpawn(rng);
          g[r][c] = cell;
          spawns.push({ r, c, cell, fromY: -1 - r });
        }
      }
    } else {
      for (let r = GRID - 1; r >= 0; r--) {
        if (g[r][c] === null) {
          const cell = pickSpawn(rng);
          g[r][c] = cell;
          spawns.push({ r, c, cell, fromY: GRID + (GRID - 1 - r) });
        }
      }
    }
  }
  // Solvability bias: if the post-spawn board has no valid move, retype one of
  // the new gems. The player sees a board that looks just like what fell in,
  // but it's quietly guaranteed to be playable.
  biasSpawnsToSolvable(g, spawns);
  return spawns;
}

// Iterate spawned cells; for each, try every other type. Keep the first change
// that makes the board solvable. If no single retype works (very rare), leave
// the board as-is — the matcher will run again on the next cycle.
function biasSpawnsToSolvable(g, spawns) {
  if (spawns.length === 0) return;
  if (hasAnyValidMove(g)) return;
  for (const s of spawns) {
    const cell = g[s.r][s.c];
    if (!cell || cell.special) continue; // don't tamper with special-type spawns
    const orig = cell.type;
    for (let t = 0; t < TYPES; t++) {
      if (t === orig) continue;
      cell.type = t;
      if (hasAnyValidMove(g)) {
        // Keep this change. Spawn entry's cell ref already points at this object,
        // so the fall animation will show the new color naturally.
        return;
      }
    }
    cell.type = orig;
  }
}

function pickSpawn(rng) {
  const type = (rng() * TYPES) | 0;
  // Roll for special-gem replacement. Cumulative probabilities.
  const roll = rng();
  const p = SPAWN_RATES;
  let cutoff = 0;
  cutoff += 1 / p.GRAVITY;     if (roll < cutoff) return newCell(type, SPECIAL.GRAVITY);
  cutoff += 1 / p.TIME_BOMB;   if (roll < cutoff) return newCell(type, SPECIAL.TIME_BOMB, TIME_BOMB_START);
  cutoff += 1 / p.WILDCARD;    if (roll < cutoff) return newCell(type, SPECIAL.WILDCARD);
  cutoff += 1 / p.COIN;        if (roll < cutoff) return newCell(type, SPECIAL.COIN);
  cutoff += 1 / p.FIRE;        if (roll < cutoff) return newCell(type, SPECIAL.FIRE);
  cutoff += 1 / p.LIGHTNING;   if (roll < cutoff) return newCell(type, SPECIAL.LIGHTNING);
  cutoff += 1 / p.AREA_BOMB;   if (roll < cutoff) return newCell(type, SPECIAL.AREA_BOMB);
  cutoff += 1 / p.COLOR_BOMB;  if (roll < cutoff) return newCell(type, SPECIAL.COLOR_BOMB);
  cutoff += 1 / p.STAR;        if (roll < cutoff) return newCell(type, SPECIAL.STAR);
  return newCell(type);
}

// Returns true if ANY adjacent swap creates a match. Uses wouldSwapMatch (a
// localized scan of the affected rows/columns), avoiding the full-board
// findMatches scan that this used to do per trial.
export function hasAnyValidMove(g) {
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (c + 1 < GRID && isValidSwapCandidate(g, { r, c }, { r, c: c + 1 })) return true;
      if (r + 1 < GRID && isValidSwapCandidate(g, { r, c }, { r: r + 1, c })) return true;
    }
  }
  return false;
}

// Find one valid swap (for general use — e.g. checking solvability).
export function findValidSwap(g) {
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      if (c + 1 < GRID) {
        const a = { r, c }, b = { r, c: c + 1 };
        if (isValidSwapCandidate(g, a, b)) return { a, b };
      }
      if (r + 1 < GRID) {
        const a = { r, c }, b = { r: r + 1, c };
        if (isValidSwapCandidate(g, a, b)) return { a, b };
      }
    }
  }
  return null;
}

// Find a MODEST hint: prefer plain 3-matches over 4+, 5+, or T/L shapes,
// so the hint nudges the player without giving away the best plays.
// Falls back to any valid swap if nothing modest exists.
export function findModestHint(g) {
  const candidates = [];
  let colorBombFallback = null;
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const tries = [];
      if (c + 1 < GRID) tries.push({ a: { r, c }, b: { r, c: c + 1 } });
      if (r + 1 < GRID) tries.push({ a: { r, c }, b: { r: r + 1, c } });
      for (const t of tries) {
        if (isColorBombSwap(g, t.a, t.b)) {
          if (!colorBombFallback) colorBombFallback = t;
          continue;
        }
        // Cheap pre-filter — skip the expensive findMatches scan for swaps
        // that don't produce any match at all (the common case).
        if (!wouldSwapMatch(g, t.a, t.b)) continue;
        swap(g, t.a, t.b);
        const m = findMatches(g, null);
        swap(g, t.a, t.b);
        if (m.cleared.size > 0) {
          // Score this candidate: lower = more "modest"
          // Plain 3 with no specials spawned → 0
          // 4-in-row spawns line gem → 10
          // 5-in-row spawns color bomb → 20
          // T/L spawns area bomb → 15
          // Larger clears get penalty too.
          let penalty = m.cleared.size - 3; // each extra cell = +1
          for (const s of m.toSpawn) {
            if (s.special === SPECIAL.COLOR_BOMB) penalty += 20;
            else if (s.special === SPECIAL.AREA_BOMB) penalty += 15;
            else penalty += 10;
          }
          candidates.push({ swap: t, penalty });
        }
      }
    }
  }
  if (candidates.length === 0) return colorBombFallback;
  candidates.sort((x, y) => x.penalty - y.penalty);
  return candidates[0].swap;
}

function isValidSwapCandidate(g, a, b) {
  return isColorBombSwap(g, a, b) || wouldSwapMatch(g, a, b);
}

function isColorBombSwap(g, a, b) {
  return g[a.r]?.[a.c]?.special === SPECIAL.COLOR_BOMB
      || g[b.r]?.[b.c]?.special === SPECIAL.COLOR_BOMB;
}

// Reshuffle while preserving the multiset of gems. Bounded.
export function reshuffle(g, rng = Math.random) {
  const flat = [];
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) flat.push(g[r][c]);
  for (let attempt = 0; attempt < 50; attempt++) {
    // Fisher-Yates
    for (let i = flat.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [flat[i], flat[j]] = [flat[j], flat[i]];
    }
    let i = 0;
    for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) g[r][c] = flat[i++];
    if (findMatches(g, null).cleared.size === 0 && hasAnyValidMove(g)) return;
  }
  // Fallback — full re-randomize, preserving any special gems.
  for (let attempt = 0; attempt < 100; attempt++) {
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const cell = g[r][c];
        cell.type = pickTypeNoMatch(g, r, c, rng);
      }
    }
    if (findMatches(g, null).cleared.size === 0 && hasAnyValidMove(g)) return;
  }
}

// Helper for cells whose contents shouldn't be re-id'd on restore.
export function reseedNextId(maxId) {
  if (maxId >= nextId) nextId = maxId + 1;
}

// Serialize a grid for saveState (drops object identity but keeps id).
export function serializeGrid(g) {
  return g.map(row => row.map(cell => cell ? ({
    type: cell.type, special: cell.special, bombCountdown: cell.bombCountdown, id: cell.id,
  }) : null));
}

export function deserializeGrid(serialized) {
  let maxId = 0;
  const g = serialized.map(row => row.map(c => {
    if (!c) return null;
    if (c.id > maxId) maxId = c.id;
    return { type: c.type, special: c.special, bombCountdown: c.bombCountdown, id: c.id };
  }));
  reseedNextId(maxId);
  return g;
}
