// Shared drag-to-swap handler for game scenes.
//
// While dragging the source gem along the dominant axis, the would-be swap
// partner is mirrored in the opposite direction so the user gets a visible
// preview of the swap. On release with a sufficient delta, the cascade picks
// up where we left off without snapping; on too-small a delta, both gems snap
// back to their grid positions.

import * as render from './render.js';
import { STATE } from './cascade.js';
import { GRID } from './config.js';

const COMMIT_THRESHOLD = 0.35; // fraction of a cell to count as a directional commit

let grid = null;
let cascade = null;
// Active drag: { source:{r,c}, startX, startY, cellRef,
//                partnerCell, partnerR, partnerC }
let active = null;

export function bind(g, c) { grid = g; cascade = c; active = null; }
export function unbind() {
  if (active) clearRender(active.cellRef, active.partnerCell);
  grid = null; cascade = null; active = null;
}

export function handle(type, x, y) {
  if (type === 'down') down(x, y);
  else if (type === 'up') up(x, y);
  else if (type === 'cancel') cancel();
}

function down(x, y) {
  if (!grid || !cascade || cascade.state !== STATE.IDLE) return;
  const cell = render.screenToCell(x, y);
  if (!cell) return;
  const cellRef = grid[cell.r][cell.c];
  if (!cellRef) return;
  active = {
    source: cell, startX: x, startY: y, cellRef,
    partnerCell: null, partnerR: 0, partnerC: 0,
  };
  // Lift on touch — the gem grows slightly so the finger feels anchored.
  cellRef.scaleX = 1.08;
  cellRef.scaleY = 1.08;
}

export function move(x, y) {
  if (!active) return;
  const cs = render.getCellSize();
  const dx = (x - active.startX) / cs;
  const dy = (y - active.startY) / cs;
  // Dominant-axis lock so the gem only moves H or V
  let mx = 0, my = 0;
  if (Math.abs(dx) > Math.abs(dy)) {
    mx = clamp(dx, -1, 1);
  } else {
    my = clamp(dy, -1, 1);
  }
  // Bounds: don't drag off the edge of the board.
  if (mx > 0 && active.source.c === GRID - 1) mx = 0;
  if (mx < 0 && active.source.c === 0) mx = 0;
  if (my > 0 && active.source.r === GRID - 1) my = 0;
  if (my < 0 && active.source.r === 0) my = 0;

  // Only the dragged gem moves visually. The neighbor stays put so that an
  // invalid drop only requires bouncing the dragged gem back (not both).
  active.cellRef.renderRow = active.source.r + my;
  active.cellRef.renderCol = active.source.c + mx;
}

function up(x, y) {
  if (!active) return;
  // If the cascade moved out of IDLE between `down` and `up` (e.g. a previous
  // swap's resolution kicked in), don't try to start another swap. Just clean
  // up the dragged gem's render state and bail — without this, tryStartSwap
  // silently returns false and the gem can be left visually offset until the
  // next bounceBack call.
  if (!cascade || cascade.state !== STATE.IDLE) {
    if (active.cellRef) {
      active.cellRef.renderRow = null;
      active.cellRef.renderCol = null;
      active.cellRef.scaleX = 1;
      active.cellRef.scaleY = 1;
    }
    active = null;
    return;
  }

  const cs = render.getCellSize();
  const dx = (x - active.startX) / cs;
  const dy = (y - active.startY) / cs;

  let target = null;
  if (Math.abs(dx) > Math.abs(dy)) {
    if (dx > COMMIT_THRESHOLD)       target = { r: active.source.r,     c: active.source.c + 1 };
    else if (dx < -COMMIT_THRESHOLD) target = { r: active.source.r,     c: active.source.c - 1 };
  } else {
    if (dy > COMMIT_THRESHOLD)       target = { r: active.source.r + 1, c: active.source.c     };
    else if (dy < -COMMIT_THRESHOLD) target = { r: active.source.r - 1, c: active.source.c     };
  }

  const inBounds = target && target.r >= 0 && target.r < GRID && target.c >= 0 && target.c < GRID;
  // Release the lift — cascade will manage scale during the swap animation
  // (it tweens to 1.0 anyway). Resetting here means an invalid bounce-back
  // doesn't stay puffed up while it elastically returns.
  if (active.cellRef) {
    active.cellRef.scaleX = 1;
    active.cellRef.scaleY = 1;
  }
  if (inBounds) {
    // Don't reset renderRow/Col — cascade peeks for a match and either commits
    // (continuing the swap animation from where we are) or bounces the dragged
    // gem back to source on its own.
    cascade.tryStartSwap(active.source, target);
  } else {
    // Below threshold or out of bounds: bounce the dragged gem back to grid.
    if (cascade && cascade.bounceBack) {
      cascade.bounceBack(active.source);
    } else if (active.cellRef) {
      active.cellRef.renderRow = null;
      active.cellRef.renderCol = null;
    }
  }
  active = null;
}

function clearRender(a, b) {
  if (a) { a.renderRow = null; a.renderCol = null; a.scaleX = 1; a.scaleY = 1; }
  if (b) { b.renderRow = null; b.renderCol = null; b.scaleX = 1; b.scaleY = 1; }
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

export function cancel() {
  if (active) clearRender(active.cellRef, null);
  active = null;
}
