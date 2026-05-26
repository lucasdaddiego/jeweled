// Puzzle mode: hand-designed goal challenges, fixed move budget.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as particles from '../particles.js';
import * as waves from '../waves.js';
import * as bolts from '../bolts.js';
import * as drag from '../dragInput.js';
import * as wakeLock from '../wakeLock.js';
import * as achievements from '../achievements.js';
import * as debugHud from '../debugHud.js';
import * as i18n from '../i18n.js';
import { tickEffects, tickHint } from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard } from '../grid.js';
import { spawnScore, handleMatchCleared, handleSpecialActivated } from '../floaters.js';
import { setScene, clockMs } from '../main.js';
import { SPECIAL } from '../config.js';
import { GEM_PARTICLE_PALETTES } from '../render.js';
import { mulberry32, strHash } from '../rng.js';
import { getPuzzle, isGoalMet, goalText, progressText } from '../puzzles.js';

let grid = null;
let cascade = null;
let hint = null;
let buttons = [];
let cursorX = 0, cursorY = 0;
let puzzleNum = 1;
let puzzle = null;
let movesLeft = 0;
let resultTriggered = false;
let lastClearCenter = null;

// Progress tracking for goal detection
let progress = null;

function freshProgress() {
  return { score: 0, clearedByColor: {}, specialsCreated: {}, maxCascadeDepth: 0 };
}

export function enter(args = {}) {
  // Use ?? not || so a missing puzzle id surfaces as undefined → !puzzle
  // → redirect to puzzleSelect, instead of silently launching puzzle #1.
  puzzleNum = args.puzzle ?? null;
  puzzle = puzzleNum != null ? getPuzzle(puzzleNum) : null;
  if (!puzzle) { setScene('puzzleSelect'); return; }

  document.body.className = '';
  const rng = mulberry32(strHash(`puzzle:${puzzleNum}:v1`));
  grid = createBoard(rng);
  cascade = new Cascade(grid, { mode: 'puzzle', rng });
  movesLeft = puzzle.moves;
  resultTriggered = false;
  hint = null;
  progress = freshProgress();
  storage.saveKey('profile', { lastPlayedMode: 'puzzle' });
  drag.bind(grid, cascade);
  debugHud.setActiveCascade(cascade);
  render.setPanelWidth(0);
  cascade.playEntryAnimation();

  cascade.onMatchCleared = (cells, depth) => {
    lastClearCenter = handleMatchCleared(cells, depth, {
      render, particles, waves,
      palettes: GEM_PARTICLE_PALETTES,
      haptic: storage.getSettings().haptic !== false,
    });
    for (const c of cells) {
      progress.clearedByColor[c.type] = (progress.clearedByColor[c.type] || 0) + 1;
    }
    if (depth > progress.maxCascadeDepth) progress.maxCascadeDepth = depth;
    achievements.notifyMatchCleared(cells.length, depth);
  };
  cascade.onSpecialActivated = (act) => {
    handleSpecialActivated(act, {
      render, waves, bolts, particles,
      palettes: GEM_PARTICLE_PALETTES, SPECIAL,
      haptic: storage.getSettings().haptic !== false,
    });
  };
  cascade.onSpecialSpawned = (special) => {
    progress.specialsCreated[special] = (progress.specialsCreated[special] || 0) + 1;
    achievements.notifySpecialSpawned(special);
  };
  cascade.onMoveCommitted = () => { movesLeft--; };
  cascade.onScoreChanged = (newScore, delta) => {
    progress.score = newScore;
    if (delta > 0 && lastClearCenter) {
      spawnScore(lastClearCenter.x, lastClearCenter.y - 20, delta,
        render.boardCenterX(), render.layout.hudY + 16);
    }
  };
  cascade.onIdleReached = () => checkComplete();
  wakeLock.acquire();
}

export function exit() {
  drag.unbind();
  debugHud.setActiveCascade(null);
  wakeLock.release();
  render.setPanelWidth(0);
  document.body.className = '';
}

function checkComplete() {
  if (resultTriggered) return;
  if (isGoalMet(puzzle.goal, progress)) {
    resultTriggered = true;
    finalizeWin();
  } else if (movesLeft <= 0) {
    resultTriggered = true;
    finalizeLose();
  }
}

function finalizeWin() {
  const s = storage.load();
  const existing = s.puzzle.completed[String(puzzleNum)] || { bestScore: 0 };
  const updated = { ...s.puzzle.completed };
  updated[String(puzzleNum)] = {
    bestScore: Math.max(existing.bestScore, cascade.score),
    completedAt: new Date().toISOString(),
  };
  storage.saveKey('puzzle', { completed: updated });
  storage.recordPlayDay(cascade.score);
  achievements.notifyMode('puzzle');
  setScene('result', { mode: 'puzzle', outcome: 'win', score: cascade.score, puzzleNum });
}

function finalizeLose() {
  storage.recordPlayDay(cascade.score);
  setScene('result', { mode: 'puzzle', outcome: 'lose', score: cascade.score, puzzleNum });
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
  const boardW = render.layout.boardSize;
  const titleFont = `bold ${render.responsiveFont(18)}px sans-serif`;
  const goalFont = `${render.responsiveFont(13)}px sans-serif`;
  const progFont = `bold ${render.responsiveFont(14)}px sans-serif`;

  render.drawText(i18n.t('puzzle.title', { name: i18n.t(puzzle.nameKey) }), boardX, hudY + 4, { font: titleFont, shadow: true });
  render.drawText(goalText(puzzle.goal), boardX, hudY + 24, { font: goalFont, color: 'rgba(255,255,255,0.75)' });
  render.drawText(progressText(puzzle.goal, progress), render.boardCenterX(), hudY + 6, {
    font: progFont, align: 'center', shadow: true,
  });
  const moveColor = movesLeft <= 2
    ? `rgba(255, ${100 + Math.floor(60 * (0.5 + 0.5 * Math.sin(clockMs() / 220)))}, 120, 1)`
    : 'rgba(255,255,255,0.75)';
  render.drawText(i18n.t('puzzle.moves', { n: movesLeft }), render.boardCenterX(), hudY + 28, {
    font: goalFont, align: 'center',
    color: moveColor,
  });

  const btnW = render.layout.isNarrow ? 56 : 76;
  render.drawHitButton(boardR - btnW, hudY + 2, btnW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('puzzleSelect'), buttons, cursorX, cursorY);

  render.drawBoard(grid, { shakeAmp: cascade.shakeAmp, settings, hint, idleMs: cascade.idleSinceMs });
}

export function onPointer(evt) {
  hint = null;
  if (evt.type === 'down') {
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
        b.onClick(); return;
      }
    }
  }
  drag.handle(evt.type, evt.x, evt.y);
}

export function onMove(x, y) {
  cursorX = x; cursorY = y;
  drag.move(x, y);
}
