// Cascade state machine. Drives swap → validate → resolve → fall → spawn → loop.
//
// Designed to be ticked by main.js's RAF loop with delta-time in ms. No `await`,
// no `setTimeout`. All animations are time-accumulated.

import { GRID, SPECIAL, TIMING, SLOWMO_FACTOR, SLOWMO_MIN_DEPTH, SHAKE_MIN_DEPTH, SCORE, COIN_MULTIPLIER, STAR_CASCADE_TRIGGER, BIG_WAVE_AREA_BOMB, BIG_WAVE_COLOR_BOMB } from './config.js';
import { swap as gridSwap, applyGravity, spawnNew, areAdjacent, newCell } from './grid.js';
import { findMatches, wouldSwapMatch } from './matcher.js';
import { activate as activateSpecial, tickBombs, scoreForClear } from './specials.js';
import { Tween, easings } from './animations.js';

export const STATE = {
  IDLE:                'IDLE',
  SWAPPING:            'SWAPPING',
  RESOLVING:           'RESOLVING',
  ACTIVATING_SPECIALS: 'ACTIVATING_SPECIALS',
  FALLING:             'FALLING',
  SPAWNING:            'SPAWNING',
  REVERTING:           'REVERTING',
  BOUNCING:            'BOUNCING',
  BOMB_EXPLODE:        'BOMB_EXPLODE',
};

export class Cascade {
  constructor(grid, opts = {}) {
    this.grid = grid;
    this.mode = opts.mode || 'zen'; // 'zen' | 'classic' | 'daily'
    this.rng = opts.rng || Math.random;
    this.state = STATE.IDLE;

    // Per-run state
    this.score = 0;
    this.scoreShown = 0;   // displayed score — lerps toward `score` for a rolling readout
    this.cascadeDepth = 0;
    this.gravityDir = 'down';        // for current FALL cycle
    this.gravityFlipNext = false;
    this.slowmoMsRemaining = 0;

    // Active animations: cell.id → { tween, kind } where tween sets cell.renderRow/renderCol/clearAlpha
    this.anims = new Map();
    // Cells flagged for clear this wave (key "r,c") so render can fade them
    this.clearingCells = new Set();

    // Queue of specials to activate during ACTIVATING_SPECIALS
    this.activationQueue = [];
    this.activationQueueIndex = 0;

    // Last swap origin (for swap-prefer-spawn-cell)
    this.lastSwapTo = null;
    // Pending swap (during SWAPPING/REVERTING)
    this._pendingSwap = null;
    this._revertSwap = null;

    // Screen shake amplitude (px), decays each frame
    this.shakeAmp = 0;

    // Event callbacks (set by scene)
    this.onMatchCleared   = null; // (cells: [{r,c,type}], depth) => void
    this.onSpecialSpawned = null; // (special: SPECIAL.*) => void — once per match-promoted spawn
    this.onSpecialActivated = null; // ({r, c, special}) => void
    this.onBombExploded   = null; // (cell:{r,c}) => void  — Classic: deduct 5 moves
    this.onMoveCommitted  = null; // ()=>void  — called once per valid swap (scenes track their own movesLeft)
    this.onIdleReached    = null; // ()=>void  — for save-state snapshot trigger
    this.onScoreChanged   = null; // (newScore, delta) => void
    this.onReshuffle      = null; // ()=>void

    // Hint timer (handled by scene, just expose helper)
    this.idleSinceMs = 0;
  }

