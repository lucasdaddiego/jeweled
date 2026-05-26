// Classic mode: 20 levels, score-target with N moves, stars on win, persists progress.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as particles from '../particles.js';
import * as waves from '../waves.js';
import * as bolts from '../bolts.js';
import * as drag from '../dragInput.js';
import * as powerups from '../powerups.js';
import * as wakeLock from '../wakeLock.js';
import * as achievements from '../achievements.js';
import * as overlay from './powerupOverlay.js';
import * as debugHud from '../debugHud.js';
import * as i18n from '../i18n.js';
import { tickEffects, tickHint } from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard, deserializeGrid, serializeGrid } from '../grid.js';
import { spawnScore, handleMatchCleared, handleSpecialActivated } from '../floaters.js';
import { setScene, clockMs } from '../main.js';
import { SPECIAL } from '../config.js';
import { LEVELS, getLevel, starsFor } from '../levels.js';
import { GEM_PARTICLE_PALETTES } from '../render.js';

let grid = null;
let cascade = null;
let hint = null;
let lastClearCenter = null;
// (wakeLock state lives in the wakeLock module — single module-level handle)
let buttons = [];
let cursorX = 0, cursorY = 0;
let levelNum = 1;
let moves = 30;
let target = 500;
let movesLeft = 30;
let resultTriggered = false;
let milestoneFloor = 0;

