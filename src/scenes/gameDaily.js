// Daily challenge: deterministic seed = today's date. 30 moves, no target — just max score.
//
// The counted run is parked like Zen: storage daily.saveState holds the board,
// score, moves left and the RNG position at the last idle, so Back, a reload
// or a closed tab resumes the same run instead of losing it. A move in flight
// is parked with the board before it plus the swap itself, and the resume
// plays that swap again: the outcome of a committed move cannot be undone by
// leaving mid-cascade. Only the day the run started can resume it: a parked
// run from an earlier day is dropped (the title and the HUD show today).

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as drag from '../dragInput.js';
import * as wakeLock from '../wakeLock.js';
import * as achievements from '../achievements.js';
import * as debugHud from '../debugHud.js';
import * as i18n from '../i18n.js';
import {
  tickEffects, tickHint, clearEffects, drawHintButton, wireCascadePresentation,
} from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard, serializeGrid, deserializeGrid } from '../grid.js';
import { setScene, clockMs } from '../main.js';
import { DAILY_MOVES } from '../config.js';
import { mulberry32, dateHash, todayISO } from '../rng.js';
import { dailyStreak, resumableRun } from '../dailyMeta.js';

let grid = null;
let cascade = null;
let hint = null;
let buttons = [];
let cursorX = 0, cursorY = 0;
let movesLeft = DAILY_MOVES;
let resultTriggered = false;
let isReplay = false;
let prevBest = 0;
let dailyDate = '';
let rng = null;
// Board at the last idle, as a saveState minus the in-flight move. Kept in
// memory from the start; written to storage once the counted run has moved.
let idleSnapshot = null;

function captureIdle() {
  return {
    date: dailyDate,
    grid: serializeGrid(grid),
    score: cascade.score,
    movesLeft,
    rng: rng.state(),
  };
}

export function enter(args = {}) {
  document.body.className = 'daily-bg';
  clearEffects();   // drop any still-alive FX from the previous run before first draw
  const today = todayISO();
  dailyDate = today;
  const s = storage.load();
  const parked = resumableRun(s.daily, today);
  // A parked run of another day (or a malformed one) is dropped; the replay
  // rule below still applies to today.
  if (s.daily.saveState && !parked) storage.saveKey('daily', { saveState: null });
  // A day counts once: after its result was recorded, and also after its
  // counted run made a move (startedDate) and is not parked. The seed is the
  // date, so a fresh start re-creates the identical board; without the
  // second check that was an unlimited retry before the score that counts.
  isReplay = !parked
    && (s.daily.todaySubmittedDate === today || s.daily.startedDate === today);
  prevBest = s.daily.bestEver;

  if (parked) {
    rng = mulberry32(parked.rng);
    grid = deserializeGrid(parked.grid);
    cascade = new Cascade(grid, { mode: 'daily', rng });
    cascade.score = parked.score;
    cascade.scoreShown = parked.score;
  } else {
    rng = mulberry32(dateHash());
    grid = createBoard(rng);
    cascade = new Cascade(grid, { mode: 'daily', rng });
  }

  movesLeft = parked ? parked.movesLeft : DAILY_MOVES;
  resultTriggered = false;
  hint = null;
  idleSnapshot = captureIdle();
  storage.saveKey('profile', { lastPlayedMode: 'daily' });
  drag.bind(grid, cascade);
  debugHud.setActiveCascade(cascade);
  if (!parked) cascade.playEntryAnimation();

  wireCascadePresentation(cascade, {
    onMoveCommitted: () => {
      movesLeft--;
      if (isReplay) return;
      // Park the board before this move together with the move. Written at
      // once (flush), not on the debounce: a tab closed while the cascade
      // runs must not reopen on the old board with the move refunded. The
      // first move also marks the day as started (see the replay rule).
      const patch = {
        saveState: { ...idleSnapshot, pendingSwap: cascade.lastMove, savedAt: new Date().toISOString() },
      };
      if (movesLeft === DAILY_MOVES - 1) patch.startedDate = dailyDate;
      storage.saveKey('daily', patch);
      storage.flush();
    },
    onIdleReached: () => {
      idleSnapshot = captureIdle();
      if (movesLeft <= 0 && !resultTriggered) {
        resultTriggered = true;
        finalize();
        return;
      }
      if (!isReplay && !resultTriggered && movesLeft < DAILY_MOVES) {
        storage.saveKey('daily', {
          saveState: { ...idleSnapshot, pendingSwap: null, savedAt: new Date().toISOString() },
        });
      }
    },
  });

  // Resume a move that was in flight when the run was parked: the same swap
  // on the same board with the same RNG position gives the same outcome.
  const move = parked?.pendingSwap;
  if (move?.a && move?.b) cascade.tryStartSwap(move.a, move.b);

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
      saveState: null,
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