  // Called by scene when player taps two adjacent cells. Returns true if accepted.
  // Peeks for validity first; if the swap wouldn't match (and isn't a color-bomb
  // activation), bounces only the source gem back instead of animating both.
  tryStartSwap(a, b) {
    if (this.state !== STATE.IDLE) return false;
    if (!areAdjacent(a, b)) return false;
    const cellA = this.grid[a.r][a.c];
    const cellB = this.grid[b.r][b.c];
    if (!cellA || !cellB) return false;

    // Color-bomb swaps are always valid — they activate on swap. This includes
    // CB+CB (clears the board), CB+any-special (clears all of partner's color
    // and chains the partner's effect), and CB+plain (clears partner's color).
    const isColorBombSwap =
      cellA.special === SPECIAL.COLOR_BOMB || cellB.special === SPECIAL.COLOR_BOMB;

    if (!isColorBombSwap) {
      if (!wouldSwapMatch(this.grid, a, b)) {
        // Invalid swap — bounce only the dragged gem back.
        this.bounceBack(a);
        return false;
      }
    }

    // Valid commit: clear any drag-leftover render override on either side so
    // the swap animation runs the full distance from grid positions (visible,
    // weighty motion). The 1-frame "snap" before the tween starts is imperceptible.
    if (cellA) { cellA.renderRow = null; cellA.renderCol = null; }
    if (cellB) { cellB.renderRow = null; cellB.renderCol = null; }

    this._pendingSwap = { a, b };
    this.state = STATE.SWAPPING;
    this.cascadeDepth = 0;
    this.idleSinceMs = 0;
    this._startSwapAnim(a, b);
    return true;
  }

  // Externally-triggered clear (power-up activation). Treats the given cells
  // as if they were matched, runs the normal resolve → fall → spawn → cascade.
  // Returns true if accepted.
  applyExternalClears(cleared) {
    if (this.state !== STATE.IDLE) return false;
    if (!cleared || cleared.size === 0) return false;
    this.cascadeDepth = 1;
    this._beginResolve(cleared, []);
    return true;
  }

  resolveCurrentMatches(origin = null) {
    if (this.state !== STATE.IDLE) return false;
    const { cleared, toSpawn } = findMatches(this.grid, origin);
    if (cleared.size === 0) {
      this.onIdleReached?.();
      return false;
    }
    this.cascadeDepth = 1;
    this._beginResolve(cleared, toSpawn);
    return true;
  }

  // Animate the cell at `sourcePos` from its current render position back to
  // its grid position. Used when a drag is released over an invalid target
  // or below the commit threshold.
  bounceBack(sourcePos) {
    const cell = this.grid[sourcePos.r]?.[sourcePos.c];
    if (!cell) return;
    if (cell.renderRow == null && cell.renderCol == null) {
      // Nothing to animate.
      return;
    }
    this.state = STATE.BOUNCING;
    // Rubbery elastic for the rebound — clearly signals "nope, try again".
    this._tweenCellTo(cell, sourcePos, sourcePos, TIMING.REVERT, () => {
      this.state = STATE.IDLE;
      this.onIdleReached?.();
    }, easings.easeOutElastic);
  }

  _startSwapAnim(a, b) {
    const cellA = this.grid[a.r][a.c];
    const cellB = this.grid[b.r][b.c];
    if (!cellA || !cellB) return;
    // Animate cellA from a → b and cellB from b → a — spring easing for a
    // satisfying settle at the end of motion.
    this._tweenCellTo(cellA, a, b, TIMING.SWAP, null, easings.easeOutSpring);
    this._tweenCellTo(cellB, b, a, TIMING.SWAP, null, easings.easeOutSpring);
  }

  _tweenCellTo(cell, from, to, duration, onDone, ease = easings.easeOutCubic) {
    // If the cell was already being rendered at a non-grid position (e.g. mid-bounce),
    // start the tween from THERE so the motion is continuous instead of snapping.
    const startRow = (cell.renderRow != null) ? cell.renderRow : from.r;
    const startCol = (cell.renderCol != null) ? cell.renderCol : from.c;
    cell.renderRow = startRow;
    cell.renderCol = startCol;
    const tween = new Tween({
      from: 0, to: 1, duration, ease,
      onUpdate: (k) => {
        cell.renderRow = startRow + (to.r - startRow) * k;
        cell.renderCol = startCol + (to.c - startCol) * k;
      },
      onDone: () => {
        cell.renderRow = null;
        cell.renderCol = null;
        this.anims.delete(cell.id);
        if (onDone) onDone();
      },
    });
    this.anims.set(cell.id, { tween, kind: 'move' });
  }

