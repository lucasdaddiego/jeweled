import { describe, it, expect } from 'vitest';
import { findMatches, wouldSwapMatch, analyzeSwapShape } from '../src/matcher.js';
import { newCell } from '../src/grid.js';
import { GRID, TYPES, SPECIAL } from '../src/config.js';
import { counters, setEnabled } from '../src/debugHud.js';

const W = SPECIAL.WILDCARD;

// A diagonal board `(r+c) % TYPES` has no matches and no two orthogonally
// adjacent equal cells — an ideal no-match background to plant runs onto.
// (findMatches assumes a FULL board; null cells mis-extend runs, so every
// fixture here is a full 8x8.)
function diag(off = 0) {
  const t = [];
  for (let r = 0; r < GRID; r++) {
    t.push([]);
    for (let c = 0; c < GRID; c++) t[r].push((r + c + off) % TYPES);
  }
  return t;
}

// Build a full board from diag(0) with type overrides (plants) and specials.
// plants/specials keys are "r,c".
function board(plants = {}, specials = {}) {
  const t = diag(0);
  for (const k in plants) { const [r, c] = k.split(',').map(Number); t[r][c] = plants[k]; }
  const g = [];
  for (let r = 0; r < GRID; r++) {
    g.push([]);
    for (let c = 0; c < GRID; c++) {
      const sp = specials[`${r},${c}`] || SPECIAL.NONE;
      g[r].push(newCell(t[r][c], sp));
    }
  }
  return g;
}

const clearedOf = (res) => [...res.cleared].sort();

describe('findMatches — no match / early return', () => {
  it('returns empty for a board with no runs', () => {
    const res = findMatches(board());
    expect(res.cleared.size).toBe(0);
    expect(res.toSpawn).toEqual([]);
  });
});

describe('findMatches — horizontal runs', () => {
  it('clears a plain 3-run, spawns nothing', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0 }));
    expect(clearedOf(res)).toEqual(['3,2', '3,3', '3,4']);
    expect(res.toSpawn).toEqual([]);
  });

  it('promotes a 4-run to LINE_H at the middle when no swapOrigin', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0, '3,5': 0 }));
    expect(clearedOf(res)).toEqual(['3,2', '3,3', '3,4', '3,5']);
    expect(res.toSpawn).toEqual([{ r: 3, c: 4, special: SPECIAL.LINE_H, type: 0 }]);
  });

  it('places the LINE_H at the swapped cell when swapOrigin is in the run', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0, '3,5': 0 }), { r: 3, c: 2 });
    expect(res.toSpawn).toEqual([{ r: 3, c: 2, special: SPECIAL.LINE_H, type: 0 }]);
  });

  it('falls back to the middle when swapOrigin is not part of the run', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0, '3,5': 0 }), { r: 7, c: 7 });
    expect(res.toSpawn).toEqual([{ r: 3, c: 4, special: SPECIAL.LINE_H, type: 0 }]);
  });

  it('promotes a 5-run to COLOR_BOMB', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0, '3,5': 0, '3,6': 0 }));
    expect(clearedOf(res)).toEqual(['3,2', '3,3', '3,4', '3,5', '3,6']);
    expect(res.toSpawn).toEqual([{ r: 3, c: 4, special: SPECIAL.COLOR_BOMB, type: 0 }]);
  });
});

describe('findMatches — vertical runs', () => {
  it('clears a plain vertical 3-run', () => {
    const res = findMatches(board({ '2,3': 0, '3,3': 0, '4,3': 0 }));
    expect(clearedOf(res)).toEqual(['2,3', '3,3', '4,3']);
    expect(res.toSpawn).toEqual([]);
  });

  it('promotes a vertical 4-run to LINE_V', () => {
    const res = findMatches(board({ '2,3': 0, '3,3': 0, '4,3': 0, '5,3': 0 }));
    expect(clearedOf(res)).toEqual(['2,3', '3,3', '4,3', '5,3']);
    expect(res.toSpawn).toEqual([{ r: 4, c: 3, special: SPECIAL.LINE_V, type: 0 }]);
  });

  it('promotes a vertical 5-run to COLOR_BOMB', () => {
    const res = findMatches(board({ '2,3': 0, '3,3': 0, '4,3': 0, '5,3': 0, '6,3': 0 }));
    expect(res.toSpawn).toEqual([{ r: 4, c: 3, special: SPECIAL.COLOR_BOMB, type: 0 }]);
  });
});

