// In-canvas modal dialogs. Scenes call confirm()/alert(); main.js draws and
// routes pointer input here before the active scene so dialogs block gameplay.

import * as render from './render.js';
import * as i18n from './i18n.js';
import * as dragInput from './dragInput.js';

let active = null;
let buttons = [];
let cursorX = 0;
let cursorY = 0;

export function isOpen() {
  return !!active;
}

// Called by main.js popstate handler. If a dialog is open, dismiss it with a
// cancel result (so any `await dialogs.confirm(...)` resolves to false instead
// of hanging forever) and tell the caller to skip the scene swap. Returns true
// if a dialog was actually consumed.
export function consumeBack() {
  if (!active) return false;
  settle(false);
  return true;
}

export function confirm(message, opts = {}) {
  return open({
    kind: 'confirm',
    message,
    confirmLabel: opts.confirmLabel || i18n.t('common.ok'),
    cancelLabel: opts.cancelLabel || i18n.t('common.cancel'),
  });
}

export function alert(message, opts = {}) {
  return open({
    kind: 'alert',
    message,
    confirmLabel: opts.okLabel || i18n.t('common.close'),
  });
}

function open(config) {
  if (active) settle(false);
  // Cancel any in-flight drag — if a dialog opens between pointerdown and
  // pointerup (e.g. a milestone popup raised by onScoreChanged during a
  // swap), the drag would never see the matching `up` and the gem would stay
  // visually lifted. dragInput.cancel() is a no-op when nothing is active.
  dragInput.cancel();
  return new Promise(resolve => {
    active = { ...config, resolve };
    buttons = [];
  });
}

function settle(value) {
  if (!active) return;
  const resolve = active.resolve;
  active = null;
  buttons = [];
  resolve(value);
}

export function draw() {
  if (!active) return;
  const { w, h } = render.getViewport();
  const ctx = render.ctxRef();
  buttons = [];

  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.68)';
  ctx.fillRect(0, 0, w, h);

  const panelW = Math.min(420, w - 32);
  const panelX = (w - panelW) / 2;
  const lines = wrapText(ctx, active.message || '', panelW - 48, '17px -apple-system, system-ui, sans-serif');
  const panelH = Math.max(170, 84 + lines.length * 24 + 54);
  const panelY = Math.max(18, (h - panelH) / 2);

  render.roundRect(ctx, panelX, panelY, panelW, panelH, 14);
  ctx.fillStyle = '#1a1530';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.12)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  ctx.fillStyle = '#f3f0ff';
  ctx.font = '17px -apple-system, system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  let y = panelY + 28;
  for (const line of lines) {
    ctx.fillText(line, panelX + panelW / 2, y);
    y += 24;
  }
  ctx.restore();

  const btnH = 42;
  const gap = 12;
  if (active.kind === 'confirm') {
    const btnW = Math.min(150, (panelW - 64 - gap) / 2);
    const bx = panelX + panelW / 2 - btnW - gap / 2;
    const by = panelY + panelH - btnH - 24;
    render.drawHitButton(bx, by, btnW, btnH, active.cancelLabel, () => settle(false),
      buttons, cursorX, cursorY);
    render.drawHitButton(bx + btnW + gap, by, btnW, btnH, active.confirmLabel, () => settle(true),
      buttons, cursorX, cursorY);
  } else {
    const btnW = Math.min(180, panelW - 64);
    render.drawHitButton(panelX + panelW / 2 - btnW / 2, panelY + panelH - btnH - 24,
      btnW, btnH, active.confirmLabel, () => settle(true), buttons, cursorX, cursorY);
  }
}

export function handlePointer(evt) {
  if (!active) return false;
  if (evt.type !== 'down') return true;
  for (let i = buttons.length - 1; i >= 0; i--) {
    const b = buttons[i];
    if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
      b.onClick();
      return true;
    }
  }
  return true;
}

export function onMove(x, y) {
  cursorX = x;
  cursorY = y;
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', e => {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      settle(false);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      settle(true);
    }
  });
}

function wrapText(ctx, text, maxW, font) {
  ctx.save();
  ctx.font = font;
  const words = String(text).split(/\s+/).filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (ctx.measureText(candidate).width <= maxW || !line) {
      line = candidate;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  ctx.restore();
  return lines.length ? lines : [''];
}