  _tweenCellFallTo(cell, from, to, duration, onDone) {
    cell.renderRow = from.r;
    cell.renderCol = from.c;
    const tween = new Tween({
      from: 0, to: 1, duration, ease: easings.easeInQuad,
      onUpdate: (k) => {
        cell.renderRow = from.r + (to.r - from.r) * k;
        cell.renderCol = from.c + (to.c - from.c) * k;
      },
      onDone: () => {
        cell.renderRow = null;
        cell.renderCol = null;
        this.anims.delete(cell.id);
        // Squash on land: brief scale flicker, peaks at ~35% then settles.
        this._startSquash(cell, Math.abs(to.r - from.r));
        if (onDone) onDone();
      },
    });
    this.anims.set(cell.id, { tween, kind: 'fall' });
  }

  _startSquash(cell, fallHeight = 1) {
    // Skip squash for trivial moves (gravity-flip "fall" of 0 cells).
    if (fallHeight < 1) return;
    // Use direct fields on the cell instead of a Tween wrapper — avoids ~30
    // Tween allocations per cascade wave during big falls.
    cell.squashAmp = Math.min(0.22, 0.10 + fallHeight * 0.025);
    cell.squashT = 0;
    cell.squashDuration = 260;
    if (!this._squashed) this._squashed = new Set();
    this._squashed.add(cell);
  }

  _tickSquashes(dt) {
    if (!this._squashed || this._squashed.size === 0) return;
    for (const cell of this._squashed) {
      cell.squashT += dt;
      const k = Math.min(cell.squashT / cell.squashDuration, 1);
      if (k >= 1) {
        cell.scaleX = 1; cell.scaleY = 1;
        cell.squashAmp = null; cell.squashT = null; cell.squashDuration = null;
        this._squashed.delete(cell);
      } else {
        const s = Math.sin(k * Math.PI) * cell.squashAmp;
        cell.scaleX = 1 + s;
        cell.scaleY = 1 - s;
      }
    }
  }

  _tweenCellPop(cell, duration, onDone) {
    cell.popScale = 0;
    const tween = new Tween({
      from: 0, to: 1, duration, ease: easings.easeOutBack,
      onUpdate: (k) => { cell.popScale = k; },
      onDone: () => {
        cell.popScale = null;
        this.anims.delete(cell.id);
        if (onDone) onDone();
      },
    });
    this.anims.set(cell.id, { tween, kind: 'pop' });
  }

  _tweenClear(cellKey, duration, onDone, delayMs = 0) {
    // Stash on the cell so render can read it. Drop the previous `fade` closure
    // object — on big cascades that allocated dozens of small objects per wave.
    // Writing directly to cell.clearAlpha skips the indirection.
    const [r, c] = cellKey.split(',').map(Number);
    const cell = this.grid[r][c];
    if (cell) {
      cell.clearAlpha = 1;
      // Pre-clear flash: render adds a white overlay scaled by flashAlpha.
      // The flash fades over its own tween so the eye locks onto matched gems
      // before they disappear.
      cell.flashAlpha = 1;
    }
    const FLASH_MS = 90;
    const flashTween = new Tween({
      from: 1, to: 0, duration: FLASH_MS, delay: delayMs, ease: easings.easeInQuad,
      onUpdate: (v) => { if (cell) cell.flashAlpha = v; },
      onDone: () => { if (cell) cell.flashAlpha = null; },
    });
    this.anims.set('flash:' + cellKey, { tween: flashTween, kind: 'flash' });
    const tween = new Tween({
      from: 1, to: 0, duration, ease: easings.linear, delay: delayMs + FLASH_MS,
      onUpdate: (v) => { if (cell) cell.clearAlpha = v; },
      onDone: () => { onDone?.(); },
    });
    const id = 'clear:' + cellKey;
    this.anims.set(id, { tween, kind: 'clear' });
  }