describe('findMatches — wildcards', () => {
  it('a wildcard in the middle extends a horizontal run', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0 }, { '3,3': W }));
    expect(clearedOf(res)).toEqual(['3,2', '3,3', '3,4']);
    expect(res.toSpawn).toEqual([]);
  });

  it('a wildcard anchoring the start of a run still needs a non-wild type', () => {
    // wild at col 0 (nothing precedes it), then two type-0 anchors.
    const res = findMatches(board({ '3,0': 0, '3,1': 0, '3,2': 0 }, { '3,0': W }));
    expect(clearedOf(res)).toEqual(['3,0', '3,1', '3,2']);
  });

  it('a wildcard in the middle extends a vertical run', () => {
    const res = findMatches(board({ '2,3': 0, '3,3': 0, '4,3': 0 }, { '3,3': W }));
    expect(clearedOf(res)).toEqual(['2,3', '3,3', '4,3']);
  });

  it('a wildcard at the top extends a vertical run', () => {
    const res = findMatches(board({ '0,3': 0, '1,3': 0, '2,3': 0 }, { '0,3': W }));
    expect(clearedOf(res)).toEqual(['0,3', '1,3', '2,3']);
  });

  it('rejects a run made only of wildcards (no non-wild anchor)', () => {
    // Entire row 3 and column 3 are wildcards: each axis has a length-8 run with
    // no anchor type, so neither produces a match.
    const plants = {};
    const specials = {};
    for (let c = 0; c < GRID; c++) { plants[`3,${c}`] = 0; specials[`3,${c}`] = W; }
    for (let r = 0; r < GRID; r++) { plants[`${r},3`] = 0; specials[`${r},3`] = W; }
    const res = findMatches(board(plants, specials));
    expect(res.cleared.size).toBe(0);
    expect(res.toSpawn).toEqual([]);
  });
});

describe('findMatches — T/L intersections', () => {
  it('promotes an intersecting horizontal+vertical run to AREA_BOMB', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0, '2,3': 0, '4,3': 0 }));
    expect(clearedOf(res)).toEqual(['2,3', '3,2', '3,3', '3,4', '4,3']);
    expect(res.toSpawn).toEqual([{ r: 3, c: 3, special: SPECIAL.AREA_BOMB, type: 0 }]);
  });

  it('AREA_BOMB stays at the intersection even with a swapOrigin elsewhere', () => {
    const res = findMatches(board({ '3,2': 0, '3,3': 0, '3,4': 0, '2,3': 0, '4,3': 0 }), { r: 2, c: 3 });
    expect(res.toSpawn).toEqual([{ r: 3, c: 3, special: SPECIAL.AREA_BOMB, type: 0 }]);
  });

  it('skips an already-consumed vertical run when scanning a later horizontal run', () => {
    // T at type-0 (h1 row1 + v1 col1, intersecting at 1,1) consumes v1; then a
    // separate type-1 horizontal run (row5) re-scans the consumed v1.
    const res = findMatches(board({
      '1,0': 0, '1,1': 0, '1,2': 0, '0,1': 0, '2,1': 0, // T (type 0)
      '5,0': 2, '5,1': 2, '5,2': 2,                     // unrelated h-run (type 2)
    }));
    expect(clearedOf(res)).toEqual(['0,1', '1,0', '1,1', '1,2', '2,1', '5,0', '5,1', '5,2']);
    expect(res.toSpawn).toEqual([{ r: 1, c: 1, special: SPECIAL.AREA_BOMB, type: 0 }]);
  });

  it('does not pair same-type runs that do not intersect, nor different-type runs', () => {
    // h(type1) row0; v_same(type1) col0 not intersecting h; v_diff(type0) col5.
    const res = findMatches(board({
      '0,0': 1, '0,1': 1, '0,2': 1,   // h type1
      '4,0': 1, '5,0': 1, '6,0': 1,   // v_same type1 (no intersection)
      '0,5': 0, '1,5': 0, '2,5': 0,   // v_diff type0
    }));
    expect(clearedOf(res)).toEqual(['0,0', '0,1', '0,2', '0,5', '1,5', '2,5', '4,0', '5,0', '6,0']);
    expect(res.toSpawn).toEqual([]); // all plain 3-runs
  });
});

