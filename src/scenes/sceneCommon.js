// Shared helpers for game scenes (Zen, Classic, Daily, Blitz, Puzzle).
// Each helper covers one chunk that used to be copy-pasted identically across
// the five scene files. The five scenes call these from their own update().

import * as particles from '../particles.js';
import * as floaters from '../floaters.js';
import * as waves from '../waves.js';
import * as bolts from '../bolts.js';
import { STATE } from '../cascade.js';
import { TIMING } from '../config.js';
import { findModestHint } from '../grid.js';

// Tick all the per-frame effect pools. Order is unimportant since none of
// these systems read each other's state during update.
export function tickEffects(dt) {
  particles.update(dt);
  floaters.update(dt);
  waves.update(dt);
  bolts.update(dt);
}

// Compute the next hint value. Returns:
//   - the existing hint when the cascade is mid-action (or hint already shown);
//   - a freshly-computed hint when the cascade has been idle long enough;
//   - null when the cascade is no longer idle.
//
// Scenes call this each frame: `hint = tickHint(cascade, grid, hint)`.
export function tickHint(cascade, grid, hint) {
  if (cascade.state === STATE.IDLE && cascade.idleSinceMs > TIMING.HINT_AFTER) {
    return hint || findModestHint(grid);
  }
  return cascade.state !== STATE.IDLE ? null : hint;
}