  update(dt) {
    // dt scaling for slow-mo
    let effDt = dt;
    if (this.slowmoMsRemaining > 0) {
      effDt = dt * SLOWMO_FACTOR;
      this.slowmoMsRemaining -= dt;
      if (this.slowmoMsRemaining < 0) this.slowmoMsRemaining = 0;
    }

    // Tick all running tweens, deleting finished ones inline. The Map spec
    // allows deleting the current entry during iteration without skipping the
    // next one, so we avoid the [...this.anims] spread that used to copy the
    // whole Map every frame.
    let stillAnimating = false;
    for (const [id, entry] of this.anims) {
      entry.tween.update(effDt);
      if (entry.onTick) entry.onTick(entry.tween.value);
      if (entry.tween.done) this.anims.delete(id);
      else stillAnimating = true;
    }
    // Tick lightweight cell squashes (separate pool, no Tween allocation)
    this._tickSquashes(effDt);

    // Shake decay
    if (this.shakeAmp > 0) {
      this.shakeAmp *= Math.pow(0.85, dt / 16);
      if (this.shakeAmp < 0.5) this.shakeAmp = 0;
    }

    // Score roll — lerp the displayed score toward the actual score so big
    // wave bonuses animate up like a slot machine instead of snapping.
    if (this.scoreShown !== this.score) {
      const diff = this.score - this.scoreShown;
      // Settle within ~500ms for any jump; minimum 1 unit per frame so the
      // last digit doesn't crawl when within rounding distance.
      const step = Math.max(1, Math.abs(diff) * dt / 500);
      if (Math.abs(diff) <= step) this.scoreShown = this.score;
      else this.scoreShown += Math.sign(diff) * step;
    }

    // Idle tracking
    if (this.state === STATE.IDLE) {
      this.idleSinceMs += dt;
      return;
    }
    this.idleSinceMs = 0;

    if (stillAnimating) return;

    // Animations done — advance state
    switch (this.state) {
      case STATE.SWAPPING: this._afterSwap(); break;
      case STATE.REVERTING: this._afterRevert(); break;
      case STATE.RESOLVING: this._afterResolve(); break;
      case STATE.ACTIVATING_SPECIALS: this._afterActivations(); break;
      case STATE.FALLING: this._afterFall(); break;
      case STATE.SPAWNING: this._afterSpawn(); break;
      case STATE.BOMB_EXPLODE: this._afterBombExplode(); break;
      case STATE.BOUNCING:
        // Safety net: bounce tween's onDone normally returns to IDLE.
        // Fallback to IDLE if we ever reach this with no animation pending.
        this.state = STATE.IDLE;
        this.onIdleReached?.();
        break;
    }
  }

