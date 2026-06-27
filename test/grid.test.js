import { describe, it, expect } from 'vitest';
import {
  newCell, makeEmptyGrid, createBoard, swap, areAdjacent, applyGravity, spawnNew,
  hasAnyValidMove, findModestHint, reshuffle, reseedNextId, serializeGrid, deserializeGrid,
} from '../src/grid.js';
import { wouldSwapMatch, findMatches } from '../src/matcher.js';
import { GRID, TYPES, SPECIAL, TIME_BOMB_START } from '../src/config.js';
import { mulberry32 } from '../src/rng.js';

// A diagonal `(r+c) % TYPES` board: no matches and (importantly) NO valid move
// — a deterministic deadlock used throughout. Verified empirically.
function diag(off = 0) {
  const t = [];
  for (let r = 0; r < GRID; r++) {
    t.push([]);
    for (let c = 0; c < GRID; c++) t[r].push((r + c + off) % TYPES);
  }
  return t;
}
function build(plants = {}, specials = {}) {
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
function allOnes(type = 0) {
  const g = [];
  for (let r = 0; r < GRID; r++) { g.push([]); for (let c = 0; c < GRID; c++) g[r].push(newCell(type)); }
  return g;
}
// Scripted rng that yields a fixed list, then undefined.
const seq = (values) => { let i = 0; return () => values[i++]; };
// type value that maps to `t` via (rng()*TYPES)|0
const typeVal = (t) => (t + 0.5) / TYPES;

describe('newCell / makeEmptyGrid', () => {
  it('newCell carries type, special, bombCountdown and a unique id', () => {
    const a = newCell(3);
    const b = newCell(4, SPECIAL.TIME_BOMB, 7);
    expect(a).toMatchObject({ type: 3, special: SPECIAL.NONE, bombCountdown: null });
    expect(b).toMatchObject({ type: 4, special: SPECIAL.TIME_BOMB, bombCountdown: 7 });
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('makeEmptyGrid is an 8x8 grid of nulls', () => {
    const g = makeEmptyGrid();
    expect(g).toHaveLength(GRID);
    expect(g.every(row => row.length === GRID && row.every(c => c === null))).toBe(true);
  });
});

describe('createBoard', () => {
  it('produces a playable board: no initial matches and at least one move', () => {
    const g = createBoard(mulberry32(12345));
    expect(g).toHaveLength(GRID);
    expect(g.every(row => row.length === GRID && row.every(c => c && typeof c.type === 'number'))).toBe(true);
    expect(findMatches(g).cleared.size).toBe(0);
    expect(hasAnyValidMove(g)).toBe(true);
  });

  it('falls back to a reshuffle when 100 random attempts all deadlock', () => {
    // A period-64 rng that rebuilds the diag deadlock on every attempt, so all
    // 100 attempts fail hasAnyValidMove and the fallback path runs.
    let n = 0;
    const rng = () => { const i = n % 64; n++; const r = (i / 8) | 0, c = i % 8; return (((r + c) % TYPES) + 0.5) / TYPES; };
    const g = createBoard(rng);
    expect(g).toHaveLength(GRID);
    expect(g.every(row => row.length === GRID && row.every(c => c && typeof c.type === 'number'))).toBe(true);
  });

  it('avoids 3-in-a-rows while building: banned types are re-rolled', () => {
    // Deterministic rng over a 14-value cycle so vertical pairs (e.g. col0 rows
    // 0,1 share a type) and horizontal pairs recur constantly during the build —
    // every completing cell hits a ban and the do/while must re-roll. The result
    // must still be a full, match-free board.
    const cycle = [0.02, 0.02, 0.3, 0.5, 0.7, 0.9, 0.15, 0.45, 0.62, 0.78, 0.88, 0.34, 0.55, 0.95];
    let i = 0;
    const rng = () => cycle[i++ % cycle.length];
    const g = createBoard(rng);
    expect(g.every(row => row.every(c => c && typeof c.type === 'number'))).toBe(true);
    expect(findMatches(g).cleared.size).toBe(0);
  });
});

describe('swap / areAdjacent', () => {
  it('swap exchanges two cells', () => {
    const g = makeEmptyGrid();
    const a = newCell(1), b = newCell(2);
    g[0][0] = a; g[0][1] = b;
    swap(g, { r: 0, c: 0 }, { r: 0, c: 1 });
    expect(g[0][0]).toBe(b);
    expect(g[0][1]).toBe(a);
  });

  it('areAdjacent is true for orthogonal neighbours, false otherwise', () => {
    expect(areAdjacent({ r: 0, c: 0 }, { r: 0, c: 1 })).toBe(true);
    expect(areAdjacent({ r: 0, c: 0 }, { r: 1, c: 0 })).toBe(true);
    expect(areAdjacent({ r: 0, c: 0 }, { r: 1, c: 1 })).toBe(false);
    expect(areAdjacent({ r: 0, c: 0 }, { r: 0, c: 0 })).toBe(false);
    expect(areAdjacent({ r: 0, c: 0 }, { r: 0, c: 2 })).toBe(false);
  });
});

describe('applyGravity', () => {
  it('compacts downward, skips gaps, and leaves a full column untouched', () => {
    const g = makeEmptyGrid();
    g[0][0] = newCell(0);                         // single gem at top of col0
    for (let r = 0; r < GRID; r++) g[r][1] = newCell(1); // col1 already full
    const moves = applyGravity(g, 'down');
    expect(moves).toHaveLength(1);
    expect(moves[0].from).toEqual({ r: 0, c: 0 });
    expect(moves[0].to).toEqual({ r: GRID - 1, c: 0 });
    expect(g[GRID - 1][0]).not.toBeNull();
    expect(g[0][0]).toBeNull();
    expect(g[0][1]).not.toBeNull();               // full column not moved
  });

  it('compacts upward when gravity is flipped', () => {
    const g = makeEmptyGrid();
    g[GRID - 1][0] = newCell(0);                  // single gem at bottom of col0
    for (let r = 0; r < GRID; r++) g[r][1] = newCell(1); // col1 full
    const moves = applyGravity(g, 'up');
    expect(moves).toHaveLength(1);
    expect(moves[0].from).toEqual({ r: GRID - 1, c: 0 });
    expect(moves[0].to).toEqual({ r: 0, c: 0 });
    expect(g[0][0]).not.toBeNull();
    expect(g[GRID - 1][0]).toBeNull();
  });
});

describe('spawnNew', () => {
  it('fills empty cells from the top (gravity down) with off-board start Y', () => {
    const g = createBoard(mulberry32(7));
    g[0][0] = null;
    const spawns = spawnNew(g, seq([typeVal(3), 0.99]), 'down');
    expect(spawns).toHaveLength(1);
    expect(spawns[0]).toMatchObject({ r: 0, c: 0, fromY: -1 });
    expect(g[0][0]).not.toBeNull();
  });

  it('fills empty cells from the bottom (gravity up)', () => {
    const g = createBoard(mulberry32(7));
    g[GRID - 1][0] = null;
    const spawns = spawnNew(g, seq([typeVal(2), 0.99]), 'up');
    expect(spawns).toHaveLength(1);
    expect(spawns[0].fromY).toBe(GRID + (GRID - 1 - (GRID - 1))); // = GRID
    expect(g[GRID - 1][0]).not.toBeNull();
  });

  describe('pickSpawn special-gem rates', () => {
    // roll value chosen to land inside each special's cumulative window.
    const cases = [
      ['GRAVITY', 0.001, SPECIAL.GRAVITY, null],
      ['TIME_BOMB', 0.006, SPECIAL.TIME_BOMB, TIME_BOMB_START],
      ['WILDCARD', 0.010, SPECIAL.WILDCARD, null],
      ['COIN', 0.014, SPECIAL.COIN, null],
      ['FIRE', 0.017, SPECIAL.FIRE, null],
      ['LIGHTNING', 0.020, SPECIAL.LIGHTNING, null],
      ['AREA_BOMB', 0.0228, SPECIAL.AREA_BOMB, null],
      ['COLOR_BOMB', 0.0246, SPECIAL.COLOR_BOMB, null],
      ['STAR', 0.0262, SPECIAL.STAR, null],
      ['plain (no special)', 0.5, SPECIAL.NONE, null],
    ];
    for (const [name, roll, special, bomb] of cases) {
      it(`spawns ${name}`, () => {
        const g = createBoard(mulberry32(7)); // solvable base so bias-to-solvable is a no-op
        g[0][0] = null;
        spawnNew(g, seq([typeVal(0), roll]), 'down');
        expect(g[0][0].special).toBe(special);
        expect(g[0][0].bombCountdown).toBe(bomb);
      });
    }
  });

  describe('biasSpawnsToSolvable', () => {
    it('does nothing when there are no empty cells', () => {
      const g = build(); // full board
      const spawns = spawnNew(g, seq([]), 'down');
      expect(spawns).toHaveLength(0);
    });

    it('does nothing when the post-spawn board is already solvable', () => {
      const g = createBoard(mulberry32(7));
      g[0][0] = null;
      const spawns = spawnNew(g, seq([typeVal(3), 0.99]), 'down');
      expect(spawns).toHaveLength(1);
      expect(hasAnyValidMove(g)).toBe(true);
    });

    it('skips special spawns and leaves a deadlock unretyped', () => {
      // diag deadlock; hole at (0,0) refilled with a GRAVITY special at its diag
      // type → board stays a deadlock, but bias skips specials, so no move appears.
      const g = build();
      g[0][0] = null;
      spawnNew(g, seq([typeVal(0), 0.001 /* GRAVITY */]), 'down');
      expect(g[0][0].special).toBe(SPECIAL.GRAVITY);
      expect(hasAnyValidMove(g)).toBe(false);
    });

    it('retypes a spawned gem to re-enable a move (and restores ones that cannot help)', () => {
      // diag with (1,1) set to 0 then both (0,0) and (1,1) re-spawned as type 0:
      // a no-move board where (0,0) cannot be fixed by any retype (restored) but
      // (1,1) can (retyped) — exercising the restore + the successful retype.
      const t = diag(0); t[1][1] = 0;
      const g = [];
      for (let r = 0; r < GRID; r++) { g.push([]); for (let c = 0; c < GRID; c++) g[r].push(newCell(t[r][c])); }
      g[0][0] = null; g[1][1] = null;
      spawnNew(g, seq([typeVal(0), 0.99, typeVal(0), 0.99]), 'down');
      expect(g[0][0].type).toBe(0);            // could not be fixed → restored to its spawn type
      expect(g[1][1].type).not.toBe(0);        // retyped to re-enable play
      expect(hasAnyValidMove(g)).toBe(true);
    });
  });
});

describe('hasAnyValidMove', () => {
  it('is true when a swap can create a match', () => {
    expect(hasAnyValidMove(createBoard(mulberry32(7)))).toBe(true);
  });

  it('is false for a deadlocked board', () => {
    expect(hasAnyValidMove(build())).toBe(false);
  });

  it('is true when a color bomb is present (any swap with it counts)', () => {
    expect(hasAnyValidMove(build({}, { '0,0': SPECIAL.COLOR_BOMB }))).toBe(true);
  });

  it('tolerates null cells without throwing', () => {
    const g = build();
    g[0][0] = null; g[0][1] = null;
    expect(() => hasAnyValidMove(g)).not.toThrow();
  });
});

describe('findModestHint', () => {
  it('returns a real adjacent move on a solvable board', () => {
    const g = createBoard(mulberry32(7));
    const hint = findModestHint(g);
    expect(hint).toBeTruthy();
    expect(areAdjacent(hint.a, hint.b)).toBe(true);
    expect(wouldSwapMatch(g, hint.a, hint.b)).toBe(true);
  });

  it('returns null when there is no move at all', () => {
    expect(findModestHint(build())).toBeNull();
  });

  it('falls back to a color-bomb swap when no regular match exists', () => {
    const g = build({}, { '3,3': SPECIAL.COLOR_BOMB }); // deadlock + a color bomb in the middle
    const hint = findModestHint(g);
    expect(hint).toBeTruthy();
    const touchesBomb = (s) => (s.r === 3 && s.c === 3);
    expect(touchesBomb(hint.a) || touchesBomb(hint.b)).toBe(true);
  });

  it('scores 4-run, 5-run and T-shaped candidates while scanning', () => {
    // Each board contains a candidate of the given shape (plus modest 3-run
    // candidates the hint prefers); the scan must score every shape.
    const r4 = build({ '0,1': 0, '0,3': 0, '1,2': 0 });                 // (0,2)<->(1,2) makes a 4-run
    const r5 = build({ '0,1': 0, '0,3': 0, '0,4': 0, '1,2': 0 });       // ...makes a 5-run
    const tt = build({ '2,3': 0, '3,2': 0, '5,3': 0 });                 // (2,3)<->(3,3) makes a T
    for (const g of [r4, r5, tt]) {
      const hint = findModestHint(g);
      expect(hint).toBeTruthy();
      expect(areAdjacent(hint.a, hint.b)).toBe(true);
    }
  });
});

describe('reshuffle', () => {
  it('rearranges into a playable board (no match, has a move)', () => {
    const g = createBoard(mulberry32(7));
    reshuffle(g, mulberry32(99));
    expect(findMatches(g).cleared.size).toBe(0);
    expect(hasAnyValidMove(g)).toBe(true);
  });

  it('falls back to full re-randomize when shuffling cannot help', () => {
    // An all-one-colour board can never be shuffled into a playable arrangement,
    // so all 50 shuffles fail and the re-randomize fallback re-types the cells.
    const g = allOnes(0);
    reshuffle(g, mulberry32(5));
    expect(findMatches(g).cleared.size).toBe(0);
    expect(hasAnyValidMove(g)).toBe(true);
  });

  it('exhausts the re-randomize fallback when even re-typing keeps deadlocking', () => {
    // junk rng for the 50 shuffle attempts (all fail on a one-colour board), then
    // a diag-deadlock stream for every re-randomize attempt → all 100 fail and
    // reshuffle returns leaving the forced deadlock.
    const g = allOnes(0);
    const K = 50 * (GRID * GRID - 1); // rng calls consumed by the 50 shuffles
    let n = 0;
    const rng = () => {
      n++;
      if (n <= K) return 0.123;
      const i = (n - 1 - K) % 64; const r = (i / 8) | 0, c = i % 8;
      return (((r + c) % TYPES) + 0.5) / TYPES;
    };
    reshuffle(g, rng);
    expect(findMatches(g).cleared.size).toBe(0);
    expect(hasAnyValidMove(g)).toBe(false); // the rng-forced deadlock was left in place
  });
});

describe('serialize / deserialize / reseedNextId', () => {
  it('serializeGrid keeps cell data and nulls', () => {
    const g = makeEmptyGrid();
    g[0][0] = newCell(2, SPECIAL.LINE_H, null);
    g[0][1] = newCell(3, SPECIAL.TIME_BOMB, 5);
    const ser = serializeGrid(g);
    expect(ser[0][0]).toEqual({ type: 2, special: SPECIAL.LINE_H, bombCountdown: null, id: g[0][0].id });
    expect(ser[0][1]).toEqual({ type: 3, special: SPECIAL.TIME_BOMB, bombCountdown: 5, id: g[0][1].id });
    expect(ser[0][2]).toBeNull();
  });

  it('deserializeGrid restores cells, ignores nulls, and tracks max id', () => {
    const ser = makeEmptyGrid().map(row => row.map(() => null));
    ser[0][0] = { type: 1, special: SPECIAL.NONE, bombCountdown: null, id: 5 };
    ser[0][1] = { type: 2, special: SPECIAL.NONE, bombCountdown: null, id: 3 }; // smaller id after a larger one
    const g = deserializeGrid(ser);
    expect(g[0][0]).toEqual({ type: 1, special: SPECIAL.NONE, bombCountdown: null, id: 5 });
    expect(g[0][1].id).toBe(3);
    expect(g[0][2]).toBeNull();
  });

  it('reseedNextId only advances the id counter forward', () => {
    const a = newCell(0);
    reseedNextId(a.id + 100);          // maxId >= nextId → advance
    expect(newCell(0).id).toBeGreaterThan(a.id + 100);
    const c = newCell(0);
    reseedNextId(0);                   // maxId < nextId → no change
    expect(newCell(0).id).toBe(c.id + 1);
  });
});
