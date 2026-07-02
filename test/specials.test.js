import { describe, it, expect } from 'vitest';
import { activate, tickBombs, scoreForClear } from '../src/specials.js';
import { makeEmptyGrid, newCell } from '../src/grid.js';
import { GRID, TYPES, SPECIAL, SCORE, LIGHTNING_TARGETS } from '../src/config.js';
import { mulberry32 } from '../src/rng.js';

// Fill the whole board with plain gems of one type.
function fullGrid(type = 0) {
  const g = makeEmptyGrid();
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) g[r][c] = newCell(type);
  return g;
}
const key = (r, c) => `${r},${c}`;

describe('activate — LINE_H', () => {
  it('clears every live cell in the row and chains other specials in it', () => {
    const g = fullGrid(0);
    g[3][2] = newCell(0, SPECIAL.LINE_V);   // a special elsewhere in the row → chains
    g[3][4] = newCell(0, SPECIAL.LINE_H);   // the activating cell (special, but cc===c → no chain)
    g[3][7] = null;                          // a hole → not added to cleared
    const { cleared, chained } = activate(g, 3, 4, SPECIAL.LINE_H);
    expect(cleared.size).toBe(7);            // cols 0..6 (col 7 is null)
    expect(cleared.has(key(3, 0))).toBe(true);
    expect(cleared.has(key(3, 7))).toBe(false);
    expect(chained).toEqual([{ r: 3, c: 2, special: SPECIAL.LINE_V, type: 0 }]);
  });
});

describe('activate — LINE_V', () => {
  it('clears every live cell in the column and chains other specials in it', () => {
    const g = fullGrid(1);
    g[5][2] = newCell(1, SPECIAL.LINE_H);   // chains
    g[3][2] = newCell(1, SPECIAL.LINE_V);   // activating cell (rr===r → no chain)
    g[0][2] = null;                          // hole
    const { cleared, chained } = activate(g, 3, 2, SPECIAL.LINE_V);
    expect(cleared.size).toBe(7);            // rows 1..7
    expect(cleared.has(key(0, 2))).toBe(false);
    expect(chained).toEqual([{ r: 5, c: 2, special: SPECIAL.LINE_H, type: 1 }]);
  });
});

describe('activate — AREA_BOMB', () => {
  it('clears the 3x3 block, chaining neighbour specials but not the centre', () => {
    const g = fullGrid(2);
    g[3][3] = newCell(2, SPECIAL.FIRE);     // corner of the block → chains
    g[4][4] = newCell(2, SPECIAL.AREA_BOMB);// centre (activating) → no chain
    g[5][5] = null;                          // hole inside the block
    const { cleared, chained } = activate(g, 4, 4, SPECIAL.AREA_BOMB);
    expect(cleared.size).toBe(8);            // 9 cells minus the hole
    expect(chained).toEqual([{ r: 3, c: 3, special: SPECIAL.FIRE, type: 2 }]);
  });

  it('clamps the block at a corner of the board', () => {
    const g = fullGrid(2);
    const { cleared } = activate(g, 0, 0, SPECIAL.AREA_BOMB);
    expect(cleared.size).toBe(4);            // (0,0)(0,1)(1,0)(1,1); negatives skipped
    expect(cleared.has(key(0, 0))).toBe(true);
    expect(cleared.has(key(1, 1))).toBe(true);
  });
});

describe('activate — COLOR_BOMB', () => {
  it('CB + CB wipes the whole board with no chaining', () => {
    const g = fullGrid(3);
    g[0][0] = null;                          // a hole is not cleared
    const { cleared, chained } = activate(g, 2, 2, SPECIAL.COLOR_BOMB, null, Math.random, SPECIAL.COLOR_BOMB);
    expect(cleared.size).toBe(GRID * GRID - 1);
    expect(cleared.has(key(0, 0))).toBe(false);
    expect(chained).toEqual([]);
  });

  it('clears all gems of the partner type, chaining their specials but not the bomb itself', () => {
    const g = fullGrid(5);
    g[0][0] = newCell(3, SPECIAL.COLOR_BOMB);  // bomb shares the target type → cleared, not chained
    g[4][4] = newCell(3, SPECIAL.FIRE);        // partner-type special → chains
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.COLOR_BOMB, 3);
    expect(cleared.size).toBe(2);              // (0,0) + (4,4)
    expect(cleared.has(key(0, 0))).toBe(true);
    expect(chained).toEqual([{ r: 4, c: 4, special: SPECIAL.FIRE, type: 3 }]);
  });

  it('falls back to the bomb’s own colour when there is no partner', () => {
    const g = fullGrid(1);
    g[0][0] = newCell(5, SPECIAL.COLOR_BOMB);  // myType = 5
    g[2][2] = newCell(5);
    g[6][6] = newCell(5);
    const { cleared } = activate(g, 0, 0, SPECIAL.COLOR_BOMB);  // partnerType null → uses myType 5
    expect(cleared.size).toBe(3);
    expect(cleared.has(key(2, 2))).toBe(true);
    expect(cleared.has(key(3, 3))).toBe(false);   // a type-1 cell, untouched
  });

  it('no-ops when neither a partner nor a self type is known', () => {
    const g = makeEmptyGrid();                  // grid[0][0] is null → myType null
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.COLOR_BOMB);
    expect(cleared.size).toBe(0);
    expect(chained).toEqual([]);
  });
});