  _afterSwap() {
    const { a, b } = this._pendingSwap;
    // Commit grid swap
    gridSwap(this.grid, a, b);
    this.lastSwapTo = b;
    // Color-bomb activation by swap (special interaction).
    // After the gridSwap above, cellA is at `a` and cellB is at `b` (positions
    // are post-swap), but the references below still point to the same objects.
    const cellA = this.grid[a.r][a.c];
    const cellB = this.grid[b.r][b.c];
    let colorBombResult = null;
    if (cellA && cellA.special === SPECIAL.COLOR_BOMB) {
      colorBombResult = {
        bombCell: a,
        partnerCell: b,
        partnerType: cellB?.type,
        partnerSpecial: cellB?.special || null,
      };
    } else if (cellB && cellB.special === SPECIAL.COLOR_BOMB) {
      colorBombResult = {
        bombCell: b,
        partnerCell: a,
        partnerType: cellA?.type,
        partnerSpecial: cellA?.special || null,
      };
    }

    const { cleared, toSpawn } = findMatches(this.grid, b);

    if (!colorBombResult && cleared.size === 0) {
      // Invalid swap — revert
      this._revertSwap = { a, b };
      this._pendingSwap = null;
      this.state = STATE.REVERTING;
      this._startSwapAnim(b, a);
      return;
    }

    this._pendingSwap = null;
    // Valid move — commit it
    this.onMoveCommitted?.();

    // Decrement bombs (player move). Exploded bombs are nulled out so they
    // don't keep ticking into negative countdowns. Gravity will refill the
    // empty cell on the next cascade fall step. The scene's onBombExploded
    // callback handles the move penalty + particle burst for visual feedback.
    //
    // Pass `cleared` so bombs inside the winning match aren't decremented —
    // they're about to earn the defuse bonus via _beginResolve, not explode.
    const exploded = tickBombs(this.grid, cleared);
    if (exploded.length > 0) {
      for (const e of exploded) {
        this.onBombExploded?.(e);
        this.grid[e.r][e.c] = null;
      }
    }

    // If color-bomb was swapped, queue its activation. If the swap *also*
    // formed an incidental match (rare but possible — e.g. CB+striped that
    // happens to complete a row-3 elsewhere), resolve that match first and
    // let the CB activation chain from the queue when its clear wave settles.
    // Without this branch, the incidental cleared/toSpawn from findMatches
    // above would be silently discarded.
    if (colorBombResult) {
      this.cascadeDepth = 1;
      const bombCell = this.grid[colorBombResult.bombCell.r][colorBombResult.bombCell.c];
      this.activationQueue.push({
        r: colorBombResult.bombCell.r,
        c: colorBombResult.bombCell.c,
        special: SPECIAL.COLOR_BOMB,
        type: bombCell?.type ?? 0,
        partnerType: colorBombResult.partnerType,
        partnerSpecial: colorBombResult.partnerSpecial,
      });
      // CB + non-CB effect-special swap: queue the partner's own effect to
      // fire after the CB clears partner-color. The partner cell will be
      // null in the grid by then (CB cleared it), but activateSpecial reads
      // selfType from the queue entry so the effect still resolves. CB+CB is
      // handled inside activateSpecial (full board wipe); WILDCARD / COIN /
      // GRAVITY / TIME_BOMB are passive or non-effect specials and shouldn't
      // chain a second activation.
      const ps = colorBombResult.partnerSpecial;
      if (ps === SPECIAL.LINE_H || ps === SPECIAL.LINE_V || ps === SPECIAL.AREA_BOMB ||
          ps === SPECIAL.FIRE   || ps === SPECIAL.LIGHTNING || ps === SPECIAL.STAR) {
        this.activationQueue.push({
          r: colorBombResult.partnerCell.r,
          c: colorBombResult.partnerCell.c,
          special: ps,
          type: colorBombResult.partnerType,
        });
      }
      if (cleared.size > 0) {
        // Incidental match alongside the CB swap — let _beginResolve handle
        // it; _afterResolve will process the queued CB activation next.
        this._beginResolve(cleared, toSpawn);
      } else {
        // CB swap alone — go straight to activation.
        this.activationQueueIndex = 0;
        this.clearingCells = new Set();
        this.state = STATE.ACTIVATING_SPECIALS;
        this._afterActivations();
      }
      return;
    }

    if (cleared.size === 0) {
      // Shouldn't happen but safe
      this.state = STATE.IDLE;
      this.onIdleReached?.();
      return;
    }

    this.cascadeDepth = 1;
    this._beginResolve(cleared, toSpawn);
  }

  _afterRevert() {
    const { a, b } = this._revertSwap;
    gridSwap(this.grid, a, b);
    this._revertSwap = null;
    this.state = STATE.IDLE;
    this.onIdleReached?.();
  }

