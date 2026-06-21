// Blitz mode: 60 active seconds, max score, no fail state beyond timeout.
// Same engine as Zen — just trades the move budget for an idle-only timer.

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
import { tickEffects, tickHint, clearEffects } from './sceneCommon.js';
import { Cascade, STATE } from '../cascade.js';
import { createBoard } from '../grid.js';
import { spawnScore, handleMatchCleared, handleSpecialActivated } from '../floaters.js';
import { setScene } from '../main.js';
import { BLITZ_DURATION_MS, SPECIAL } from '../config.js';
import { GEM_PARTICLE_PALETTES } from '../render.js';

let grid = null;
let cascade = null;
let hint = null;
let buttons = [];
let cursorX = 0, cursorY = 0;
let timeLeftMs = 0;
let resultTriggered = false;
let lastClearCenter = null;

export function enter() {
  document.body.className = '';
  clearEffects();   // drop any still-alive FX from the previous run before first draw
  grid = createBoard();
  cascade = new Cascade(grid, { mode: 'blitz' });
  timeLeftMs = BLITZ_DURATION_MS;
  resultTriggered = false;
  hint = null;
  storage.saveKey('profile', { lastPlayedMode: 'blitz' });
  drag.bind(grid, cascade);
  debugHud.setActiveCascade(cascade);
  // Blitz has no power-up panel; explicitly zero in case a previous game scene set it.
  render.setPanelWidth(0);
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
  cascade.onScoreChanged = (newScore, delta) => {
    if (delta > 0 && lastClearCenter) {
      spawnScore(lastClearCenter.x, lastClearCenter.y - 20, delta,
        render.boardCenterX(), render.layout.hudY + 16);
    }
  };

  wakeLock.acquire();
}

export function exit() {
  drag.unbind();
  debugHud.setActiveCascade(null);
  wakeLock.release();
  render.setPanelWidth(0);
  document.body.className = '';
}

function finalize() {
  resultTriggered = true;
  const s = storage.load();
  // Capture pre-save bestScore so we can correctly report "new best" in the
  // result scene (after save, current best === args.score and the comparison
  // would always say "new best").
  const prevBest = s.blitz.bestScore;
  const isNewBest = cascade.score > prevBest;
  if (isNewBest) storage.saveKey('blitz', { bestScore: cascade.score });
  storage.saveKey('blitz', {
    totalRunsPlayed: s.blitz.totalRunsPlayed + 1,
    lastPlayedAt: new Date().toISOString(),
  });
  storage.recordPlayDay(cascade.score);
  achievements.notifyMode('blitz');
  setScene('result', { mode: 'blitz', outcome: 'done', score: cascade.score, isNewBest, prevBest });
}

export function update(dt) {
  cascade.update(dt);
  tickEffects(dt);

  // Tick the countdown only while the player can act (not mid-cascade) so the
  // timer doesn't drain unfairly during long resolutions.
  if (!resultTriggered && cascade.state === STATE.IDLE) {
    timeLeftMs -= dt;
    if (timeLeftMs <= 0) {
      timeLeftMs = 0;
      finalize();
    }
  }

  hint = tickHint(cascade, grid, hint);
}

export function draw() {
  render.clearFrame();
  buttons = [];

  const hudY = render.layout.hudY;
  const boardX = render.layout.boardX;
  const boardR = render.boardRight();
  const titleFont = `bold ${render.responsiveFont(22)}px -apple-system, system-ui, sans-serif`;
  const scoreFont = `bold ${render.responsiveFont(24)}px -apple-system, system-ui, sans-serif`;
  const subFont   = `${render.responsiveFont(14)}px -apple-system, system-ui, sans-serif`;

  render.drawText(i18n.t('blitz.title'), boardX, hudY + 8, { font: titleFont, shadow: true });
  render.drawText(i18n.formatNumber(Math.floor(cascade.scoreShown)), render.boardCenterX(), hudY + 6, {
    font: scoreFont, align: 'center', shadow: true,
  });
  const btnW = render.layout.isNarrow ? 56 : 76;
  render.drawHitButton(boardR - btnW, hudY + 2, btnW, 36,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);

  // Timer bar — full at 60s, depletes as time runs out
  const barY = hudY + 44;
  const barH = 8;
  const ctx = render.ctxRef();
  ctx.fillStyle = 'rgba(255,255,255,0.08)';
  render.roundRect(ctx, boardX, barY, render.layout.boardSize, barH, 4); ctx.fill();
  const pct = Math.max(0, Math.min(1, timeLeftMs / BLITZ_DURATION_MS));
  const barColor = timeLeftMs < 10_000 ? '#ff5555' : timeLeftMs < 20_000 ? '#ffaa33' : '#5fd068';
  ctx.fillStyle = barColor;
  render.roundRect(ctx, boardX, barY, render.layout.boardSize * pct, barH, 4); ctx.fill();

  const seconds = Math.ceil(timeLeftMs / 1000);
  render.drawText(i18n.t('blitz.seconds', { n: seconds }), boardR, barY - 4, {
    font: subFont, align: 'right',
    color: timeLeftMs < 10_000 ? '#ff8888' : 'rgba(255,255,255,0.85)',
    shadow: true,
  });

  render.drawBoard(grid, { shakeAmp: cascade.shakeAmp, settings: storage.getSettings(), hint, idleMs: cascade.idleSinceMs });
}

export function onPointer(evt) {
  hint = null;
  if (evt.type === 'down') {
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
        b.onClick();
        return;
      }
    }
  }
  if (!resultTriggered) drag.handle(evt.type, evt.x, evt.y);
}

export function onMove(x, y) {
  cursorX = x; cursorY = y;
  drag.move(x, y);
}