describe('findMatches — debug telemetry', () => {
  it('increments the findMatches counter only when debug is enabled', () => {
    counters.findMatches = 0;
    findMatches(board()); // debug disabled by default
    expect(counters.findMatches).toBe(0);

    setEnabled(true);
    try {
      counters.findMatches = 0;
      findMatches(board());
      expect(counters.findMatches).toBe(1);
    } finally {
      setEnabled(false);
    }
  });
});

describe('wouldSwapMatch', () => {
  it('detects a row run created at the first cell (horizontal swap)', () => {
    expect(wouldSwapMatch(board({ '3,0': 0, '3,1': 0, '3,3': 0 }), { r: 3, c: 2 }, { r: 3, c: 3 })).toBe(true);
  });

  it('detects a row run created at the second cell (vertical swap)', () => {
    expect(wouldSwapMatch(board({ '3,0': 0, '3,1': 0, '2,2': 0 }), { r: 2, c: 2 }, { r: 3, c: 2 })).toBe(true);
  });

  it('detects a column run at the first cell when no row run exists', () => {
    expect(wouldSwapMatch(board({ '0,0': 0, '1,0': 0, '3,0': 0, '2,1': 0 }), { r: 2, c: 0 }, { r: 2, c: 1 })).toBe(true);
  });

  it('detects a column run at the second cell when no row/first-column run exists', () => {
    expect(wouldSwapMatch(board({ '0,1': 0, '1,1': 0, '3,1': 0, '2,0': 0 }), { r: 2, c: 0 }, { r: 2, c: 1 })).toBe(true);
  });

  it('returns false when a swap creates nothing', () => {
    expect(wouldSwapMatch(board(), { r: 0, c: 0 }, { r: 1, c: 0 })).toBe(false);
    expect(wouldSwapMatch(board(), { r: 0, c: 0 }, { r: 0, c: 1 })).toBe(false);
  });

  it('honours a wildcard when forming a row run', () => {
    expect(wouldSwapMatch(board({ '3,2': 0, '3,3': 0, '3,5': 0 }, { '3,3': W }), { r: 3, c: 4 }, { r: 3, c: 5 })).toBe(true);
  });

  it('honours a wildcard when forming a column run', () => {
    expect(wouldSwapMatch(board({ '2,3': 0, '3,3': 0, '5,3': 0 }, { '3,3': W }), { r: 4, c: 3 }, { r: 5, c: 3 })).toBe(true);
  });

  it('treats an all-wildcard row/column as no run (no anchor)', () => {
    const rowPlants = {}, rowSpec = {};
    for (let c = 0; c < GRID; c++) { rowPlants[`3,${c}`] = 0; rowSpec[`3,${c}`] = W; }
    expect(wouldSwapMatch(board(rowPlants, rowSpec), { r: 3, c: 0 }, { r: 3, c: 1 })).toBe(false);

    const colPlants = {}, colSpec = {};
    for (let r = 0; r < GRID; r++) { colPlants[`${r},3`] = 0; colSpec[`${r},3`] = W; }
    expect(wouldSwapMatch(board(colPlants, colSpec), { r: 0, c: 3 }, { r: 1, c: 3 })).toBe(false);
  });

  it('restores the grid after checking (apply → check → undo)', () => {
    const g = board({ '3,0': 0, '3,1': 0, '3,3': 0 });
    const a = g[3][2], b = g[3][3];
    wouldSwapMatch(g, { r: 3, c: 2 }, { r: 3, c: 3 });
    expect(g[3][2]).toBe(a);
    expect(g[3][3]).toBe(b);
  });
});

