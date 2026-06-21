// Special gems: activation rules. Returns the additional cells those activations clear.

import { GRID, TYPES, SPECIAL, SCORE, LIGHTNING_TARGETS } from './config.js';

// activate(grid, r, c, special, partnerType?, rng?, partnerSpecial?, selfType?)
//   → { cleared: Set<"r,c">, chained: Array }
//
// `partnerType` is only relevant for COLOR_BOMB swaps (the other gem's color).
// `partnerSpecial` is the swap-partner's special — enables CB+CB and other combos.
// `rng` is used by LIGHTNING's random-target shuffle; seeded modes (Daily) must
//   pass their seeded rng to keep runs deterministic.
// `selfType` is required when the activating cell may already have been nulled
//   from the grid (the common case for chained activations after _afterResolve
//   has cleared the cells); without it, LIGHTNING/COLOR_BOMB would no-op.
//
// Specials inside the cleared set whose own activation hasn't been processed yet
// are returned via `chained` for the cascade to process recursively.
export function activate(grid, r, c, special, partnerType = null, rng = Math.random, partnerSpecial = null, selfType = null) {
  const myType = selfType ?? grid[r]?.[c]?.type ?? null;
  const cleared = new Set();
  const chained = [];

  switch (special) {
    case SPECIAL.LINE_H: {
      // Only count/clear LIVE cells. A follow-up special sweeping a lane an
      // earlier wave already emptied must not inflate the depth-multiplied
      // score (cascade scores cleared.size) or play clear tweens on empty
      // cells. The activating cell is added unconditionally below, matching
      // COLOR_BOMB/STAR/LIGHTNING.
      for (let cc = 0; cc < GRID; cc++) {
        const cell = grid[r][cc];
        if (cell) cleared.add(`${r},${cc}`);
        if (cell && cell.special && (cc !== c) && !chainedHas(chained, r, cc)) {
          chained.push({ r, c: cc, special: cell.special, type: cell.type });
        }
      }
      cleared.add(`${r},${c}`);
      break;
    }
    case SPECIAL.LINE_V: {
      for (let rr = 0; rr < GRID; rr++) {
        const cell = grid[rr][c];
        if (cell) cleared.add(`${rr},${c}`);
        if (cell && cell.special && (rr !== r) && !chainedHas(chained, rr, c)) {
          chained.push({ r: rr, c, special: cell.special, type: cell.type });
        }
      }
      cleared.add(`${r},${c}`);
      break;
    }
    case SPECIAL.AREA_BOMB: {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
          const cell = grid[nr][nc];
          if (cell) cleared.add(`${nr},${nc}`);
          if (cell && cell.special && (nr !== r || nc !== c) && !chainedHas(chained, nr, nc)) {
            chained.push({ r: nr, c: nc, special: cell.special, type: cell.type });
          }
        }
      }
      cleared.add(`${r},${c}`);
      break;
    }
    case SPECIAL.COLOR_BOMB: {
      // CB + CB swap → clear the entire board. Iconic combo, do it justice.
      // No chaining: every gem on the board is in `cleared`, so re-activating
      // each one against an empty grid would just emit spurious onSpecialActivated
      // events with no extra cells to clear. The single sweep IS the effect.
      if (partnerSpecial === SPECIAL.COLOR_BOMB) {
        for (let rr = 0; rr < GRID; rr++) {
          for (let cc = 0; cc < GRID; cc++) {
            if (grid[rr][cc]) cleared.add(`${rr},${cc}`);
          }
        }
        cleared.add(`${r},${c}`);
        break;
      }
      // Standard CB activation: clear all gems of partnerType. If no partner
      // (CB matched in a plain 3-line), fall back to the bomb's own color.
      const target = partnerType ?? myType;
      if (target == null) break;
      for (let rr = 0; rr < GRID; rr++) {
        for (let cc = 0; cc < GRID; cc++) {
          const cell = grid[rr][cc];
          if (cell && cell.type === target) {
            cleared.add(`${rr},${cc}`);
            if (cell.special && (rr !== r || cc !== c) && !chainedHas(chained, rr, cc)) {
              chained.push({ r: rr, c: cc, special: cell.special, type: cell.type });
            }
          }
        }
      }
      cleared.add(`${r},${c}`);
      break;
    }
    case SPECIAL.GRAVITY:
    case SPECIAL.TIME_BOMB:
    case SPECIAL.WILDCARD:
    case SPECIAL.COIN: {
      // These don't produce extra clears on activation — cascade handles their effects:
      //  - GRAVITY: sets cascade.gravityFlipNext (consumed on next FALL)
      //  - TIME_BOMB: defuse bonus
      //  - WILDCARD: matcher already counted it in the run
      //  - COIN: cascade applies the score multiplier when it's in the cleared set
      cleared.add(`${r},${c}`);
      break;
    }
    case SPECIAL.FIRE: {
      // Spread to 4 orthogonal neighbors.
      const N = [[-1,0],[1,0],[0,-1],[0,1]];
      cleared.add(`${r},${c}`);
      for (const [dr, dc] of N) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
        cleared.add(`${nr},${nc}`);
        const nb = grid[nr][nc];
        if (nb && nb.special && !chainedHas(chained, nr, nc)) {
          chained.push({ r: nr, c: nc, special: nb.special, type: nb.type });
        }
      }
      break;
    }
    case SPECIAL.LIGHTNING: {
      // Clear up to LIGHTNING_TARGETS random gems of the same color.
      cleared.add(`${r},${c}`);
      if (myType == null) break;
      const targets = [];
      for (let rr = 0; rr < GRID; rr++) {
        for (let cc = 0; cc < GRID; cc++) {
          if (rr === r && cc === c) continue;
          const cell = grid[rr][cc];
          if (cell && cell.type === myType) targets.push({ r: rr, c: cc });
        }
      }
      // Shuffle, pick first N. Use the cascade's seeded rng so Daily runs are deterministic.
      for (let i = targets.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [targets[i], targets[j]] = [targets[j], targets[i]];
      }
      for (let i = 0; i < Math.min(LIGHTNING_TARGETS, targets.length); i++) {
        const t = targets[i];
        cleared.add(`${t.r},${t.c}`);
        const cell = grid[t.r][t.c];
        if (cell && cell.special && !chainedHas(chained, t.r, t.c)) {
          chained.push({ r: t.r, c: t.c, special: cell.special, type: cell.type });
        }
      }
      break;
    }
    case SPECIAL.STAR: {
      // Clusterbuster: clear all gems of the 2 most common colors on the board.
      // Wildcards are excluded from the rank count (they have no inherent
      // color) but ALWAYS clear with the STAR — they're "any color", so they
      // go with whichever colors the STAR is sweeping. Wildcards don't chain
      // (they're passive in the matcher, not effect-bearing).
      const counts = new Array(TYPES).fill(0);
      for (let rr = 0; rr < GRID; rr++) {
        for (let cc = 0; cc < GRID; cc++) {
          const cell = grid[rr][cc];
          if (cell && cell.special !== SPECIAL.WILDCARD) counts[cell.type]++;
        }
      }
      const ranked = counts.map((n, type) => ({ type, n })).sort((a, b) => b.n - a.n);
      const top = new Set([ranked[0]?.type, ranked[1]?.type].filter(t => t !== undefined));
      for (let rr = 0; rr < GRID; rr++) {
        for (let cc = 0; cc < GRID; cc++) {
          const cell = grid[rr][cc];
          if (!cell) continue;
          const isWildcard = cell.special === SPECIAL.WILDCARD;
          if (top.has(cell.type) || isWildcard) {
            cleared.add(`${rr},${cc}`);
            if (cell.special && !isWildcard && (rr !== r || cc !== c) && !chainedHas(chained, rr, cc)) {
              chained.push({ r: rr, c: cc, special: cell.special, type: cell.type });
            }
          }
        }
      }
      cleared.add(`${r},${c}`);
      break;
    }
    default: break;
  }

  return { cleared, chained };
}

function chainedHas(arr, r, c) {
  for (let i = 0; i < arr.length; i++) if (arr[i].r === r && arr[i].c === c) return true;
  return false;
}

// Decrement all time-bomb countdowns by 1. Returns array of cells that just
// exploded.
//
// `skip` is an optional Set<"r,c"> of cells about to be cleared by the current
// match — those bombs are earning the defuse bonus, not exploding, so we
// leave them untouched here and let _beginResolve credit them. Without this
// guard, a bomb at countdown=1 inside the winning match gets decremented to 0,
// nulled, and the player eats the explosion penalty instead of the defuse
// bonus.
export function tickBombs(grid, skip = null) {
  const exploded = [];
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const cell = grid[r][c];
      if (!cell || cell.special !== SPECIAL.TIME_BOMB || cell.bombCountdown === null) continue;
      if (skip && skip.has(`${r},${c}`)) continue;
      cell.bombCountdown--;
      if (cell.bombCountdown <= 0) {
        exploded.push({ r, c, cell });
      }
    }
  }
  return exploded;
}

export function scoreForClear(count, depth) {
  return Math.round(count * SCORE.PER_GEM_CLEARED * SCORE.CASCADE_MULTIPLIER(depth));
}
