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
import { counters, enabled as _dbgEnabled } from './debugHud.js';

// === Unified wildcard-aware line scanner ===
//
// Every consumer in this file (findMatches, wouldSwapMatch, analyzeSwapShape)
// used to carry its own copy of the same run-scan loop; they drifted once and
// produced a real gameplay bug, so the loop now lives here exactly once.
//
// Wildcard rules:
//   - a wildcard extends a run of any type;
//   - a run needs at least one non-wildcard "anchor" (and takes its type);
//   - when a run BREAKS below length 3, its trailing wildcards are donated to
//     the run that starts at the break. Without the donation, [red, wild,
//     blue, blue] attaches the wildcard to the failed red run and the
//     legitimate wild+blue+blue match is never seen — the player's swap
//     bounces back as invalid.
//   Wildcards inside a run that DID match are consumed by it (greedy-left),
//   matching classic match-3 behavior.
//
// Results land in a module-level scratch buffer (single-threaded, never
// scanned reentrantly) so the hot paths — hasAnyValidMove calls this for up
// to ~450 lines per spawn wave — stay allocation-free.
const _runs = [];        // reused entries: {start, end, type}
let _runCount = 0;

function recordRun(start, end, type) {
  let r = _runs[_runCount];
  if (!r) { r = { start: 0, end: 0, type: 0 }; _runs[_runCount] = r; }
  r.start = start; r.end = end; r.type = type;
  _runCount++;
}

// Scan one row (isRow=true, fixed=r) or one column (isRow=false, fixed=c).
// Fills the scratch buffer with every maximal run of length >= 3 and returns
// the run count. Read results from runAt(i) BEFORE the next scanLine call.
function scanLine(grid, fixed, isRow) {
  _runCount = 0;
  let runStart = 0;
  let runType = null;
  for (let i = 0; i <= GRID; i++) {
    const cur = i < GRID ? (isRow ? grid[fixed][i] : grid[i][fixed]) : null;
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
    if (extendsRun) continue;

    const len = i - runStart;
    const matched = len >= 3 && runType !== null;
    if (matched) recordRun(runStart, i - 1, runType);

    // Where does the next run start? Normally at the break cell — but a
    // failed run donates its trailing wildcards (they're adjacent to the
    // next anchor and match it too). Never donate across a gap (cur null):
    // a wildcard next to an empty cell isn't adjacent to the next run.
    let nextStart = i;
    if (!matched && cur) {
      while (nextStart - 1 >= runStart) {
        const prev = isRow ? grid[fixed][nextStart - 1] : grid[nextStart - 1][fixed];
        if (prev && prev.special === SPECIAL.WILDCARD) nextStart--;
        else break;
      }
    }
    runStart = nextStart;
    runType = (cur && !isWild) ? cur.type : null;
  }
  return _runCount;
}

function runAt(i) { return _runs[i]; }

export function findMatches(grid, swapOrigin = null) {
  if (_dbgEnabled) counters.findMatches++;
  const cleared = new Set();
  const toSpawn = [];

  // 1. Collect raw horizontal runs of length >= 3.
  const hRuns = [];
  for (let r = 0; r < GRID; r++) {
    const n = scanLine(grid, r, true);
    for (let i = 0; i < n; i++) {
      const run = runAt(i);
      hRuns.push({ axis: 'h', r, c0: run.start, c1: run.end, len: run.end - run.start + 1, type: run.type, consumed: false });
    }
  }

  // 2. Collect raw vertical runs (same scanner, column-wise).
  const vRuns = [];
  for (let c = 0; c < GRID; c++) {
    const n = scanLine(grid, c, false);
    for (let i = 0; i < n; i++) {
      const run = runAt(i);
      vRuns.push({ axis: 'v', c, r0: run.start, r1: run.end, len: run.end - run.start + 1, type: run.type, consumed: false });
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
// Only scans the up-to-2 rows and up-to-2 columns the swap touches, using the
// same scanner findMatches uses — so "swap accepted" and "match resolved"
// can never disagree. ~30× faster than a full-board findMatches per trial,
// which is what callers like hasAnyValidMove / findModestHint used to do.
//
// Mutates the grid temporarily (apply swap → check → undo). Safe under JS's
// single-threaded model; do not call concurrently with other grid readers.
export function wouldSwapMatch(grid, a, b) {
  // Apply swap.
  const tmp = grid[a.r][a.c];
  grid[a.r][a.c] = grid[b.r][b.c];
  grid[b.r][b.c] = tmp;
  try {
    let hit = scanLine(grid, a.r, true) > 0;
    if (!hit && b.r !== a.r) hit = scanLine(grid, b.r, true) > 0;
    if (!hit) hit = scanLine(grid, a.c, false) > 0;
    if (!hit && b.c !== a.c) hit = scanLine(grid, b.c, false) > 0;
    return hit;
  } finally {
    // Undo swap even if future scan logic throws.
    const tmp2 = grid[a.r][a.c];
    grid[a.r][a.c] = grid[b.r][b.c];
    grid[b.r][b.c] = tmp2;
  }
}

// Apply swap → localized run scan capturing match + shape data → undo swap.
// Returns { matched, maxRun, tShape } where matched = maxRun >= 3 and
// tShape = a row run AND col run both pass through the same swap cell (which
// implies same type given the precondition that the pre-swap board has no
// pending matches — only call this from findModestHint / equivalent).
//
// Used by findModestHint to score candidate swaps without running the full
// O(GRID²) findMatches scan per candidate. ~30× faster on a full hint pass.
export function analyzeSwapShape(grid, a, b) {
  const tmp = grid[a.r][a.c];
  grid[a.r][a.c] = grid[b.r][b.c];
  grid[b.r][b.c] = tmp;
  try {
    const rowA = summarizeLine(grid, a.r, true, a.c, b.c);
    const rowB = (b.r === a.r) ? rowA : summarizeLine(grid, b.r, true, a.c, b.c);
    const colA = summarizeLine(grid, a.c, false, a.r, b.r);
    const colB = (b.c === a.c) ? colA : summarizeLine(grid, b.c, false, a.r, b.r);
    const maxRun = Math.max(rowA.maxLen, rowB.maxLen, colA.maxLen, colB.maxLen);
    // T at A: row a.r has a run covering col a.c AND col a.c has a run covering row a.r.
    // T at B: row b.r has a run covering col b.c AND col b.c has a run covering row b.r.
    const tAtA = rowA.coversA && colA.coversA;
    const tAtB = rowB.coversB && colB.coversB;
    return { matched: maxRun >= 3, maxRun, tShape: tAtA || tAtB };
  } finally {
    const tmp2 = grid[a.r][a.c];
    grid[a.r][a.c] = grid[b.r][b.c];
    grid[b.r][b.c] = tmp2;
  }
}

// scanLine + summary: longest run length ≥3 (else 0) plus whether some run on
// this line covers index targetA / targetB.
function summarizeLine(grid, fixed, isRow, targetA, targetB) {
  const n = scanLine(grid, fixed, isRow);
  let maxLen = 0;
  let coversA = false, coversB = false;
  for (let i = 0; i < n; i++) {
    const run = runAt(i);
    const len = run.end - run.start + 1;
    if (len > maxLen) maxLen = len;
    if (targetA >= run.start && targetA <= run.end) coversA = true;
    if (targetB >= run.start && targetB <= run.end) coversB = true;
  }
  return { maxLen, coversA, coversB };
}
