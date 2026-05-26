// Puzzle picker — grid of puzzle tiles, completed ones get a check.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import { setScene } from '../main.js';
import { PUZZLES } from '../puzzles.js';

let buttons = [];
let cursorX = 0, cursorY = 0;
let scrollY = 0;
let maxScroll = 0;
let isPointerDown = false;
let dragStartY = 0;
let dragStartScroll = 0;
let didDragScroll = false;
const SCROLL_THRESHOLD = 8;

export function enter() {
  document.body.className = '';
  buttons = [];
  scrollY = 0;
  isPointerDown = false;
  didDragScroll = false;
}
export function exit() {}
export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  render.drawText(i18n.t('puzzleSelect.title'), w / 2, h * 0.06, {
    font: `bold ${render.responsiveFont(28)}px -apple-system, system-ui, sans-serif`,
    align: 'center',
  });

  const state = storage.load();
  const completed = state.puzzle?.completed || {};
  render.drawText(
    i18n.t('puzzleSelect.solvedCount', { done: Object.keys(completed).length, total: PUZZLES.length }),
    w / 2, h * 0.06 + 32,
    { font: '14px sans-serif', align: 'center', color: 'rgba(255,255,255,0.6)' },
  );

  // Grid lives inside the shared menu column so its right edge aligns with
  // the Back button. Cells fill the column width (no fixed cap) so wide
  // viewports don't leave a gap between the rightmost card and Back.
  const col = render.menuColumn();
  const cols = Math.min(3, Math.max(2, Math.floor(col.w / 230)));
  const gap = 14;
  const cellW = Math.floor((col.w - (cols - 1) * gap) / cols);
  const cellH = 110;
  const totalW = cols * cellW + (cols - 1) * gap;
  const ox = col.x + Math.floor((col.w - totalW) / 2);
  const listTop = h * 0.18;
  const listBottom = h - 20;
  const visibleH = Math.max(120, listBottom - listTop);
  const rows = Math.ceil(PUZZLES.length / cols);
  const totalH = rows * cellH + (rows - 1) * gap;
  maxScroll = Math.max(0, totalH - visibleH);
  scrollY = Math.max(0, Math.min(maxScroll, scrollY));

  const ctx = render.ctxRef();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, w, visibleH);
  ctx.clip();

  for (let i = 0; i < PUZZLES.length; i++) {
    const p = PUZZLES[i];
    const col = i % cols, row = Math.floor(i / cols);
    const x = ox + col * (cellW + gap);
    const y = listTop + row * (cellH + gap) - scrollY;
    if (y + cellH < listTop - 4 || y > listBottom + 4) continue;
    const isDone = !!completed[String(p.id)];
    drawPuzzleTile(x, y, cellW, cellH, p, isDone);
  }
  ctx.restore();

  if (maxScroll > 0) {
    const trackX = w - 8;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(trackX, listTop, 3, visibleH);
    const thumbH = Math.max(20, (visibleH / totalH) * visibleH);
    const thumbY = listTop + (scrollY / maxScroll) * (visibleH - thumbH);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(trackX, thumbY, 3, thumbH);
  }

  const backW = render.layout.isNarrow ? 56 : 76;
  const col = render.menuColumn();
  render.drawHitButton(col.right - backW, 16, backW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);
}

function drawPuzzleTile(x, y, w, h, puzzle, done) {
  const hover = cursorX >= x && cursorX <= x + w && cursorY >= y && cursorY <= y + h;
  const ctx = render.ctxRef();
  ctx.save();
  render.roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = done ? 'rgba(95,208,104,0.22)' : hover ? 'rgba(124,58,237,0.8)' : 'rgba(60,50,100,0.85)';
  ctx.fill();
  ctx.strokeStyle = done ? 'rgba(95,208,104,0.5)' : 'rgba(255,255,255,0.1)';
  ctx.stroke();

  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
  render.fillTextEllipsized(ctx,
    i18n.t('puzzleSelect.tileLabel', { id: puzzle.id, name: i18n.t(puzzle.nameKey) }),
    x + 14, y + 14, w - 48);

  ctx.font = '12px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  render.fillTextEllipsized(ctx, i18n.t(puzzle.hintKey), x + 14, y + 38, w - 28);

  ctx.font = '11px sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.fillText(i18n.tn('puzzleSelect.tileMoves', puzzle.moves), x + 14, y + h - 22);

  if (done) {
    ctx.font = '22px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillStyle = '#5fd068';
    ctx.fillText('✓', x + w - 14, y + 12);
  }

  ctx.restore();
  buttons.push({ x, y, w, h, onClick: () => setScene('gamePuzzle', { puzzle: puzzle.id }) });
}

export function onPointer(evt) {
  if (evt.type === 'down') {
    isPointerDown = true;
    didDragScroll = false;
    dragStartY = evt.y;
    dragStartScroll = scrollY;
  } else if (evt.type === 'up') {
    if (!didDragScroll) {
      for (let i = buttons.length - 1; i >= 0; i--) {
        const b = buttons[i];
        if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
          b.onClick(); break;
        }
      }
    }
    isPointerDown = false;
  } else if (evt.type === 'cancel') {
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