  _beginResolve(cleared, toSpawn) {
    this.clearingCells = new Set(cleared);
    if (this.activationQueueIndex >= this.activationQueue.length) {
      this.activationQueue = [];
      this.activationQueueIndex = 0;
    }

    // Scan cleared cells for special effects:
    // - TIME_BOMB → defuse bonus
    // - GRAVITY  → flip gravity next fall
    // - COIN     → multiply score for this wave
    // - FIRE/LIGHTNING/STAR → queue chain activation
    let defuseBonus = 0;
    let coinMultiplier = 1;
    for (const key of cleared) {
      const [r, c] = key.split(',').map(Number);
      const cell = this.grid[r][c];
      if (!cell) continue;
      if (cell.special === SPECIAL.TIME_BOMB) defuseBonus += SCORE.BOMB_DEFUSE_BONUS;
      if (cell.special === SPECIAL.GRAVITY)   this.gravityFlipNext = true;
      if (cell.special === SPECIAL.COIN)      coinMultiplier *= COIN_MULTIPLIER;
      // Chain-activate any "effect" special that was incidentally cleared as
      // part of a plain match — line gems, area bombs, fire, lightning, star,
      // and even color bombs all fire their effect. Skip GRAVITY/TIME_BOMB/COIN/
      // WILDCARD (those have non-clear effects handled above or are passive).
      if (cell.special === SPECIAL.FIRE ||
          cell.special === SPECIAL.LIGHTNING ||
          cell.special === SPECIAL.STAR ||
          cell.special === SPECIAL.LINE_H ||
          cell.special === SPECIAL.LINE_V ||
          cell.special === SPECIAL.AREA_BOMB ||
          cell.special === SPECIAL.COLOR_BOMB) {
        this.activationQueue.push({ r, c, special: cell.special, type: cell.type });
      }
    }

    // Spawn a STAR once when cascade hits trigger depth. Scan all cleared
    // cells (not just the first) so a collision with a matcher-promoted
    // spawn at the first cell doesn't silently drop the STAR.
    if (this.cascadeDepth === STAR_CASCADE_TRIGGER) {
      const occupied = new Set(toSpawn.map(s => `${s.r},${s.c}`));
      for (const key of cleared) {
        if (occupied.has(key)) continue;
        const [sr, sc] = key.split(',').map(Number);
        const cell = this.grid[sr][sc];
        toSpawn.push({ r: sr, c: sc, special: SPECIAL.STAR, type: cell?.type ?? 0 });
        break;
      }
    }

    // Big-wave bonus: a single wave that clears many cells spawns an extra special.
    // Iterate cleared cells (excluding ones already reserved by matcher promotion)
    // and pick one that doesn't already have a toSpawn entry.
    if (cleared.size >= BIG_WAVE_AREA_BOMB) {
      const promoteTo = cleared.size >= BIG_WAVE_COLOR_BOMB ? SPECIAL.COLOR_BOMB : SPECIAL.AREA_BOMB;
      const occupied = new Set(toSpawn.map(s => `${s.r},${s.c}`));
      for (const key of cleared) {
        if (occupied.has(key)) continue;
        const [br, bc] = key.split(',').map(Number);
        const cell = this.grid[br][bc];
        toSpawn.push({ r: br, c: bc, special: promoteTo, type: cell?.type ?? 0 });
        break;
      }
    }

    // Score the wave (coin multiplier applies to the gem score; bonuses are flat)
    const gemsScore = scoreForClear(cleared.size, this.cascadeDepth) * coinMultiplier;
    const total = gemsScore + defuseBonus;
    this.score += total;

    // Spawn clear animations — stagger each cell along the row/col so a match
    // reads like a fuse lighting rather than a simultaneous pop.
    const STAGGER_MS = 28;
    // Sort cells so stagger goes top→bottom then left→right (stable, readable).
    const sortedKeys = [...cleared].sort((a, b) => {
      const [ar, ac] = a.split(',').map(Number);
      const [br, bc] = b.split(',').map(Number);
      return ar - br || ac - bc;
    });
    for (let i = 0; i < sortedKeys.length; i++) {
      this._tweenClear(sortedKeys[i], TIMING.CLEAR, null, i * STAGGER_MS);
    }

    // Emit match-cleared BEFORE onScoreChanged: scenes use the callback's
    // centroid to position the "+N" floater, so they need to receive it
    // before the score callback fires.
    if (this.onMatchCleared) {
      const cells = [];
      for (const key of cleared) {
        const [r, c] = key.split(',').map(Number);
        const cell = this.grid[r][c];
        if (cell) cells.push({ r, c, type: cell.type, special: cell.special });
      }
      this.onMatchCleared(cells, this.cascadeDepth);
    }
    this.onScoreChanged?.(this.score, total);

    // Shake + slowmo triggers
    if (this.cascadeDepth >= SHAKE_MIN_DEPTH) {
      this.shakeAmp = Math.min(this.cascadeDepth * 2, 14);
    }
    if (this.cascadeDepth >= SLOWMO_MIN_DEPTH) {
      this.slowmoMsRemaining = TIMING.SLOWMO_MS;
    }

    // Stash specials-to-spawn for after clear; placed before activation chain
    this._pendingSpawns = toSpawn;
    this.state = STATE.RESOLVING;
  }

