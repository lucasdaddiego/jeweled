// Shared helpers for game scenes (Zen, Classic, Daily, Blitz, Puzzle).
// Each helper covers one chunk that used to be copy-pasted identically across
// the five scene files. The five scenes call these from their own update().

import * as particles from '../particles.js';
import * as floaters from '../floaters.js';
import * as waves from '../waves.js';
import * as bolts from '../bolts.js';
import * as achievements from '../achievements.js';
import * as render from '../render.js';
import * as storage from '../storage.js';
import * as sound from '../sound.js';
import * as i18n from '../i18n.js';
import { STATE } from '../cascade.js';
import { SPECIAL, TIMING } from '../config.js';
import { findModestHint } from '../grid.js';
import {
  spawnScore, handleMatchCleared, handleSpecialActivated,
} from '../floaters.js';
import { GEM_PARTICLE_PALETTES } from '../render.js';
import { clockMs } from '../main.js';

// Tick all the per-frame effect pools. Order is unimportant since none of
// these systems read each other's state during update.
// Also feeds the total play-time counter — every game scene calls this each
// frame, so it's the one natural hook for "time actually in a game".
export function tickEffects(dt) {
  particles.update(dt);
  floaters.update(dt);
  waves.update(dt);
  bolts.update(dt);
  achievements.addPlayTimeMs(dt);
}

// Reset every per-frame effect pool. Game scenes call this from enter() so a
// fresh board never flashes the *previous* run's still-alive floaters/sparks:
// draw() runs before update() on the first frame, and these pools are
// module-level singletons that otherwise persist across scene changes. The
// per-pool clear() helpers already exist; nothing else invokes them.
export function clearEffects() {
  particles.clear();
  floaters.clear();
  waves.clear();
  bolts.clear();
}

// Install the presentation/achievement/audio callbacks shared by every game
// mode. Mode rules stay in the scene through the optional hooks; this helper
// only owns the repeated plumbing around matches, specials, score floaters,
// bomb audio, defuse achievements, and reshuffle notification.
export function wireCascadePresentation(cascade, opts = {}) {
  let lastClearCenter = null;

  cascade.onMatchCleared = (cells, depth) => {
    lastClearCenter = handleMatchCleared(cells, depth, {
      render, particles, waves,
      painting: opts.painting || null,
      palettes: GEM_PARTICLE_PALETTES,
      haptic: storage.getSettings().haptic !== false,
    });
    achievements.notifyMatchCleared(cells.length, depth);
    opts.onMatchCleared?.(cells, depth, lastClearCenter);
  };

  cascade.onSpecialActivated = (act) => {
    handleSpecialActivated(act, {
      render, waves, bolts, particles,
      palettes: GEM_PARTICLE_PALETTES, SPECIAL,
      haptic: storage.getSettings().haptic !== false,
    });
    opts.onSpecialActivated?.(act);
  };

  cascade.onScoreChanged = (newScore, delta) => {
    if (delta > 0 && lastClearCenter) {
      spawnScore(lastClearCenter.x, lastClearCenter.y - 20, delta,
        render.boardCenterX(), render.layout.hudY + 16);
    }
    opts.onScoreChanged?.(newScore, delta, lastClearCenter);
  };

  cascade.onSpecialSpawned = (special) => {
    achievements.notifySpecialSpawned(special);
    opts.onSpecialSpawned?.(special);
  };
  cascade.onBombsDefused = (count) => {
    achievements.notifyBombsDefused(count);
    opts.onBombsDefused?.(count);
  };
  cascade.onBombTick = () => {
    sound.bombTick();
    opts.onBombTick?.();
  };
  cascade.onBombExploded = (cell) => {
    sound.bombBoom();
    opts.onBombExploded?.(cell);
  };
  cascade.onReshuffle = () => {
    floaters.spawnText(
      render.boardCenterX(),
      render.layout.boardY + 24,
      i18n.t('common.reshuffling'),
      '#ffd166',
      18,
    );
    opts.onReshuffle?.();
  };

  if (opts.onMoveCommitted) cascade.onMoveCommitted = opts.onMoveCommitted;
  if (opts.onIdleReached) cascade.onIdleReached = opts.onIdleReached;
}

// Manual hint button — shared by every game scene, drawn to the left of the
// Back/End button. Free but rate-limited so it assists without playing the
// game for you. Returns nothing; on click it feeds a hint to the scene via
// `setHint`.
const HINT_COOLDOWN_MS = 15_000;
export const HINT_BUTTON_W = 42;
let _lastHintAt = -Infinity;

// `h` should match the neighboring Back/End button so the pair reads as one
// aligned control group (Zen/Blitz use 36-tall buttons, the rest 32).
export function drawHintButton(x, y, cascade, grid, setHint, buttons, cursorX, cursorY, h = 32) {
  const ready = clockMs() - _lastHintAt >= HINT_COOLDOWN_MS;
  render.drawHitButton(x, y, HINT_BUTTON_W, h, '💡', () => {
    if (!ready || cascade.state !== STATE.IDLE) return;
    _lastHintAt = clockMs();
    setHint(findModestHint(grid));
  }, buttons, cursorX, cursorY, { disabled: !ready });
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
