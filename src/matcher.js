// Match detection with special-gem promotion.
//
// Returns: {
//   cleared: Set<"r,c"> of cells to clear
//   toSpawn: [{r, c, special, type}]  — specials to place after clear
// }
//
// `swapOrigin` is optional {r,c}; if provided and a match-trigger run includes it,
// specials prefer spawning at that cell so they appear where the player swapped to.

import { GRID, SPECIAL } from './config.js';
import { counters } from './debugHud.js';

export function findMatches(grid, swapOrigin = null) {
  counters.findMatches++;
  const cleared = new Set();
  const toSpawn = [];

  // 1. Collect raw horizontal runs of length >= 3.
  // Wildcards (cell.special === SPECIAL.WILDCARD) extend any run; a run must
  // have at least one non-wildcard "anchor" to be valid (and takes that type).
  const hRuns = [];
  for (let r = 0; r < GRID; r++) {
    let runStart = 0;
    let runType = null;
    for (let c = 0; c <= GRID; c++) {
      const cur = c < GRID ? grid[r][c] : null;
      const isWild = !!cur && cur.special === SPECIAL.WILDCARD;
      let extendsRun = false;
      if (cur) {
        if (runType === null) {
          extendsRun = true;
          if (!isWild) runType = cur.type;
        } else if (isWild || cur.type === runType) {
          extendsRun = true;
        }
      }
      if (!extendsRun) {
        const runLen = c - runStart;
        if (runLen >= 3 && runType !== null) {
          hRuns.push({ axis: 'h', r, c0: runStart, c1: c - 1, len: runLen, type: runType, consumed: false });
        }
        runStart = c;
        runType = (cur && !isWild) ? cur.type : null;
      }
    }
  }

  // 2. Collect raw vertical runs (same logic, vertical scan)
  const vRuns = [];
  for (let c = 0; c < GRID; c++) {
    let runStart = 0;
    let runType = null;
    for (let r = 0; r <= GRID; r++) {
      const cur = r < GRID ? grid[r][c] : null;
      const isWild = !!cur && cur.special === SPECIAL.WILDCARD;
      let extendsRun = false;
      if (cur) {
        if (runType === null) {
          extendsRun = true;
          if (!isWild) runType = cur.type;
        } else if (isWild || cur.type === runType) {
          extendsRun = true;
        }
      }
      if (!extendsRun) {
        const runLen = r - runStart;
        if (runLen >= 3 && runType !== null) {
          vRuns.push({ axis: 'v', c, r0: runStart, r1: r - 1, len: runLen, type: runType, consumed: false });
        }
        runStart = r;
        runType = (cur && !isWild) ? cur.type : null;
      }
    }
  }

  if (hRuns.length === 0 && vRuns.length === 0) {
    return { cleared, toSpawn };
  }

  // Pass A: T/L detection — h run and v run of same type sharing a cell
  for (const h of hRuns) {
    if (h.consumed) continue;
    for (const v of vRuns) {
      if (v.consumed) continue;
      if (h.type !== v.type) continue;
      // h spans row h.r, cols [h.c0..h.c1]. v spans col v.c, rows [v.r0..v.r1].
      // They share a cell iff h.r in [v.r0, v.r1] AND v.c in [h.c0, h.c1].
      if (h.r >= v.r0 && h.r <= v.r1 && v.c >= h.c0 && v.c <= h.c1) {
        // Clear all cells of both runs
        for (let c = h.c0; c <= h.c1; c++) cleared.add(`${h.r},${c}`);
        for (let r = v.r0; r <= v.r1; r++) cleared.add(`${r},${v.c}`);
        const spawnCell = preferSwapOrigin(swapOrigin, [{ r: h.r, c: v.c }]);
        toSpawn.push({ r: spawnCell.r, c: spawnCell.c, special: SPECIAL.AREA_BOMB, type: h.type });
        h.consumed = true;
        v.consumed = true;
        break;
      }
    }
  }

  // Pass B: 5-in-row → color bomb
  for (const run of [...hRuns, ...vRuns]) {
    if (run.consumed || run.len < 5) continue;
    const cells = expandRun(run);
    for (const { r, c } of cells) cleared.add(`${r},${c}`);
    const spawnCell = preferSwapOrigin(swapOrigin, cells);
    toSpawn.push({ r: spawnCell.r, c: spawnCell.c, special: SPECIAL.COLOR_BOMB, type: run.type });
    run.consumed = true;
  }

  // Pass C: 4-in-row → line gem
  for (const run of [...hRuns, ...vRuns]) {
    if (run.consumed || run.len !== 4) continue;
    const cells = expandRun(run);
    for (const { r, c } of cells) cleared.add(`${r},${c}`);
    const spawnCell = preferSwapOrigin(swapOrigin, cells);
    toSpawn.push({
      r: spawnCell.r, c: spawnCell.c,
      special: run.axis === 'h' ? SPECIAL.LINE_H : SPECIAL.LINE_V,
      type: run.type,
    });
    run.consumed = true;
  }

  // Pass D: plain 3s
  for (const run of [...hRuns, ...vRuns]) {
    if (run.consumed) continue;
    for (const { r, c } of expandRun(run)) cleared.add(`${r},${c}`);
    run.consumed = true;
  }

  return { cleared, toSpawn };
}

