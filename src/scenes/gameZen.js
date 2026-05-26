// Zen mode: infinite play, animated bg, auto-reshuffle, optional Painting overlay.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as particles from '../particles.js';
import * as waves from '../waves.js';
import * as bolts from '../bolts.js';
import * as painting from '../painting.js';
import * as drag from '../dragInput.js';
import * as powerups from '../powerups.js';
import * as wakeLock from '../wakeLock.js';
import * as achievements from '../achievements.js';
import * as overlay from './powerupOverlay.js';
import * as debugHud from '../debugHud.js';
import * as i18n from '../i18n.js';
import * as dialogs from '../dialogs.js';
import { tickEffects, tickHint } from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard, deserializeGrid, serializeGrid } from '../grid.js';
import { spawnScore, handleMatchCleared, handleSpecialActivated } from '../floaters.js';
import { todayISO } from '../rng.js';
import { setScene } from '../main.js';
import { SPECIAL } from '../config.js';
import { GEM_PARTICLE_PALETTES } from '../render.js';

let grid = null;
let cascade = null;
let hint = null;
let buttons = [];
let cursorX = 0, cursorY = 0;
let runEndedScore = null; // set when user clicks End Run
let milestoneFloor = 0;

// Used to position the "+N" score floater right after a wave clears
let lastClearCenter = null;

export function enter(args = {}) {
  document.body.className = '';

  let entryAnim = false;
  if (args.restoreFrom) {
    grid = deserializeGrid(args.restoreFrom.grid);
    cascade = new Cascade(grid, { mode: 'zen' });
    cascade.score = args.restoreFrom.score || 0;
    cascade.scoreShown = cascade.score;
    milestoneFloor = args.restoreFrom.milestoneFloor ?? powerups.milestoneFloorForScore(cascade.score);
  } else {
    grid = createBoard();
    cascade = new Cascade(grid, { mode: 'zen' });
    milestoneFloor = 0;
    entryAnim = true;
  }
  if (storage.getSettings().paintingMode) {
    painting.init();
    painting.setEnabled(true);
    painting.clear();
  } else {
    painting.setEnabled(false);
  }

  hint = null;
  runEndedScore = null;
  storage.saveKey('profile', { lastPlayedMode: 'zen' });
  achievements.notifyMode('zen');
  drag.bind(grid, cascade);
  overlay.bind(grid, cascade);
  overlay.reset();
  overlay.setMilestoneFloor(milestoneFloor);
  debugHud.setActiveCascade(cascade);
  // Reserve space for the power-up panel — render picks the side (right on
  // wide viewports, bottom on narrow ones) and uses this as the thickness.
  render.setPanelWidth(render.layout.isNarrow ? 76 : 72);
  if (entryAnim) cascade.playEntryAnimation();

  cascade.onMatchCleared = (cells, depth) => {
    lastClearCenter = handleMatchCleared(cells, depth, {
      render, particles, waves, painting,
      palettes: GEM_PARTICLE_PALETTES,
      haptic: storage.getSettings().haptic !== false,
    });
    achievements.notifyMatchCleared(cells.length, depth);
    achievements.notifyZenScore(cascade.score);
  };
  cascade.onSpecialActivated = (act) => {
    handleSpecialActivated(act, {
      render, waves, bolts, particles,
      palettes: GEM_PARTICLE_PALETTES, SPECIAL,
      haptic: storage.getSettings().haptic !== false,
    });
  };
  cascade.onScoreChanged = (newScore, delta) => {
    if (delta > 0 && lastClearCenter) {
      spawnScore(lastClearCenter.x, lastClearCenter.y - 20, delta,
        render.boardCenterX(), render.layout.hudY + 16);
    }
    const earned = powerups.consumeRunMilestones(newScore, milestoneFloor);
    milestoneFloor = earned.floor;
    overlay.setMilestoneFloor(milestoneFloor);
    overlay.notifyMilestoneEarned(earned.count);
  };
  cascade.onSpecialSpawned = (special) => achievements.notifySpecialSpawned(special);
  cascade.onIdleReached = () => snapshotSaveState();

  // Debug handle (only in dev — handy for console manipulation)
  if (typeof window !== 'undefined' && isDebugHost()) window.__zen = { grid, cascade };
  wakeLock.acquire();
}