describe('activate — passive specials (GRAVITY/TIME_BOMB/WILDCARD/COIN)', () => {
  for (const sp of [SPECIAL.GRAVITY, SPECIAL.TIME_BOMB, SPECIAL.WILDCARD, SPECIAL.COIN]) {
    it(`${sp} clears only itself with no chains`, () => {
      const g = fullGrid(0);
      const { cleared, chained } = activate(g, 1, 1, sp);
      expect([...cleared]).toEqual([key(1, 1)]);
      expect(chained).toEqual([]);
    });
  }
});

describe('activate — FIRE', () => {
  it('spreads to four orthogonal neighbours and chains specials among them', () => {
    const g = fullGrid(6);
    // All four neighbours are special. (4,3) and (4,5) share row 4, so the
    // dedup scan compares same-row/different-col entries (exercises the && tail).
    g[3][4] = newCell(6, SPECIAL.LINE_H);
    g[5][4] = newCell(6, SPECIAL.LINE_H);
    g[4][3] = newCell(6, SPECIAL.LINE_V);
    g[4][5] = newCell(6, SPECIAL.LINE_V);
    const { cleared, chained } = activate(g, 4, 4, SPECIAL.FIRE);
    expect(cleared.size).toBe(5);             // centre + 4 neighbours
    expect(chained).toHaveLength(4);
  });

  it('clamps at a board corner (off-board neighbours skipped)', () => {
    const g = fullGrid(6);
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.FIRE);
    expect(cleared.size).toBe(3);             // (0,0)(1,0)(0,1)
    expect(chained).toEqual([]);              // plain neighbours → nothing chains
  });
});

describe('activate — LIGHTNING', () => {
  it('no-ops past the self cell when its colour is unknown', () => {
    const g = makeEmptyGrid();                // grid[0][0] null → myType null
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.LIGHTNING);
    expect([...cleared]).toEqual([key(0, 0)]);
    expect(chained).toEqual([]);
  });

  it('clears LIGHTNING_TARGETS same-colour gems, chaining any specials hit', () => {
    const g = makeEmptyGrid();
    // Activating cell + a sea of same-colour specials so the chosen N all chain.
    g[0][0] = newCell(0, SPECIAL.LIGHTNING);
    let others = 0;
    for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
      if (r === 0 && c === 0) continue;
      g[r][c] = newCell(0, SPECIAL.FIRE);
      others++;
    }
    expect(others).toBeGreaterThan(LIGHTNING_TARGETS);
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.LIGHTNING, null, mulberry32(7));
    expect(cleared.size).toBe(1 + LIGHTNING_TARGETS);   // self + N
    expect(chained).toHaveLength(LIGHTNING_TARGETS);     // every hit gem was special
  });

  it('hits only what exists when fewer than LIGHTNING_TARGETS gems share the colour', () => {
    const g = fullGrid(1);                    // everything type 1 (not the target colour)
    g[0][0] = newCell(0, SPECIAL.LIGHTNING);  // activating, type 0
    g[0][5] = newCell(0);                     // plain same-colour
    g[5][0] = newCell(0, SPECIAL.AREA_BOMB);  // special same-colour → chains
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.LIGHTNING, null, mulberry32(1));
    expect(cleared.size).toBe(3);             // self + the only two type-0 gems
    expect(chained).toEqual([{ r: 5, c: 0, special: SPECIAL.AREA_BOMB, type: 0 }]);
  });
});

