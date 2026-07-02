// Daily challenge: deterministic seed = today's date. 30 moves, no target — just max score.

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
import { tickEffects, tickHint, clearEffects, drawHintButton } from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard } from '../grid.js';
import { spawnScore, handleMatchCleared, handleSpecialActivated } from '../floaters.js';
import { setScene, clockMs } from '../main.js';
import { DAILY_MOVES, SPECIAL } from '../config.js';
import { GEM_PARTICLE_PALETTES } from '../render.js';
import { mulberry32, dateHash, todayISO } from '../rng.js';
import { dailyStreak } from '../dailyMeta.js';

let grid = null;
let cascade = null;
let hint = null;
let buttons = [];
let cursorX = 0, cursorY = 0;
let movesLeft = DAILY_MOVES;
let resultTriggered = false;
let isReplay = false;
let prevBest = 0;
let lastClearCenter = null;
let dailyDate = '';

export function enter(args = {}) {
  document.body.className = 'daily-bg';
  clearEffects();   // drop any still-alive FX from the previous run before first draw
  const today = todayISO();
  dailyDate = today;
  const s = storage.load();
  isReplay = s.daily.todaySubmittedDate === today;
  prevBest = s.daily.bestEver;

  const seed = dateHash();
  const rng = mulberry32(seed);
  grid = createBoard(rng);
  cascade = new Cascade(grid, { mode: 'daily', rng });

  movesLeft = DAILY_MOVES;
  resultTriggered = false;
  hint = null;
  storage.saveKey('profile', { lastPlayedMode: 'daily' });
  drag.bind(grid, cascade);
  debugHud.setActiveCascade(cascade);
  cascade.playEntryAnimation();

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
  cascade.onSpecialSpawned = (special) => achievements.notifySpecialSpawned(special);
  cascade.onBombsDefused = (n) => achievements.notifyBombsDefused(n);
  cascade.onScoreChanged = (newScore, delta) => {
    if (delta > 0 && lastClearCenter) {
      spawnScore(lastClearCenter.x, lastClearCenter.y - 20, delta,
        render.boardCenterX(), render.layout.hudY + 16);
    }
  };
  cascade.onMoveCommitted = () => { movesLeft--; };
  cascade.onIdleReached = () => {
    if (movesLeft <= 0 && !resultTriggered) {
      resultTriggered = true;
      finalize();
    }
  };

  wakeLock.acquire();
}

export function exit() { drag.unbind(); debugHud.setActiveCascade(null); wakeLock.release(); document.body.className = ''; }

function finalize() {
  const s = storage.load();
  const isNewBest = !isReplay && cascade.score > s.daily.bestEver;
  // A replay "does not count" (the HUD says so): it must not raise bestEver,
  // bump totals, or overwrite the day's recorded result. Only a real,
  // first-of-day submission writes progress — and it's keyed by the date the
  // board was SEEDED from (dailyDate, captured in enter()), never a re-read of
  // today(). A run that starts before midnight and ends after must still count
  // for the day it was actually played, with the seed that produced the score.
  if (!isReplay) {
    storage.saveKey('daily', {
      bestEver: Math.max(s.daily.bestEver, cascade.score),
      todaySubmittedDate: dailyDate,
      totalDaysPlayed: s.daily.totalDaysPlayed + 1,
      history: {
        ...s.daily.history,
        [dailyDate]: { score: cascade.score, movesUsed: DAILY_MOVES - movesLeft },
      },
    });
    storage.recordPlayDay(cascade.score);
  }
  achievements.notifyMode('daily');
  // Streak computed AFTER the write above so today's entry counts.
  const streak = dailyStreak(storage.load().daily.history || {}, dailyDate);
  if (!isReplay) achievements.notifyDailyStreak(streak);
  setScene('result', {
    mode: 'daily', outcome: 'done', score: cascade.score, date: dailyDate,
    isReplay, isNewBest, prevBest, streak,
    movesUsed: DAILY_MOVES - movesLeft,
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

  const hudY = render.layout.hudY;
  const boardX = render.layout.boardX;
  const boardR = render.boardRight();
  const titleFont = `bold ${render.responsiveFont(20)}px -apple-system, system-ui, sans-serif`;
  const scoreFont = `bold ${render.responsiveFont(20)}px -apple-system, system-ui, sans-serif`;
  const subFont   = `${render.responsiveFont(14)}px -apple-system, system-ui, sans-serif`;

  render.drawText(i18n.t('daily.title'), boardX, hudY + 6, { font: titleFont, shadow: true });
  render.drawText(i18n.formatNumber(Math.floor(cascade.scoreShown)), render.boardCenterX(), hudY + 6, {
    font: scoreFont, align: 'center', shadow: true,
  });
  const btnW = render.layout.isNarrow ? 56 : 76;
  render.drawHitButton(boardR - btnW, hudY + 2, btnW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);

  // Row 2: moves + replay-tag (warm-red pulse when critically low)
  const movePulse = movesLeft <= 3
    ? `rgba(255, ${100 + Math.floor(60 * (0.5 + 0.5 * Math.sin(clockMs() / 220)))}, 120, 1)`
    : movesLeft <= 5 ? '#ff8888' : 'rgba(255,255,255,0.85)';
  render.drawText(i18n.t('daily.movesLeft', { n: movesLeft }), boardX, hudY + 40, {
    font: subFont,
    color: movePulse,
    shadow: true,
  });
  if (isReplay) {
    render.drawText(i18n.t('daily.replayDoesNotCount'), boardR, hudY + 40, {
      font: subFont, align: 'right',
      color: 'rgba(255,255,255,0.6)',
    });
  } else {
    // Date, with the running streak alongside when there is one.
    const streak = dailyStreak(storage.load().daily.history || {}, dailyDate);
    const label = streak >= 2
      ? `${i18n.t('daily.streak', { n: streak })}  ·  ${i18n.formatDate(dailyDate)}`
      : i18n.t('daily.todayLabel', { date: i18n.formatDate(dailyDate) });
    render.drawText(label, boardR, hudY + 40, {
      font: subFont, align: 'right',
      color: 'rgba(255,255,255,0.6)',
    });
  }

  drawHintButton(boardR - btnW - 48, hudY + 2, cascade, grid, (h) => { hint = h; }, buttons, cursorX, cursorY);
  render.drawBoard(grid, { shakeAmp: cascade.shakeAmp, settings: storage.getSettings(), hint, idleMs: cascade.idleSinceMs });
}

export function onPointer(evt) {
  // Clear the hint only on 'down' — the release ('up') of the tap that PRESSED
  // the hint button would otherwise erase the hint it just granted.
  if (evt.type === 'down') {
    hint = null;
    // Reverse iteration: top-most (most recently drawn) button wins.
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
        b.onClick();
        return;
      }
    }
  }
  drag.handle(evt.type, evt.x, evt.y);
}

export function onMove(x, y) {
  cursorX = x; cursorY = y;
  drag.move(x, y);
}