export function exit() {
  // Finalize once per run. `runEndedScore != null` means the End button (or
  // a save-painting flow) already ran finalization — don't double-count.
  if (cascade && cascade.score > 0 && runEndedScore == null) {
    finalizeRun(cascade.score);
  }
  drag.unbind();
  overlay.unbind();
  debugHud.setActiveCascade(null);
  wakeLock.release();
  render.setPanelWidth(0);
  // Disable painting so the next non-Zen scene's drawBoard doesn't render
  // leftover brushstrokes underneath gems. render.drawBoard reads
  // painting.isEnabled() globally; only gameZen ever owns the painting layer.
  painting.setEnabled(false);
  document.body.className = '';
  if (typeof window !== 'undefined') delete window.__zen;
}

function finalizeRun(score) {
  runEndedScore = score;
  storage.recordPlayDay(score);
  const s = storage.load();
  if (score > s.zen.bestScore) storage.saveKey('zen', { bestScore: score });
  storage.saveKey('zen', {
    totalRunsPlayed: s.zen.totalRunsPlayed + 1,
    lastPlayedAt: new Date().toISOString(),
    saveState: null,
  });
}

function snapshotSaveState() {
  if (!cascade || cascade.state !== STATE.IDLE) return;
  storage.saveKey('zen', {
    saveState: {
      grid: serializeGrid(grid),
      score: cascade.score,
      milestoneFloor,
      savedAt: new Date().toISOString(),
    },
  });
}

export function update(dt) {
  cascade.update(dt);
  tickEffects(dt);
  hint = tickHint(cascade, grid, hint);
}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];
  const settings = storage.getSettings();

  // HUD strip: aligned to board edges so nothing overflows on narrow screens
  const hudY = render.layout.hudY;
  const boardX = render.layout.boardX;
  const contentR = render.contentRight();
  const titleFont = `bold ${render.responsiveFont(22)}px -apple-system, system-ui, sans-serif`;
  const scoreFont = `bold ${render.responsiveFont(24)}px -apple-system, system-ui, sans-serif`;

  render.drawText(i18n.t('zen.title'), boardX, hudY + 8, { font: titleFont, shadow: true });
  // Center the score across the whole play area (board + right-side panel),
  // not just the board, so it sits visually between the Zen title and End.
  render.drawText(i18n.formatNumber(Math.floor(cascade.scoreShown)), (boardX + contentR) / 2, hudY + 6, {
    font: scoreFont, align: 'center', shadow: true,
  });
  // Match the power-up panel column width on wide viewports so End sits as
  // a square cap above the panel; fall back to standard widths otherwise.
  const btnW = render.layout.panelSide === 'right' && render.layout.panelW > 0
    ? render.layout.panelW
    : (render.layout.isNarrow ? 56 : 76);
  render.drawHitButton(contentR - btnW, hudY + 2, btnW, 36, render.layout.isNarrow ? i18n.t('zen.endShort') : i18n.t('zen.end'), () => {
    // Set runEndedScore *before* any await so a racing exit() doesn't double-finalize.
    finalizeRun(cascade.score);
    if (painting.isEnabled()) offerSavePainting();
    else setScene('title');
  }, buttons, cursorX, cursorY);

  render.drawBoard(grid, { shakeAmp: cascade.shakeAmp, settings, hint, idleMs: cascade.idleSinceMs });
  overlay.draw(cursorX, cursorY, buttons);
}

export function onPointer(evt) {
  hint = null;
  if (evt.type === 'down') {
    if (overlay.isModalOpen()) {
      if (handleOverlayModalButton(evt)) return;
      if (overlay.handlePointer(evt)) return;
      return;
    }
    // Reverse iteration: top-most (most recently drawn) button wins.
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
        b.onClick();
        return;
      }
    }
    if (overlay.handlePointer(evt)) return;
  }
  drag.handle(evt.type, evt.x, evt.y);
}

export function onMove(x, y) {
  cursorX = x; cursorY = y;
  drag.move(x, y);
}

async function offerSavePainting() {
  if (await dialogs.confirm(i18n.t('zen.savePaintingConfirm'))) {
    const blob = await painting.toBlob();
    if (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `jeweled-painting-${todayISO()}.png`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }
  setScene('title');
}

function handleOverlayModalButton(evt) {
  for (let i = buttons.length - 1; i >= 0; i--) {
    const b = buttons[i];
    if (!b.modal) continue;
    if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
      b.onClick();
      return true;
    }
  }
  return false;
}

function isDebugHost() {
  if (typeof location === 'undefined') return false;
  return location.hostname === 'localhost'
    || location.hostname === '127.0.0.1'
    || new URLSearchParams(location.search).has('debug');
}
