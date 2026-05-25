// Achievement-unlock toasts. Floats in from the top-right, lingers a few
// seconds, slides out. Pool of 4 — more unlocks queue and play sequentially.

import * as render from './render.js';
import * as achievements from './achievements.js';
import * as i18n from './i18n.js';

const SLOTS = 4;
const LIFE_MS = 3800;

const active = [];

function pump() {
  while (active.length < SLOTS) {
    const t = achievements.consumeToast();
    if (!t) break;
    active.push({ ...t, age: 0 });
  }
}

export function update(dt) {
  pump();
  for (let i = active.length - 1; i >= 0; i--) {
    active[i].age += dt;
    if (active[i].age >= LIFE_MS) active.splice(i, 1);
  }
}

export function draw() {
  if (active.length === 0) return;
  const ctx = render.ctxRef();
  const { w } = render.getViewport();
  const cardW = 280, cardH = 60;
  ctx.save();
  for (let i = 0; i < active.length; i++) {
    const t = active[i];
    const k = t.age / LIFE_MS;
    // slide-in 0→1 over 280ms, hold, slide-out 0.85→1
    let alpha = 1, offsetX = 0;
    if (t.age < 280) {
      const p = t.age / 280;
      alpha = p;
      offsetX = (1 - p) * cardW * 1.2;
    } else if (k > 0.85) {
      const p = (k - 0.85) / 0.15;
      alpha = 1 - p;
      offsetX = p * cardW * 1.2;
    }
    const x = w - cardW - 16 + offsetX;
    const y = 16 + i * (cardH + 10);
    ctx.save();
    ctx.globalAlpha = alpha;
    render.roundRect(ctx, x, y, cardW, cardH, 12);
    ctx.fillStyle = '#2a1a55';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,215,0,0.55)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Icon
    ctx.font = `${Math.floor(cardH * 0.55)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t.icon, x + 30, y + cardH / 2);
    // Title — localized at draw time so language changes between unlock and
    // display pick up immediately.
    ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    ctx.font = `11px sans-serif`;
    ctx.fillText(i18n.t('achievement.unlocked'), x + 60, y + 14);
    ctx.fillStyle = '#fff';
    ctx.font = `bold 16px sans-serif`;
    ctx.fillText(i18n.t(t.nameKey), x + 60, y + 36);
    ctx.restore();
  }
  ctx.restore();
}