  _afterResolve() {
    // Clear cells (preserving any new specials we're about to place via _pendingSpawns)
    const protectedKeys = new Set();
    if (this._pendingSpawns) {
      for (const s of this._pendingSpawns) protectedKeys.add(`${s.r},${s.c}`);
    }

    for (const key of this.clearingCells) {
      const [r, c] = key.split(',').map(Number);
      if (protectedKeys.has(key)) continue;
      this.grid[r][c] = null;
    }
    // Place specials at protected cells (overwrite the existing gem with the special)
    if (this._pendingSpawns) {
      for (const s of this._pendingSpawns) {
        // Notify scene-side listeners (e.g. achievements) about each special spawn.
        if (this.onSpecialSpawned) this.onSpecialSpawned(s.special);
        // Borrow the next id from grid.js implicit id system by reusing existing cell shape
        const cur = this.grid[s.r][s.c];
        if (cur) {
          cur.type = s.type;
          cur.special = s.special;
          cur.bombCountdown = null;
          cur.clearAlpha = undefined;
        } else {
          // If cell got nulled out (shouldn't), create a fresh one with a proper id.
          this.grid[s.r][s.c] = newCell(s.type, s.special);
        }
        // Score bonus for spawning a special
        this.score += SCORE.SPECIAL_SPAWN_BONUS;
        this.onScoreChanged?.(this.score, SCORE.SPECIAL_SPAWN_BONUS);
      }
    }
    this.clearingCells.clear();
    this._pendingSpawns = null;

    // _beginResolve already queued every effect-bearing special found in the
    // cleared set (LINE_H/V, AREA_BOMB, COLOR_BOMB, FIRE, LIGHTNING, STAR),
    // capturing their `type` *before* nulling. Activation runs against the now-
    // nulled cells using the captured type as `selfType`.
    if (this.activationQueue.length > 0) {
      this.state = STATE.ACTIVATING_SPECIALS;
      this._afterActivations();
    } else {
      this._beginFall();
    }
  }

  _afterActivations() {
    // Process activations one wave at a time. Loop (don't recurse) over
    // no-op activations to avoid an unbounded-recursion stack-overflow risk
    // on long chains where many queued activations target already-cleared cells.
    while (this.activationQueueIndex < this.activationQueue.length) {
      const a = this.activationQueue[this.activationQueueIndex++];
      const { cleared, chained } = activateSpecial(
        this.grid, a.r, a.c, a.special, a.partnerType, this.rng, a.partnerSpecial, a.type,
      );
      if (cleared.size === 0) continue;

      // Pre-extract target coordinates so scenes can draw effects (lightning
       // arcs, fire spread, star trails) before the clear animations consume
       // the cell data.
      const targets = [];
      for (const key of cleared) {
        const [tr, tc] = key.split(',').map(Number);
        if (tr === a.r && tc === a.c) continue;     // skip the source itself
        targets.push({ r: tr, c: tc });
      }
      this.onSpecialActivated?.({ r: a.r, c: a.c, special: a.special, targets });
      // Queue further chains
      for (const ch of chained) this.activationQueue.push(ch);
      // Credit any TIME_BOMBs hit by the activation's clear set. Bombs that
      // were in the *original* match are already credited by _beginResolve and
      // nulled by _afterResolve, so we only ever see bombs caught by a chain
      // activation here.
      const defuseBonus = this._creditBombDefuses(cleared);
      // Score the activation
      this.cascadeDepth = Math.max(this.cascadeDepth, 1);
      const gainedScore = scoreForClear(cleared.size, this.cascadeDepth) + defuseBonus;
      this.score += gainedScore;
      // Animate clear
      this.clearingCells = new Set(cleared);
      if (this.onMatchCleared) {
        const cells = [];
        for (const key of cleared) {
          const [r, c] = key.split(',').map(Number);
          const cell = this.grid[r][c];
          if (cell) cells.push({ r, c, type: cell.type, special: cell.special });
        }
        this.onMatchCleared(cells, this.cascadeDepth);
      }
      // Fire score callback AFTER onMatchCleared so scenes that read the
      // cleared centroid (lastClearCenter) have it set for the +N floater.
      this.onScoreChanged?.(this.score, gainedScore);
      // Same staggered clear used in _beginResolve so special-gem follow-ups
      // also read as a fuse-lighting wave rather than a flat simultaneous pop.
      const ACTIVATION_STAGGER_MS = 28;
      const sortedKeys = [...cleared].sort((a, b) => {
        const [ar, ac] = a.split(',').map(Number);
        const [br, bc] = b.split(',').map(Number);
        return ar - br || ac - bc;
      });
      for (let i = 0; i < sortedKeys.length; i++) {
        this._tweenClear(sortedKeys[i], TIMING.CLEAR, null, i * ACTIVATION_STAGGER_MS);
      }
      // Will come back through _afterResolve → _afterActivations after the
      // clear tweens finish, picking up the next item from the queue.
      this.state = STATE.RESOLVING;
      return;
    }
    this.activationQueue = [];
    this.activationQueueIndex = 0;
    this._beginFall();
  }