export function enter(args = {}) {
  document.body.className = '';

  let entryAnim = false;
  if (args.restoreFrom) {
    grid = deserializeGrid(args.restoreFrom.grid);
    levelNum = args.restoreFrom.level || 1;
    movesLeft = args.restoreFrom.movesLeft;
    cascade = new Cascade(grid, { mode: 'classic' });
    cascade.score = args.restoreFrom.score || 0;
    cascade.scoreShown = cascade.score;
    milestoneFloor = args.restoreFrom.milestoneFloor ?? powerups.milestoneFloorForScore(cascade.score);
  } else {
    levelNum = args.level || 1;
    const def = getLevel(levelNum);
    moves = def.moves; target = def.targetScore; movesLeft = def.moves;
    grid = createBoard();
    cascade = new Cascade(grid, { mode: 'classic' });
    milestoneFloor = 0;
    entryAnim = true;
  }
  // Always refresh moves/target from definition (in case of restore)
  const def = getLevel(levelNum);
  moves = def.moves; target = def.targetScore;
  if (args.restoreFrom == null) movesLeft = moves;

  resultTriggered = false;
  hint = null;
  storage.saveKey('profile', { lastPlayedMode: 'classic' });
  drag.bind(grid, cascade);
  overlay.bind(grid, cascade);
  overlay.reset();
  overlay.setMilestoneFloor(milestoneFloor);
  debugHud.setActiveCascade(cascade);
  render.setPanelWidth(render.layout.isNarrow ? 76 : 72);
  if (entryAnim) cascade.playEntryAnimation();

  cascade.onMatchCleared = (cells, depth) => {
    lastClearCenter = handleMatchCleared(cells, depth, {
      render, particles, waves,
      palettes: GEM_PARTICLE_PALETTES,
      haptic: storage.getSettings().haptic !== false,
    });
    achievements.notifyMatchCleared(cells.length, depth);
  };
  cascade.onSpecialActivated = (act) => {
    handleSpecialActivated(act, {
      render, waves, bolts, particles,
      palettes: GEM_PARTICLE_PALETTES, SPECIAL,
      haptic: storage.getSettings().haptic !== false,
    });
  };
  cascade.onMoveCommitted = () => { movesLeft--; };
  cascade.onBombExploded = () => { movesLeft = Math.max(0, movesLeft - 5); };
  cascade.onIdleReached = () => {
    snapshotSaveState();
    checkWinLose();
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

  wakeLock.acquire();
}

export function exit() {
  // Last-chance snapshot so the player doesn't lose their progress if they
  // back out mid-level. snapshotSaveState guards on state === IDLE itself,
  // so it'll only persist when it's safe to restore from.
  snapshotSaveState();
  drag.unbind();
  overlay.unbind();
  debugHud.setActiveCascade(null);
  wakeLock.release();
  render.setPanelWidth(0);
  document.body.className = '';
}

function snapshotSaveState() {
  if (!cascade || cascade.state !== STATE.IDLE) return;
  if (resultTriggered) return;
  storage.saveKey('classic', {
    saveState: {
      grid: serializeGrid(grid),
      score: cascade.score,
      level: levelNum,
      movesLeft,
      milestoneFloor,
      savedAt: new Date().toISOString(),
    },
  });
}

function checkWinLose() {
  if (resultTriggered) return;
  if (cascade.score >= target) {
    resultTriggered = true;
    finalizeWin();
  } else if (movesLeft <= 0) {
    resultTriggered = true;
    finalizeLose();
  }
}

function finalizeWin() {
  const s = storage.load();
  const stars = starsFor(cascade.score, target);
  const existing = s.classic.levels[String(levelNum)] || { bestScore: 0, starsEarned: 0 };
  const updatedLevels = { ...s.classic.levels };
  updatedLevels[String(levelNum)] = {
    bestScore: Math.max(existing.bestScore, cascade.score),
    starsEarned: Math.max(existing.starsEarned, stars),
    completedAt: new Date().toISOString(),
  };
  const newHighest = Math.max(s.classic.highestUnlocked, Math.min(levelNum + 1, LEVELS.length));
  storage.saveKey('classic', {
    levels: updatedLevels,
    highestUnlocked: newHighest,
    saveState: null,
  });
  storage.recordPlayDay(cascade.score);
  achievements.notifyLevelWin(levelNum);
  setScene('result', { mode: 'classic', outcome: 'win', score: cascade.score, level: levelNum, target, stars });
}

function finalizeLose() {
  storage.saveKey('classic', { saveState: null });
  storage.recordPlayDay(cascade.score);
  setScene('result', { mode: 'classic', outcome: 'lose', score: cascade.score, level: levelNum, target });
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

  const hudY = render.layout.hudY;
  const boardX = render.layout.boardX;
  const boardR = render.boardRight();
  const contentR = render.contentRight();
  const boardW = render.layout.boardSize;
  const titleFont = `bold ${render.responsiveFont(20)}px -apple-system, system-ui, sans-serif`;
  const scoreFont = `bold ${render.responsiveFont(18)}px -apple-system, system-ui, sans-serif`;
  const subFont   = `${render.responsiveFont(14)}px -apple-system, system-ui, sans-serif`;

  // Row 1: Level | Score / Target | Back
  render.drawText(i18n.t('classic.level', { n: levelNum }), boardX, hudY + 6, { font: titleFont, shadow: true });
  // Center the score/target across the play area (board + right-side panel)
  // so it stays visually between the Level label and Back button.
  render.drawText(
    `${i18n.formatNumber(Math.floor(cascade.scoreShown))} / ${i18n.formatNumber(target)}`,
    (boardX + contentR) / 2, hudY + 6,
    { font: scoreFont, align: 'center', shadow: true },
  );
  // Match the power-up panel column width on wide viewports so Back caps the
  // panel column; fall back to standard widths when the panel is absent or
  // sits at the bottom.
  const btnW = render.layout.panelSide === 'right' && render.layout.panelW > 0
    ? render.layout.panelW
    : (render.layout.isNarrow ? 56 : 76);
  render.drawHitButton(contentR - btnW, hudY + 2, btnW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);

  // Row 2: progress bar with "Moves" label on the right
  const barY = hudY + 40;
  const barH = 8;
  const movesLabelW = 80;
  const barW = boardW - movesLabelW;
  const ctx = render.ctxRef();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  render.roundRect(ctx, boardX, barY, barW, barH, 4); ctx.fill();
  const pct = Math.min(1, cascade.score / target);
  ctx.fillStyle = pct >= 1 ? '#5fd068' : '#7c3aed';
  render.roundRect(ctx, boardX, barY, barW * pct, barH, 4); ctx.fill();

  // Warm-red pulse when moves are critically low — easy to spot in peripheral vision.
  const moveColor = movesLeft <= 3
    ? `rgba(255, ${100 + Math.floor(60 * (0.5 + 0.5 * Math.sin(clockMs() / 220)))}, 120, 1)`
    : 'rgba(255,255,255,0.85)';
  render.drawText(i18n.t('classic.moves', { n: movesLeft }), boardR, barY - 2, {
    font: subFont, align: 'right',
    color: moveColor,
    shadow: true,
  });

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
