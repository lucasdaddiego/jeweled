// Stats + Achievements viewer. Reachable from a small "📊" button on the title.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import { ACHIEVEMENTS, summary } from '../achievements.js';
import { setScene } from '../main.js';

let buttons = [];
let cursorX = 0, cursorY = 0;
let scrollY = 0;
let maxScroll = 0;
let isPointerDown = false;
let dragStartY = 0, dragStartScroll = 0;
let didDragScroll = false;
const SCROLL_THRESHOLD = 8;

export function enter() {
  document.body.className = '';
  buttons = []; scrollY = 0;
  isPointerDown = false; didDragScroll = false;
}
export function exit() {}
export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  const titleY = h * 0.05;
  render.drawText(i18n.t('stats.title'), w / 2, titleY, {
    font: `bold ${render.responsiveFont(26)}px -apple-system, system-ui, sans-serif`,
    align: 'center',
  });

  const sub = summary();
  render.drawText(i18n.t('stats.unlockedSummary', { unlocked: sub.unlocked, total: sub.total }), w / 2, titleY + 32, {
    font: '14px sans-serif', align: 'center', color: 'rgba(255,255,255,0.6)',
  });

  // Stats summary card
  const cardY = titleY + 64;
  const cardW = Math.min(560, w - 40);
  const cardX = (w - cardW) / 2;
  const cardH = 110;
  const ctx = render.ctxRef();
  render.roundRect(ctx, cardX, cardY, cardW, cardH, 12);
  ctx.fillStyle = 'rgba(40,30,80,0.55)'; ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.stroke();
  drawStats(cardX + 16, cardY + 14, cardW - 32);

  // Scrollable achievement grid
  const gridTop = cardY + cardH + 20;
  const gridBottom = h - 16;
  const visibleH = gridBottom - gridTop;
  const cols = Math.max(2, Math.floor((w - 32) / 220));
  const cellW = Math.floor((w - 32 - (cols - 1) * 14) / cols);
  const cellH = 80;
  const rows = Math.ceil(ACHIEVEMENTS.length / cols);
  const totalH = rows * cellH + (rows - 1) * 14;
  maxScroll = Math.max(0, totalH - visibleH);

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, gridTop, w, visibleH);
  ctx.clip();

  for (let i = 0; i < ACHIEVEMENTS.length; i++) {
    const a = ACHIEVEMENTS[i];
    const col = i % cols, row = Math.floor(i / cols);
    const x = 16 + col * (cellW + 14);
    const y = gridTop + row * (cellH + 14) - scrollY;
    if (y + cellH < gridTop - 4 || y > gridBottom + 4) continue;
    drawAchievementTile(x, y, cellW, cellH, a, !!sub.unlockedSet[a.id]);
  }
  ctx.restore();

  // Scroll thumb
  if (maxScroll > 0) {
    const trackX = w - 8;
    const trackH = visibleH;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(trackX, gridTop, 3, trackH);
    const thumbH = Math.max(20, (visibleH / totalH) * trackH);
    const thumbY = gridTop + (scrollY / maxScroll) * (trackH - thumbH);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(trackX, thumbY, 3, thumbH);
  }

  // Back button — shared menu-column anchor so all menu scenes align.
  const backW = render.layout.isNarrow ? 56 : 76;
  const col = render.menuColumn();
  render.drawHitButton(col.right - backW, 16, backW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);
}

function drawStats(x, y, w) {
  const state = storage.load();
  const counters = (state.achievements?.counters) || {};
  const lines = [
    { label: i18n.t('stats.totalGemsCleared'),       value: i18n.formatNumber(counters.totalMatches || 0) },
    { label: i18n.t('stats.zenBestScore'),           value: i18n.formatNumber(state.zen?.bestScore || 0) },
    { label: i18n.t('stats.zenRunsPlayed'),          value: i18n.formatNumber(state.zen?.totalRunsPlayed || 0) },
    { label: i18n.t('stats.classicLevelsBeaten'),    value: i18n.t('stats.classicLevelsBeatenValue', { n: Object.keys(state.classic?.levels || {}).length }) },
    { label: i18n.t('stats.dailyChallengesCompleted'), value: i18n.formatNumber(state.daily?.totalDaysPlayed || 0) },
    { label: i18n.t('stats.blitzBestScore'),         value: i18n.formatNumber(state.blitz?.bestScore || 0) },
  ];
  const colW = w / 2;
  for (let i = 0; i < lines.length; i++) {
    const lx = x + (i % 2) * colW;
    const ly = y + Math.floor(i / 2) * 28;
    render.drawText(lines[i].label, lx, ly, { font: '12px sans-serif', color: 'rgba(255,255,255,0.55)' });
    render.drawText(lines[i].value, lx, ly + 12, { font: 'bold 16px sans-serif', color: '#f3f0ff' });
  }
}

function drawAchievementTile(x, y, w, h, a, unlocked) {
  const ctx = render.ctxRef();
  ctx.save();
  render.roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = unlocked ? 'rgba(60,50,110,0.85)' : 'rgba(30,25,50,0.5)';
  ctx.fill();
  ctx.strokeStyle = unlocked ? 'rgba(255,215,0,0.45)' : 'rgba(255,255,255,0.06)';
  ctx.stroke();

  // Icon
  ctx.font = `${Math.floor(h * 0.45)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = unlocked ? 1 : 0.35;
  ctx.fillText(a.icon, x + 36, y + h / 2);
  ctx.globalAlpha = 1;

  // Text
  ctx.fillStyle = unlocked ? '#fff' : 'rgba(255,255,255,0.4)';
  ctx.font = `bold ${Math.floor(h * 0.22)}px sans-serif`;
  ctx.textAlign = 'left';
  ctx.fillText(i18n.t(a.nameKey), x + 72, y + h * 0.38);
  ctx.fillStyle = unlocked ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.3)';
  ctx.font = `${Math.floor(h * 0.16)}px sans-serif`;
  // Ellipsize the description so long achievement descriptions don't bleed
  // past the tile edge on narrow viewports.
  const maxDescW = w - (72 + 8);
  ctx.fillText(ellipsize(ctx, i18n.t(a.descKey), maxDescW), x + 72, y + h * 0.66);
  ctx.restore();
}

// Truncate `text` with an ellipsis if its rendered width exceeds maxW.
// Uses the current ctx font, so call after fillStyle/font are set.
function ellipsize(ctx, text, maxW) {
  if (ctx.measureText(text).width <= maxW) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + '…').width <= maxW) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + '…';
}

export function onPointer(evt) {
  if (evt.type === 'down') {
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
        b.onClick(); return;
      }
    }
    isPointerDown = true;
    didDragScroll = false;
    dragStartY = evt.y;
    dragStartScroll = scrollY;
  } else if (evt.type === 'up') {
    isPointerDown = false;
  }
}

export function onMove(x, y) {
  cursorX = x; cursorY = y;
  if (!isPointerDown) return;
  const dy = y - dragStartY;
  if (!didDragScroll && Math.abs(dy) > SCROLL_THRESHOLD) didDragScroll = true;
  if (didDragScroll) {
    scrollY = Math.max(0, Math.min(maxScroll, dragStartScroll - dy));
  }
}

export function onWheel(dy) {
  scrollY = Math.max(0, Math.min(maxScroll, scrollY + dy));
}