describe('activate — STAR', () => {
  it('clears the two most common colours plus all wildcards, chaining their specials', () => {
    const g = makeEmptyGrid();
    let idx = 0;
    const put = (type, special) => { g[idx >> 3][idx & 7] = newCell(type, special); idx++; };
    put(0, SPECIAL.STAR);   // (0,0) activating cell, top colour, special → cleared not chained
    put(0, SPECIAL.FIRE);   // (0,1) top colour, special → chains
    for (let i = 0; i < 18; i++) put(0);   // 18 more type-0 → 20 total
    for (let i = 0; i < 18; i++) put(1);   // 18 type-1
    g[4][6] = newCell(2);                  // a lone type-2 → NOT in top-2 → survives
    g[4][7] = newCell(4, SPECIAL.WILDCARD);// wildcard: not counted, cleared anyway, never chains
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.STAR);
    expect(cleared.size).toBe(20 + 18 + 1);          // type0 + type1 + the wildcard
    expect(cleared.has(key(4, 7))).toBe(true);       // wildcard swept along
    expect(cleared.has(key(4, 6))).toBe(false);      // off-colour gem spared
    expect(chained).toEqual([{ r: 0, c: 1, special: SPECIAL.FIRE, type: 0 }]);
  });
});

describe('activate — default / unknown special', () => {
  it('returns empty sets for a non-special (SPECIAL.NONE)', () => {
    const g = fullGrid(0);
    const { cleared, chained } = activate(g, 0, 0, SPECIAL.NONE);
    expect(cleared.size).toBe(0);
    expect(chained).toEqual([]);
  });
});

describe('tickBombs', () => {
  it('decrements live bombs, detonates those reaching zero, and honours skip/guards', () => {
    const g = makeEmptyGrid();
    g[0][0] = newCell(0, SPECIAL.TIME_BOMB, 2);   // → 1, survives
    g[1][1] = newCell(0, SPECIAL.TIME_BOMB, 1);   // → 0, explodes
    g[3][3] = newCell(0, SPECIAL.TIME_BOMB, null);// already spent (countdown null) → skipped
    g[4][4] = newCell(0, SPECIAL.TIME_BOMB, 1);   // in skip set → untouched
    g[5][5] = newCell(0);                          // plain gem → ignored
    const exploded = tickBombs(g, new Set([key(4, 4)]));
    expect(exploded).toHaveLength(1);
    expect(exploded[0]).toMatchObject({ r: 1, c: 1 });
    expect(g[0][0].bombCountdown).toBe(1);
    expect(g[1][1].bombCountdown).toBe(0);
    expect(g[4][4].bombCountdown).toBe(1);         // skipped, not decremented
  });

  it('defaults skip to null and detonates a bomb at one tick left', () => {
    const g = makeEmptyGrid();
    g[2][2] = newCell(0, SPECIAL.TIME_BOMB, 1);
    const exploded = tickBombs(g);
    expect(exploded).toHaveLength(1);
    expect(exploded[0]).toMatchObject({ r: 2, c: 2 });
  });
});

describe('scoreForClear', () => {
  it('scales by gem count and the cascade-depth multiplier', () => {
    expect(scoreForClear(3, 1)).toBe(30);   // 3 * 10 * 1.0
    expect(scoreForClear(3, 2)).toBe(45);   // 3 * 10 * 1.5
    expect(scoreForClear(4, 3)).toBe(80);   // 4 * 10 * 2.0
    expect(scoreForClear(0, 1)).toBe(0);
  });
});

describe('activate — chain restriction to effect-bearing specials', () => {
  it('LINE_H sweeping a COIN / GRAVITY / WILDCARD does not chain them, but chains a FIRE', () => {
    const g = fullGrid(0);
    g[2][1] = newCell(0, SPECIAL.COIN);
    g[2][3] = newCell(0, SPECIAL.GRAVITY);
    g[2][4] = newCell(0, SPECIAL.WILDCARD);
    g[2][6] = newCell(0, SPECIAL.FIRE);
    const { cleared, chained } = activate(g, 2, 0, SPECIAL.LINE_H);
    expect(cleared.size).toBe(GRID);                       // whole row still clears
    expect(chained).toEqual([{ r: 2, c: 6, special: SPECIAL.FIRE, type: 0 }]);
  });
});

describe('activate — FIRE only clears live neighbors', () => {
  it('skips already-nulled neighbors instead of scoring empty cells', () => {
    const g = fullGrid(0);
    g[3][4] = null;                                        // cleared by an earlier wave
    g[5][4] = null;
    const { cleared } = activate(g, 4, 4, SPECIAL.FIRE);
    // Source + the two live orthogonal neighbors only.
    expect([...cleared].sort()).toEqual(['4,3', '4,4', '4,5']);
  });

  it('still spreads to all four neighbors when they are live', () => {
    const g = fullGrid(0);
    const { cleared } = activate(g, 4, 4, SPECIAL.FIRE);
    expect([...cleared].sort()).toEqual(['3,4', '4,3', '4,4', '4,5', '5,4']);
  });
});
