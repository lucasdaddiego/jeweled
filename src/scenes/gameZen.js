// Zen mode: infinite play, animated bg, auto-reshuffle, optional Painting overlay.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as painting from '../painting.js';
import * as sound from '../sound.js';
import * as drag from '../dragInput.js';
import * as powerups from '../powerups.js';
import * as wakeLock from '../wakeLock.js';
import * as achievements from '../achievements.js';
import * as overlay from './powerupOverlay.js';
import * as debugHud from '../debugHud.js';
import * as i18n from '../i18n.js';
import * as dialogs from '../dialogs.js';
import {
  tickEffects, tickHint, clearEffects, drawHintButton, wireCascadePresentation,
} from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard, deserializeGrid, serializeGrid } from '../grid.js';
import { todayISO } from '../rng.js';
import { setScene } from '../main.js';

let grid = null;
let cascade = null;
let hint = null;
let buttons = [];
let cursorX = 0, cursorY = 0;
let runEndedScore = null; // set when user clicks End Run
let milestoneFloor = 0;

// Undo power-up. curIdle always holds the latest idle board; a committed
// move shifts it into prevIdle (the pre-move state) BEFORE the move resolves.
// Bounced/invalid swaps re-reach idle without committing, so they only
// refresh curIdle and can't burn the undo target.
let prevIdle = null;
let curIdle = null;

function captureIdle() {
  return {
    grid: serializeGrid(grid),
    score: cascade.score,
    milestoneFloor,
    pendingMilestones: overlay.getPendingMilestones(),
    charges: { ...powerups.getCharges() },
  };
}

// Rewind to the board before the last move. Mutates the existing grid array
// in place — cascade/drag/overlay all hold a reference to it.
function applyUndo() {
  if (!prevIdle || !cascade || cascade.state !== STATE.IDLE) return false;
  // A charge earned by the move being rewound cannot pay for its own rewind.
  if ((prevIdle.charges?.undo ?? 0) <= 0) return false;
  const g2 = deserializeGrid(prevIdle.grid);
  for (let r = 0; r < g2.length; r++) {
    for (let c = 0; c < g2[r].length; c++) grid[r][c] = g2[r][c];
  }
  cascade.score = prevIdle.score;
  cascade.scoreShown = prevIdle.score;
  milestoneFloor = prevIdle.milestoneFloor;
  storage.saveKey('powerups', { charges: { ...prevIdle.charges } });
  overlay.setMilestoneFloor(milestoneFloor);
  overlay.setPendingMilestones(prevIdle.pendingMilestones || 0);
  curIdle = prevIdle;
  prevIdle = null;               // single-step: no undoing the undo
  snapshotSaveState();
  return true;
}

export function enter(args = {}) {
  document.body.className = '';
  clearEffects();   // drop any still-alive FX from the previous run before first draw

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
  // Restore any milestone charge that was earned but unallocated when the
  // run was parked — without this a tab-kill mid-popup ate the charge.
  overlay.setPendingMilestones(args.restoreFrom?.pendingMilestones || 0);
  debugHud.setActiveCascade(cascade);
  // Reserve space for the power-up panel — render picks the side (right on
  // wide viewports, bottom on narrow ones) and uses this as the thickness.
  render.setPanelWidth(render.layout.isNarrow ? 76 : 72);
  if (entryAnim) cascade.playEntryAnimation();

  wireCascadePresentation(cascade, {
    painting,
    onMatchCleared: () => achievements.notifyZenScore(cascade.score),
    onScoreChanged: (newScore) => {
      const earned = powerups.consumeRunMilestones(newScore, milestoneFloor);
      milestoneFloor = earned.floor;
      overlay.setMilestoneFloor(milestoneFloor);
      overlay.notifyMilestoneEarned(earned.count);
    },
    onMoveCommitted: () => { prevIdle = curIdle; },
    onIdleReached: () => {
      curIdle = captureIdle();
      snapshotSaveState();
    },
  });
  prevIdle = null;
  curIdle = captureIdle();
  overlay.setUndoHandler(applyUndo);

  // Ambient pad — the audio half of "zen". Gated internally by the sound
  // setting; stopped on exit.
  sound.startZenPad();

  // Debug handle (only in dev — handy for console manipulation)
  if (typeof window !== 'undefined' && isDebugHost()) window.__zen = { grid, cascade };
  wakeLock.acquire();
}

export function exit() {
  // Park the run instead of ending it — exit() fires on ANY scene swap
  // (Back button, browser nav, SW-update reload), and losing the run to a
  // stats detour felt like data loss. Same policy as Classic: the snapshot
  // (guarded to IDLE inside snapshotSaveState) keeps the run resumable via
  // the title's Continue button; only the explicit End button finalizes.
  if (runEndedScore == null) {
    snapshotSaveState();
  }
  sound.stopZenPad();
  drag.unbind();
  // Exactly one of the two safety nets may own an unallocated milestone charge.
  // A parked run carries its own pendingMilestones inside the snapshot, so the
  // snapshot owns it and overlay.unbind()'s auto-bank must not ALSO pay it out:
  // that minted a fresh charge on every park/resume cycle while the snapshot
  // kept re-offering the same milestone. With no resumable snapshot (run ended,
  // or finalized), the auto-bank stays the only net and still runs.
  if (storage.load().zen.saveState) overlay.setPendingMilestones(0);
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
  // After End, the run is finalized (saveState nulled) — a late idle (e.g. a
  // cascade settling under the save-painting dialog) must not resurrect it.
  if (runEndedScore != null) return;
  storage.saveKey('zen', {
    saveState: {
      grid: serializeGrid(grid),
      score: cascade.score,
      milestoneFloor,
      pendingMilestones: overlay.getPendingMilestones(),
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
    // Guard against a same-frame double-tap re-finalizing (inflating
    // totalRunsPlayed). Set runEndedScore *before* any await so a racing
    // exit() doesn't double-finalize either.
    if (runEndedScore != null) return;
    finalizeRun(cascade.score);
    if (painting.isEnabled()) offerSavePainting();
    else setScene('title');
  }, buttons, cursorX, cursorY);

  drawHintButton(contentR - btnW - 48, hudY + 2, cascade, grid, (h) => { hint = h; }, buttons, cursorX, cursorY, 36);
  render.drawBoard(grid, { shakeAmp: cascade.shakeAmp, settings, hint, idleMs: cascade.idleSinceMs });
  overlay.draw(cursorX, cursorY, buttons);
}

export function onPointer(evt) {
  // Clear the hint only on 'down' — the release ('up') of the tap that PRESSED
  // the hint button would otherwise erase the hint it just granted.
  if (evt.type === 'down') {
    hint = null;
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
  // Keep a gallery thumbnail of the finished painting. Deliberately NOT
  // awaited — capture is best-effort and must never delay the End flow; the
  // debounced storage write lands whenever the encode resolves.
  painting.thumbnailDataURL().then((thumb) => {
    if (!thumb) return;
    const s = storage.load();
    const gallery = [{ dataUrl: thumb, at: new Date().toISOString() },
      ...(s.zen.gallery || [])].slice(0, 12);
    storage.saveKey('zen', { gallery });
  }).catch(() => { /* ignore — keepsake only */ });
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