function expandRun(run) {
  const cells = [];
  if (run.axis === 'h') {
    for (let c = run.c0; c <= run.c1; c++) cells.push({ r: run.r, c });
  } else {
    for (let r = run.r0; r <= run.r1; r++) cells.push({ r, c: run.c });
  }
  return cells;
}

function preferSwapOrigin(swapOrigin, cells) {
  if (swapOrigin) {
    for (const c of cells) {
      if (c.r === swapOrigin.r && c.c === swapOrigin.c) return c;
    }
  }
  // Middle cell as fallback
  return cells[Math.floor(cells.length / 2)];
}

// Returns true if swapping cells a and b would create at least one match-3.
// Only scans the up-to-2 rows and up-to-2 columns the swap touches, mirroring
// findMatches's wildcard rules. ~30× faster than calling findMatches on the
// full board, which is what callers like hasAnyValidMove / findModestHint
// used to do.
//
// Mutates the grid temporarily (apply swap → check → undo). Safe under JS's
// single-threaded model; do not call concurrently with other grid readers.
export function wouldSwapMatch(grid, a, b) {
  // Apply swap.
  const tmp = grid[a.r][a.c];
  grid[a.r][a.c] = grid[b.r][b.c];
  grid[b.r][b.c] = tmp;
  try {
    let hit = rowHasRun(grid, a.r);
    if (!hit && b.r !== a.r) hit = rowHasRun(grid, b.r);
    if (!hit) hit = colHasRun(grid, a.c);
    if (!hit && b.c !== a.c) hit = colHasRun(grid, b.c);
    return hit;
  } finally {
    // Undo swap even if future scan logic throws.
    const tmp2 = grid[a.r][a.c];
    grid[a.r][a.c] = grid[b.r][b.c];
    grid[b.r][b.c] = tmp2;
  }
}

// Wildcard-aware run scan for a single row. Returns true on first run ≥3.
function rowHasRun(grid, r) {
  let runStart = 0;
  let runType = null;
  for (let c = 0; c <= GRID; c++) {
    const cur = c < GRID ? grid[r][c] : null;
    const isWild = !!cur && cur.special === SPECIAL.WILDCARD;
    let extendsRun = false;
    if (cur) {
      if (runType === null) {
        extendsRun = true;
        if (!isWild) runType = cur.type;
      } else if (isWild || cur.type === runType) {
        extendsRun = true;
      }
    }
    if (!extendsRun) {
      if (c - runStart >= 3 && runType !== null) return true;
      runStart = c;
      runType = (cur && !isWild) ? cur.type : null;
    }
  }
  return false;
}

// Wildcard-aware run scan for a single column. Mirrors rowHasRun.
function colHasRun(grid, c) {
  let runStart = 0;
  let runType = null;
  for (let r = 0; r <= GRID; r++) {
    const cur = r < GRID ? grid[r][c] : null;
    const isWild = !!cur && cur.special === SPECIAL.WILDCARD;
    let extendsRun = false;
    if (cur) {
      if (runType === null) {
        extendsRun = true;
        if (!isWild) runType = cur.type;
      } else if (isWild || cur.type === runType) {
        extendsRun = true;
      }
    }
    if (!extendsRun) {
      if (r - runStart >= 3 && runType !== null) return true;
      runStart = r;
      runType = (cur && !isWild) ? cur.type : null;
    }
  }
  return false;
}
