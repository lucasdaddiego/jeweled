// Zen painting gallery: thumbnails auto-captured when a Painting-mode run
// ends. Read-only keepsakes — the full-resolution PNG is offered as a
// download at capture time; this scene shows the history.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import { setScene } from '../main.js';

let buttons = [];
let cursorX = 0, cursorY = 0;

// dataUrl → HTMLImageElement (decoding happens async; draw once complete).
const imgCache = new Map();

function imageFor(dataUrl) {
  let img = imgCache.get(dataUrl);
  if (!img) {
    img = new Image();
    img.src = dataUrl;
    imgCache.set(dataUrl, img);
  }
  return img;
}

export function enter() {
  document.body.className = '';
  buttons = [];
}
export function exit() {}
export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  const titleY = h * 0.07 + render.layout.safeTop;
  render.drawText(i18n.t('gallery.title'), w / 2, titleY, {
    font: `bold ${render.responsiveFont(28)}px -apple-system, system-ui, sans-serif`,
    align: 'center', shadow: true,
  });

  const items = storage.load().zen.gallery || [];
  const colM = render.menuColumn();

  if (items.length === 0) {
    render.drawText(i18n.t('gallery.empty'), w / 2, h * 0.45, {
      font: '16px sans-serif', align: 'center', color: 'rgba(255,255,255,0.6)',
    });
  } else {
    const cols = render.layout.isNarrow ? 2 : 3;
    const gap = 14;
    const tile = Math.floor((colM.w - (cols - 1) * gap) / cols);
    const ox = colM.x;
    const oy = titleY + 56;
    const ctx = render.ctxRef();
    for (let i = 0; i < items.length; i++) {
      const x = ox + (i % cols) * (tile + gap);
      const y = oy + Math.floor(i / cols) * (tile + 26 + gap);
      ctx.save();
      render.roundRect(ctx, x, y, tile, tile, 10);
      ctx.fillStyle = 'rgba(255,255,255,0.05)';
      ctx.fill();
      ctx.clip();
      const img = imageFor(items[i].dataUrl);
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, x, y, tile, tile);
      }
      ctx.restore();
      ctx.save();
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.font = '11px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText(i18n.formatDate(items[i].at ? new Date(items[i].at) : new Date()), x + tile / 2, y + tile + 6);
      ctx.restore();
    }
  }

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
