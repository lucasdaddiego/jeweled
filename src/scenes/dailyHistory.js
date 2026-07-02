// Daily history: a 4-week calendar of daily-challenge results, plus streak
// and totals. Reached from the Daily result screen.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import { setScene } from '../main.js';
import { todayISO } from '../rng.js';
import { dailyStreak, lastNDays } from '../dailyMeta.js';

const WEEKS = 4;
const DAYS = 7;

let buttons = [];
let cursorX = 0, cursorY = 0;

export function enter() {
  document.body.className = 'daily-bg';
  buttons = [];
}
export function exit() { document.body.className = ''; }
export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  const s = storage.load();
  const history = s.daily.history || {};
  const today = todayISO();
  const streak = dailyStreak(history, today);

  const titleY = h * 0.07 + render.layout.safeTop;
  render.drawText(i18n.t('dailyHistory.title'), w / 2, titleY, {
    font: `bold ${render.responsiveFont(28)}px -apple-system, system-ui, sans-serif`,
    align: 'center', shadow: true,
  });

  // Summary line: streak · total played · best ever
  const parts = [];
  if (streak >= 2) parts.push(i18n.t('daily.streak', { n: streak }));
  parts.push(i18n.t('dailyHistory.totalPlayed', { n: s.daily.totalDaysPlayed || 0 }));
  if (s.daily.bestEver > 0) parts.push(i18n.t('result.bestEver', { score: i18n.formatNumber(s.daily.bestEver) }));
  render.drawText(parts.join('   ·   '), w / 2, titleY + 34, {
    font: `${render.responsiveFont(14)}px sans-serif`, align: 'center',
    color: 'rgba(255,255,255,0.7)',
  });

  // Calendar: WEEKS rows × DAYS columns, oldest at top-left, today bottom-right.
  const days = lastNDays(history, WEEKS * DAYS, today);
  const cell = render.layout.isNarrow ? 38 : 52;
  const gap = 8;
  const gridW = DAYS * (cell + gap) - gap;
  const gridH = WEEKS * (cell + gap) - gap;
  const ox = Math.floor((w - gridW) / 2);
  const oy = Math.max(titleY + 70, Math.floor((h - gridH) / 2));
  const ctx = render.ctxRef();

  if (days.every(d => !d.entry)) {
    render.drawText(i18n.t('dailyHistory.empty'), w / 2, oy + gridH / 2, {
      font: '16px sans-serif', align: 'center', color: 'rgba(255,255,255,0.6)',
    });
  }

  for (let i = 0; i < days.length; i++) {
    const { iso, entry } = days[i];
    const col = i % DAYS;
    const row = Math.floor(i / DAYS);
    const x = ox + col * (cell + gap);
    const y = oy + row * (cell + gap);
    const isToday = iso === today;
    ctx.save();
    render.roundRect(ctx, x, y, cell, cell, 8);
    ctx.fillStyle = entry ? 'rgba(124, 58, 237, 0.75)' : 'rgba(255,255,255,0.06)';
    ctx.fill();
    if (isToday) {
      ctx.strokeStyle = 'rgba(255,255,255,0.8)';
      ctx.lineWidth = 2;
      ctx.stroke();
    }
    // Day-of-month on top, score (if any) below.
    ctx.fillStyle = entry ? '#fff' : 'rgba(255,255,255,0.4)';
    ctx.textAlign = 'center';
    ctx.font = `bold ${Math.floor(cell * 0.3)}px sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(String(Number(iso.slice(8, 10))), x + cell / 2, y + cell * 0.35);
    if (entry) {
      ctx.font = `${Math.floor(cell * 0.22)}px sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(i18n.formatNumber(entry.score), x + cell / 2, y + cell * 0.72);
    }
    ctx.restore();
  }

  // Back — shared menu-column anchor, same as the other menu scenes.
  const colM = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  render.drawHitButton(colM.right - backW, 24 + render.layout.safeTop, backW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);
}

export function onPointer(evt) {
  if (evt.type !== 'down') return;
  for (let i = buttons.length - 1; i >= 0; i--) {
    const b = buttons[i];
    if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
      b.onClick();
      return;
    }
  }
}

export function onMove(x, y) { cursorX = x; cursorY = y; }