  _beginFall() {
    this.gravityDir = this.gravityFlipNext ? 'up' : 'down';
    this.gravityFlipNext = false;
    const moves = applyGravity(this.grid, this.gravityDir);
    if (moves.length === 0) {
      this._beginSpawn();
      return;
    }
    for (const m of moves) {
      this._tweenCellFallTo(m.cell, m.from, m.to, TIMING.FALL);
    }
    this.state = STATE.FALLING;
  }

  _afterFall() { this._beginSpawn(); }

  _beginSpawn() {
    const spawns = spawnNew(this.grid, this.rng, this.gravityDir);
    if (spawns.length === 0) {
      this._afterSpawn();
      return;
    }
    for (const s of spawns) {
      // Animate fall from fromY (off-board) to s.r
      this._tweenCellFallTo(s.cell, { r: s.fromY, c: s.c }, { r: s.r, c: s.c }, TIMING.FALL);
    }
    this.state = STATE.SPAWNING;
  }

  _afterSpawn() {
    // Re-validate for cascades
    const { cleared, toSpawn } = findMatches(this.grid, null);
    if (cleared.size > 0) {
      this.cascadeDepth++;
      this._beginResolve(cleared, toSpawn);
      return;
    }
    // No more matches — back to IDLE. We don't reshuffle in Zen anymore:
    // spawnNew has already biased a new gem's type to guarantee a valid move
    // exists. The board layout the player sees is the same one that fell in.
    this.state = STATE.IDLE;
    this.onIdleReached?.();
  }


  // Sum BOMB_DEFUSE_BONUS for every TIME_BOMB still alive in the grid at the
  // given cleared positions. _beginResolve folds this into its bigger
  // multi-effect scan; _afterActivations calls this directly so that bombs
  // caught by chain activations also credit the player.
  _creditBombDefuses(cleared) {
    let bonus = 0;
    for (const key of cleared) {
      const [r, c] = key.split(',').map(Number);
      const cell = this.grid[r]?.[c];
      if (cell && cell.special === SPECIAL.TIME_BOMB) {
        bonus += SCORE.BOMB_DEFUSE_BONUS;
      }
    }
    return bonus;
  }

  _afterBombExplode() {
    this.state = STATE.IDLE;
    this.onIdleReached?.();
  }

  // Scene-entrance animation: every cell drops in from above into its final
  // row, with a small per-column stagger so the board reads as a wave rather
  // than a single thud. Blocks input until the last gem lands.
  playEntryAnimation() {
    const rows = this.grid.length;
    const cols = this.grid[0]?.length || 0;
    this.state = STATE.FALLING;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const cell = this.grid[r][c];
        if (!cell) continue;
        const fromRow = r - rows - 1;     // start above the board
        const colStagger = c * 18;        // per-column delay (ms)
        const rowStagger = r * 12;        // slight extra by row so corners feel hand-placed
        cell.renderRow = fromRow;
        cell.renderCol = c;
        const tween = new Tween({
          from: 0, to: 1,
          duration: TIMING.FALL * 1.4,
          delay: colStagger + rowStagger,
          ease: easings.easeInQuad,
          onUpdate: (k) => {
            cell.renderRow = fromRow + (r - fromRow) * k;
          },
          onDone: () => {
            cell.renderRow = null;
            cell.renderCol = null;
            this.anims.delete(cell.id);
            this._startSquash(cell, 1.2);
          },
        });
        this.anims.set(cell.id, { tween, kind: 'entry' });
      }
    }
    // After the last tween (including its delay) the scene will naturally
    // transition to IDLE via the update() loop's "no more anims" branch
    // (FALLING → _afterFall → _beginSpawn → _afterSpawn → IDLE).
  }
}