describe('analyzeSwapShape', () => {
  it('reports no match for a swap that forms nothing', () => {
    const sh = analyzeSwapShape(board(), { r: 0, c: 0 }, { r: 0, c: 1 });
    expect(sh).toEqual({ matched: false, maxRun: 0, tShape: false });
  });

  it('reports a 4-run (vertical swap), and restores the grid', () => {
    // diag with row0 = 0 0 2 0 ... and (1,2)=0; swapping (0,2)<->(1,2) makes a 4-run.
    const g = board({ '0,1': 0, '0,3': 0, '1,2': 0 });
    const before2 = g[0][2], before12 = g[1][2];
    const sh = analyzeSwapShape(g, { r: 0, c: 2 }, { r: 1, c: 2 });
    expect(sh).toEqual({ matched: true, maxRun: 4, tShape: false });
    expect(g[0][2]).toBe(before2);   // finally restored
    expect(g[1][2]).toBe(before12);
  });

  it('reports a 5-run', () => {
    const sh = analyzeSwapShape(board({ '0,1': 0, '0,3': 0, '0,4': 0, '1,2': 0 }), { r: 0, c: 2 }, { r: 1, c: 2 });
    expect(sh).toEqual({ matched: true, maxRun: 5, tShape: false });
  });

  it('reports a T-shape at the destination cell', () => {
    const sh = analyzeSwapShape(board({ '2,3': 0, '3,2': 0, '5,3': 0 }), { r: 2, c: 3 }, { r: 3, c: 3 });
    expect(sh.matched).toBe(true);
    expect(sh.tShape).toBe(true);
  });

  it('reports a T-shape at the source cell', () => {
    const sh = analyzeSwapShape(board({ '2,3': 0, '3,2': 0, '5,3': 0 }), { r: 3, c: 3 }, { r: 2, c: 3 });
    expect(sh.tShape).toBe(true);
  });

  it('takes the longest of two runs in the scanned row (and tracks coverage)', () => {
    // row 3 = 0 0 0 0 2 1 1 1 : a 4-run then a 3-run; swap two 1s in the 3-run.
    const g = board({ '3,0': 0, '3,1': 0, '3,2': 0, '3,3': 0, '3,4': 2, '3,5': 1, '3,6': 1, '3,7': 1 });
    const sh = analyzeSwapShape(g, { r: 3, c: 6 }, { r: 3, c: 7 });
    expect(sh.matched).toBe(true);
    expect(sh.maxRun).toBe(4);
  });

  it('takes the longest of two runs in the scanned column', () => {
    const g = board({ '0,3': 0, '1,3': 0, '2,3': 0, '3,3': 0, '4,3': 2, '5,3': 1, '6,3': 1, '7,3': 1 });
    const sh = analyzeSwapShape(g, { r: 6, c: 3 }, { r: 7, c: 3 });
    expect(sh.maxRun).toBe(4);
  });

  it('ignores wildcard-only runs in row and column scans', () => {
    const rowPlants = {}, rowSpec = {};
    for (let c = 0; c < GRID; c++) { rowPlants[`3,${c}`] = 0; rowSpec[`3,${c}`] = W; }
    expect(analyzeSwapShape(board(rowPlants, rowSpec), { r: 3, c: 0 }, { r: 3, c: 1 }))
      .toEqual({ matched: false, maxRun: 0, tShape: false });

    const colPlants = {}, colSpec = {};
    for (let r = 0; r < GRID; r++) { colPlants[`${r},3`] = 0; colSpec[`${r},3`] = W; }
    expect(analyzeSwapShape(board(colPlants, colSpec), { r: 0, c: 3 }, { r: 1, c: 3 }))
      .toEqual({ matched: false, maxRun: 0, tShape: false });
  });
});
