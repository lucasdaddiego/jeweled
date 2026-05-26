// Classic level select — paginated (20 levels per page, 15 pages for 300 levels).

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import { setScene } from '../main.js';
import { LEVELS, LEVELS_PER_PAGE, pageCount, pageOfLevel } from '../levels.js';

let buttons = [];
let cursorX = 0, cursorY = 0;
let currentPage = 1;

export function enter() {
  document.body.className = '';
  buttons = [];
  // Jump to the page that has the player's highest unlocked level.
  const state = storage.load();
  currentPage = pageOfLevel(state.classic.highestUnlocked);
}
export function exit() {}
export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  const totalPages = pageCount();
  const titleY = h * 0.06;
  render.drawText(i18n.t('levelSelect.title'), w / 2, titleY, {
    font: `bold ${render.responsiveFont(28)}px -apple-system, system-ui, sans-serif`,
    align: 'center',
  });
  render.drawText(i18n.t('levelSelect.page', { page: currentPage, total: totalPages }), w / 2, titleY + 32, {
    font: `${render.responsiveFont(14)}px -apple-system, system-ui, sans-serif`,
    align: 'center',
    color: 'rgba(255,255,255,0.6)',
  });

  const state = storage.load();
  const highest = state.classic.highestUnlocked;

  // Grid geometry (5 rows × 4 cols = 20 cells per page). Tile size shrinks to
  // fit short viewports so the bottom row + pagination row are always visible
  // without scrolling.
  const cols = 4, rows = 5;
  const gap = render.layout.isNarrow ? 10 : 14;
  const maxCellW = render.layout.isNarrow ? 84 : 110;
  const topMargin = titleY + 70;
  const bottomMargin = 100;
  const availH = Math.max(1, h - topMargin - bottomMargin);
  const cellByW = Math.floor((w - 32 - (cols - 1) * gap) / cols);
  const cellByH = Math.floor((availH - (rows - 1) * gap) / rows);
  const cellW = Math.max(40, Math.min(maxCellW, cellByW, cellByH));
  const cellH = cellW;
  const totalW = cols * cellW + (cols - 1) * gap;
  const totalH = rows * cellH + (rows - 1) * gap;
  const ox = Math.floor((w - totalW) / 2);
  const oy = topMargin + Math.max(0, Math.floor((availH - totalH) / 2));

  // Draw the 20 levels on the current page
  const startLevel = (currentPage - 1) * LEVELS_PER_PAGE + 1;
  const endLevel = Math.min(LEVELS.length, currentPage * LEVELS_PER_PAGE);
  for (let ln = startLevel; ln <= endLevel; ln++) {
    const idx = ln - startLevel;
    const col = idx % cols, row = Math.floor(idx / cols);
    const x = ox + col * (cellW + gap);
    const y = oy + row * (cellH + gap);
    const data = state.classic.levels[String(ln)] || { starsEarned: 0, bestScore: 0 };
    const locked = ln > highest;
    drawLevelTile(x, y, cellW, cellH, ln, data, locked);
  }

  // Pagination controls along the bottom
  const ctrlY = h - 60;
  const btnW = render.layout.isNarrow ? 52 : 70;
  const btnH = 40;
  const prevX = w / 2 - btnW - 100;
  const nextX = w / 2 + 100;
  drawPaginationButton(prevX, ctrlY, btnW, btnH, '←', currentPage > 1, () => {
    if (currentPage > 1) currentPage--;
  });
  drawPaginationButton(nextX, ctrlY, btnW, btnH, '→', currentPage < totalPages, () => {
    if (currentPage < totalPages) currentPage++;
  });

  // Back button — aligned with the grid's right edge so it doesn't float off
  // alone on wide viewports where the centered grid is much narrower than the
  // page. Falls back to the viewport edge on narrow screens where the grid
  // already spans the width.
  const backW = render.layout.isNarrow ? 56 : 76;
  const backX = Math.min(w - backW - 16, ox + totalW - backW);
  drawHitButton(backX, 16, backW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'));
}

function drawLevelTile(x, y, w, h, ln, data, locked) {
  const hover = !locked && cursorX >= x && cursorX <= x + w && cursorY >= y && cursorY <= y + h;
  const ctx = render.ctxRef();
  ctx.save();
  render.roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = locked ? 'rgba(40,40,60,0.5)'
    : hover ? 'rgba(124,58,237,0.8)' : 'rgba(60,50,100,0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();
  ctx.fillStyle = locked ? '#666' : '#fff';
  ctx.font = `bold ${Math.floor(w * 0.3)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(locked ? '🔒' : String(ln), x + w / 2, y + h * 0.35);
  if (!locked) {
    ctx.font = `${Math.floor(w * 0.14)}px -apple-system, system-ui, sans-serif`;
    const stars = '★'.repeat(data.starsEarned) + '☆'.repeat(3 - data.starsEarned);
    ctx.fillStyle = '#ffd166';
    ctx.fillText(stars, x + w / 2, y + h * 0.62);
    if (data.bestScore > 0) {
      ctx.font = `${Math.floor(w * 0.10)}px -apple-system, system-ui, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.7)';
      ctx.fillText(i18n.formatNumber(data.bestScore), x + w / 2, y + h * 0.82);
    }
  }
  ctx.restore();
  if (!locked) buttons.push({ x, y, w, h, onClick: () => setScene('gameClassic', { level: ln }) });
}

function drawPaginationButton(x, y, w, h, label, enabled, onClick) {
  const ctx = render.ctxRef();
  const hover = enabled && cursorX >= x && cursorX <= x + w && cursorY >= y && cursorY <= y + h;
  ctx.save();
  render.roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = !enabled ? 'rgba(40,40,60,0.4)'
    : hover ? 'rgba(124,58,237,0.85)' : 'rgba(60,50,100,0.8)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();
  ctx.fillStyle = enabled ? '#fff' : '#666';
  ctx.font = `bold ${Math.floor(h * 0.5)}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
  if (enabled) buttons.push({ x, y, w, h, onClick });
}

function drawHitButton(x, y, w, h, label, onClick) {
  render.drawHitButton(x, y, w, h, label, onClick, buttons, cursorX, cursorY);
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
