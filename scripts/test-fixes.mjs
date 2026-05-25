// Unit tests for the pure-logic fixes from the bug-hunt pass.
//
// Targets the functions that don't require DOM, RAF, or full cascade
// state-machine driving. Lifecycle fixes (dialogs/popstate, dragInput gating)
// are verified separately in the browser.
//
// Run: node scripts/test-fixes.mjs

import { tickBombs, activate } from '../src/specials.js';
import { newCell } from '../src/grid.js';
import { SPECIAL, GRID, TYPES } from '../src/config.js';
import * as powerups from '../src/powerups.js';

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else      { failed++; console.log(`  ✗ FAIL: ${msg}`); }
}

function section(name) { console.log(`\n# ${name}`); }

// Build a synthetic GRID×GRID board with type 0 everywhere by default. Pass
// an overrides map of { "r,c": { type, special, bombCountdown } } to place
// specific cells.
function makeGrid(overrides = {}) {
  const grid = [];
  for (let r = 0; r < GRID; r++) {
    const row = [];
    for (let c = 0; c < GRID; c++) {
      const o = overrides[`${r},${c}`];
      if (o) {
        const cell = newCell(o.type ?? 0, o.special ?? SPECIAL.NONE);
        if (o.bombCountdown != null) cell.bombCountdown = o.bombCountdown;
        row.push(cell);
      } else {
        row.push(newCell(0, SPECIAL.NONE));
      }
    }
    grid.push(row);
  }
  return grid;
}

// ============================================================================
// Phase 2.1: tickBombs respects skip set (bomb-defuse credit fix)
// ============================================================================
section('2.1: tickBombs skip set');
{
  const grid = makeGrid({
    '3,3': { type: 1, special: SPECIAL.TIME_BOMB, bombCountdown: 1 },
    '3,4': { type: 2, special: SPECIAL.TIME_BOMB, bombCountdown: 5 },
  });

  // Without skip: countdown-1 bomb explodes, other ticks down.
  let exploded = tickBombs(grid);
  ok(exploded.length === 1, 'without skip, countdown-1 bomb explodes');
  ok(grid[3][4].bombCountdown === 4, 'without skip, other bomb decrements');

  // Reset for second test
  const grid2 = makeGrid({
    '3,3': { type: 1, special: SPECIAL.TIME_BOMB, bombCountdown: 1 },
    '3,4': { type: 2, special: SPECIAL.TIME_BOMB, bombCountdown: 5 },
  });
  // With skip including (3,3): only (3,4) ticks.
  exploded = tickBombs(grid2, new Set(['3,3']));
  ok(exploded.length === 0, 'with skip, no explosion');
  ok(grid2[3][3].bombCountdown === 1, 'with skip, bomb at (3,3) keeps countdown=1');
  ok(grid2[3][4].bombCountdown === 4, 'with skip, bomb at (3,4) still decrements');
}

// ============================================================================
// Phase 2.5: CB+CB activation no longer re-queues partner
// ============================================================================
section('2.5: CB+CB activation chained set is empty');
{
  const grid = makeGrid({
    '3,3': { type: 1, special: SPECIAL.COLOR_BOMB },
    '3,4': { type: 2, special: SPECIAL.COLOR_BOMB },
    // Pepper in some other cells so the board has stuff to clear.
    '0,0': { type: 3 },
    '7,7': { type: 4, special: SPECIAL.LINE_H },
  });
  const { cleared, chained } = activate(
    grid, 3, 3, SPECIAL.COLOR_BOMB,
    /*partnerType=*/2, Math.random, /*partnerSpecial=*/SPECIAL.COLOR_BOMB, /*selfType=*/1,
  );
  ok(chained.length === 0, 'CB+CB chained set is empty (no spurious re-activations)');
  // Every gem on the board should be cleared
  let allCleared = true;
  for (let r = 0; r < GRID; r++) for (let c = 0; c < GRID; c++) {
    if (grid[r][c] && !cleared.has(`${r},${c}`)) { allCleared = false; break; }
  }
  ok(allCleared, 'CB+CB cleared set contains every populated cell');
}

// ============================================================================
// Phase 2.6: STAR activation includes wildcards in cleared, excludes from rank
// ============================================================================
section('2.6: STAR wildcards behavior');
{
  // 4 type-1 gems, 3 type-2 gems, 1 wildcard with label-1, 1 wildcard with
  // label-2, rest type-0 filler. With filler dominating, top 2 colors are
  // [0, 1] — type-2 is NOT in top 2.
  //
  // Expectations:
  //   - type-0 cells (top 1) → cleared
  //   - type-1 cells (top 2) → cleared
  //   - type-2 non-wildcard cells → NOT cleared (proves rank logic still gates)
  //   - both wildcards → cleared regardless of their label (the fix)
  //   - wildcards never appear in chained (passive specials)
  const overrides = {
    '0,0': { type: 1 }, '0,1': { type: 1 }, '0,2': { type: 1 }, '0,3': { type: 1 },
    '1,0': { type: 2 }, '1,1': { type: 2 }, '1,2': { type: 2 },
    '2,0': { type: 1, special: SPECIAL.WILDCARD },   // wildcard label-1 (in top)
    '2,1': { type: 2, special: SPECIAL.WILDCARD },   // wildcard label-2 (NOT in top)
    '5,5': { type: 0, special: SPECIAL.STAR },       // the activator itself
  };
  const grid = makeGrid(overrides);
  const { cleared, chained } = activate(grid, 5, 5, SPECIAL.STAR, null, Math.random, null, 0);

  ok(cleared.has('5,5'), 'STAR clears its own cell');
  ok(cleared.has('0,0'), 'STAR clears type-1 cells (rank: top 2)');
  ok(cleared.has('2,0'), 'STAR clears wildcard whose label IS in top colors');
  ok(cleared.has('2,1'), 'STAR clears wildcard whose label is NOT in top colors (the fix)');
  ok(!cleared.has('1,0'), 'STAR does NOT clear non-wildcard type-2 cells (out of top 2)');
  // Wildcards should NOT be in chained (they don't chain — passive)
  const wildcardChained = chained.some(ch => ch.r === 2 && (ch.c === 0 || ch.c === 1));
  ok(!wildcardChained, 'STAR does not chain-activate wildcards');
}

// ============================================================================
// Phase 4.4: activateShuffle requires rng
// ============================================================================
section('4.4: activateShuffle requires rng');
{
  const grid = makeGrid();
  let threw = false;
  try {
    powerups.activateShuffle(grid);
  } catch (e) {
    threw = e instanceof TypeError;
  }
  ok(threw, 'activateShuffle throws TypeError when rng omitted');

  // With rng provided, it should succeed
  let result;
  try {
    result = powerups.activateShuffle(grid, Math.random);
  } catch {
    result = null;
  }
  ok(result && result.ok, 'activateShuffle succeeds when rng provided');
}

// ============================================================================
// Phase 2.1 corollary: tickBombs ignores cells whose bombCountdown is null
// ============================================================================
section('2.1 corollary: bombs with null countdown ignored');
{
  const grid = makeGrid({
    '0,0': { type: 1, special: SPECIAL.TIME_BOMB }, // bombCountdown defaults; verify
  });
  // newCell uses TIME_BOMB_START for new TIME_BOMBs; we want to test null.
  grid[0][0].bombCountdown = null;
  const exploded = tickBombs(grid);
  ok(exploded.length === 0, 'TIME_BOMB with null countdown is skipped');
  ok(grid[0][0].bombCountdown === null, 'null countdown is not decremented');
}

// ============================================================================
// Summary
// ============================================================================
console.log(`\n${passed + failed} tests, ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
