// Classic mode: 300 levels (see src/levels.js), score-target with N moves,
// stars on win, persists progress.

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
import { tickEffects, tickHint, clearEffects, drawHintButton } from './sceneCommon.js';
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

// Ice modifier: per-cell frost layer counts (null when the level has none).
// A clear AT an iced cell melts one layer; the win needs score AND no ice.
let iceMap = null;
let iceLeft = 0;
// Boss levels start seeded with ticking time bombs.
let isBoss = false;

function initIce(def, restored) {
  isBoss = !!def.boss;
  if (!def.ice) { iceMap = null; iceLeft = 0; return; }
  iceMap = Array.from({ length: 8 }, () => new Array(8).fill(0));
  iceLeft = 0;
  const cells = restored || def.ice;
  for (const [r, c] of cells) {
    if (iceMap[r]?.[c] === 0) { iceMap[r][c] = 1; iceLeft++; }
  }
}

function meltIceAt(r, c) {
  if (iceMap && iceMap[r]?.[c] > 0) {
    iceMap[r][c] = 0;
    iceLeft--;
  }
}

function remainingIceCells() {
  if (!iceMap) return null;
  const out = [];
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) if (iceMap[r][c] > 0) out.push([r, c]);
  return out;
}

// Undo power-up (same scheme as gameZen, plus the move refund): curIdle holds
// the latest idle board; a committed move shifts it into prevIdle.
let prevIdle = null;
let curIdle = null;

function captureIdle() {
  return {
    grid: serializeGrid(grid), score: cascade.score, movesLeft, milestoneFloor,
    ice: remainingIceCells(),
  };
}

function applyUndo() {
  if (!prevIdle || !cascade || cascade.state !== STATE.IDLE || resultTriggered) return false;
  const g2 = deserializeGrid(prevIdle.grid);
  for (let r = 0; r < g2.length; r++) {
    for (let c = 0; c < g2[r].length; c++) grid[r][c] = g2[r][c];
  }
  cascade.score = prevIdle.score;
  cascade.scoreShown = prevIdle.score;
  movesLeft = prevIdle.movesLeft;
  milestoneFloor = prevIdle.milestoneFloor;
  if (prevIdle.ice) initIce(getLevel(levelNum), prevIdle.ice);
  overlay.setMilestoneFloor(milestoneFloor);
  curIdle = prevIdle;
  prevIdle = null;
  snapshotSaveState();
  return true;
}

export function enter(args = {}) {
  document.body.className = '';
  clearEffects();   // drop any still-alive FX from the previous run before first draw

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
  initIce(def, args.restoreFrom?.ice || null);
  // Boss levels start with ticking bombs already on the board (fresh runs
  // only — restores carry theirs inside the serialized grid).
  if (isBoss && args.restoreFrom == null) {
    for (const [br, bc] of [[2, 2], [5, 5]]) {
      const cell = grid[br][bc];
      if (cell && !cell.special) {
        cell.special = SPECIAL.TIME_BOMB;
        cell.bombCountdown = 9;
      }
    }
  }

  resultTriggered = false;
  hint = null;
  storage.saveKey('profile', { lastPlayedMode: 'classic' });
  drag.bind(grid, cascade);
  overlay.bind(grid, cascade);
  overlay.reset();
  overlay.setMilestoneFloor(milestoneFloor);
  // Restore an earned-but-unallocated milestone charge from the snapshot.
  overlay.setPendingMilestones(args.restoreFrom?.pendingMilestones || 0);
  debugHud.setActiveCascade(cascade);
  render.setPanelWidth(render.layout.isNarrow ? 76 : 72);
  if (entryAnim) cascade.playEntryAnimation();

  cascade.onMatchCleared = (cells, depth) => {
    lastClearCenter = handleMatchCleared(cells, depth, {
      render, particles, waves,
      palettes: GEM_PARTICLE_PALETTES,
      haptic: storage.getSettings().haptic !== false,
    });
    for (const cell of cells) meltIceAt(cell.r, cell.c);
    achievements.notifyMatchCleared(cells.length, depth);
  };
  cascade.onSpecialActivated = (act) => {
    handleSpecialActivated(act, {
      render, waves, bolts, particles,
      palettes: GEM_PARTICLE_PALETTES, SPECIAL,
      haptic: storage.getSettings().haptic !== false,
    });
    meltIceAt(act.r, act.c);
    for (const t of act.targets || []) meltIceAt(t.r, t.c);
  };
  cascade.onMoveCommitted = () => {
    prevIdle = curIdle;   // capture the pre-move board for the undo power-up
    movesLeft--;
  };
  cascade.onBombExploded = () => { movesLeft = Math.max(0, movesLeft - 5); };
  // Every other mode wires this; without it the special_* achievements could
  // never progress in the game's main mode.
  cascade.onSpecialSpawned = (special) => achievements.notifySpecialSpawned(special);
  cascade.onBombsDefused = (n) => achievements.notifyBombsDefused(n);
  cascade.onIdleReached = () => {
    curIdle = captureIdle();
    snapshotSaveState();
    checkWinLose();
  };
  prevIdle = null;
  curIdle = captureIdle();
  overlay.setUndoHandler(applyUndo);
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
      pendingMilestones: overlay.getPendingMilestones(),
      ice: remainingIceCells(),
      savedAt: new Date().toISOString(),
    },
  });
}

function checkWinLose() {
  if (resultTriggered) return;
  // Ice levels demand both: the score target AND a fully melted board.
  if (cascade.score >= target && iceLeft === 0) {
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

  // Row 1: Level (+ boss tag) | Score / Target | Back
  const levelLabel = isBoss
    ? `${i18n.t('classic.level', { n: levelNum })} ${i18n.t('classic.boss')}`
    : i18n.t('classic.level', { n: levelNum });
  render.drawText(levelLabel, boardX, hudY + 6, { font: titleFont, shadow: true });
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
  // Remaining-ice counter sits just left of the moves label on ice levels.
  if (iceMap) {
    render.drawText(i18n.t('classic.ice', { n: iceLeft }), boardR - 90, barY - 2, {
      font: subFont, align: 'right',
      color: iceLeft > 0 ? '#8fd1ff' : '#5fd068',
      shadow: true,
    });
  }

  drawHintButton(contentR - btnW - 48, hudY + 2, cascade, grid, (h) => { hint = h; }, buttons, cursorX, cursorY);
  render.drawBoard(grid, { shakeAmp: cascade.shakeAmp, settings, hint, idleMs: cascade.idleSinceMs, iceMap });
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
