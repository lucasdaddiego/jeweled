// Gempedia — reference catalog of every special gem and power-up. Reachable
// from the title. Pure viewer: cards are static content, so the only
// interactive element (and the only buttons[] entry) is the Back button.

import * as render from '../render.js';
import * as i18n from '../i18n.js';
import { POWERUP_SLOTS, POWERUP_META } from '../config.js';
import { setScene } from '../main.js';

// One card per catalog entry. name/desc/how are i18n keys — i18n.t() falls
// back to the key string, so the scene renders even before the dictionaries
// gain the gempedia.* strings.
function entry(id, emoji, ring) {
  return {
    id,
    emoji,
    ring,
    nameKey: `gempedia.${id}.name`,
    descKey: `gempedia.${id}.desc`,
    howKey: `gempedia.${id}.how`,
  };
}

// Special gems first (LINE_H + LINE_V share the one 'line' card), then the
// four power-up slots with their canonical emoji/ring from POWERUP_META.
export const ENTRIES = [
  entry('line', '↔️', '#8ab4ff'),
  entry('colorBomb', '🔮', '#c084fc'),
  entry('areaBomb', '💥', '#ff8a3d'),
  entry('star', '⭐', '#ffd700'),
  entry('fire', '🔥', '#ff5722'),
  entry('lightning', '⚡', '#ffeb3b'),
  entry('wildcard', '🃏', '#7c3aed'),
  entry('coin', '🪙', '#ffd166'),
  entry('gravity', '🔃', '#6ee7b7'),
  entry('timeBomb', '💣', '#ff4444'),
  ...POWERUP_SLOTS.map((slot) => entry(slot, POWERUP_META[slot].emoji, POWERUP_META[slot].ring)),
];

const CARD_H = 92;
const CARD_GAP = 12;
const SCROLL_THRESHOLD = 8;

let buttons = [];
let cursorX = 0, cursorY = 0;
let scrollY = 0;
let maxScroll = 0;
let isPointerDown = false;
let dragStartY = 0, dragStartScroll = 0;
let didDragScroll = false;

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

  const titleY = h * 0.05 + render.layout.safeTop;
  render.drawText(i18n.t('gempedia.title'), w / 2, titleY, {
    font: `bold ${render.responsiveFont(26)}px -apple-system, system-ui, sans-serif`,
    align: 'center',
  });
  render.drawText(i18n.t('gempedia.subtitle'), w / 2, titleY + 32, {
    font: '14px sans-serif', align: 'center', color: 'rgba(255,255,255,0.6)',
  });

  // Scrollable card list — one column inside the shared menu column so the
  // cards, title, and Back button all anchor to the same horizontal bounds.
  const listTop = titleY + 64;
  const listBottom = h - 16;
  const visibleH = listBottom - listTop;
  const col = render.menuColumn();
  const totalH = ENTRIES.length * CARD_H + (ENTRIES.length - 1) * CARD_GAP;
  maxScroll = Math.max(0, totalH - visibleH);

  const ctx = render.ctxRef();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, listTop, w, visibleH);
  ctx.clip();

  for (let i = 0; i < ENTRIES.length; i++) {
    const y = listTop + i * (CARD_H + CARD_GAP) - scrollY;
    if (y + CARD_H < listTop - 4 || y > listBottom + 4) continue;
    drawCard(col.x, y, col.w, CARD_H, ENTRIES[i]);
  }
  ctx.restore();

  // Scroll thumb
  if (maxScroll > 0) {
    const trackX = w - 8;
    const trackH = visibleH;
    ctx.fillStyle = 'rgba(255,255,255,0.05)';
    ctx.fillRect(trackX, listTop, 3, trackH);
    const thumbH = Math.max(20, (visibleH / totalH) * trackH);
    const thumbY = listTop + (scrollY / maxScroll) * (trackH - thumbH);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(trackX, thumbY, 3, thumbH);
  }

  // Back button — shared menu-column anchor so all menu scenes align.
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  render.drawHitButton(col.right - backW, backY, backW, 32,
    render.layout.isNarrow ? i18n.t('common.backShort') : i18n.t('common.back'),
    () => setScene('title'), buttons, cursorX, cursorY);
}

function drawCard(x, y, w, h, e) {
  const ctx = render.ctxRef();
  ctx.save();

  // Card background
  render.roundRect(ctx, x, y, w, h, 12);
  ctx.fillStyle = 'rgba(40,30,80,0.55)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.stroke();

  // Emoji badge — rounded square tinted with the entry's ring color.
  const side = 56;
  const bx = x + 14;
  const by = y + (h - side) / 2;
  render.roundRect(ctx, bx, by, side, side, 12);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = e.ring;
  ctx.fill();
  ctx.globalAlpha = 0.55;
  ctx.strokeStyle = e.ring;
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.font = `${Math.floor(side * 0.58)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(e.emoji, bx + side / 2, by + side / 2 + 1);

  // Name, effect description, and how-you-get-it — ellipsized to the card's
  // text width so long localized strings can't bleed past the card edge.
  const tx = bx + side + 14;
  const maxTextW = x + w - 14 - tx;
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = 'bold 16px sans-serif';
  render.fillTextEllipsized(ctx, i18n.t(e.nameKey), tx, y + h * 0.26, maxTextW);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '13px sans-serif';
  render.fillTextEllipsized(ctx, i18n.t(e.descKey), tx, y + h * 0.52, maxTextW);
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = 'italic 12px sans-serif';
  render.fillTextEllipsized(ctx, i18n.t(e.howKey), tx, y + h * 0.76, maxTextW);
  ctx.restore();
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
  } else if (evt.type === 'cancel') {
    // OS pointercancel (gesture/blur) mid-drag: clear the flag so a stray later
    // pointermove can't recompute scrollY from a stale drag origin. Mirrors
    // stats' handling.
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
