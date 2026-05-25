// Shared power-up UI: side panel, target-mode dim, recolor color picker,
// milestone "+1 charge" popup. Used by gameZen and gameClassic.
//
// Game scenes bind their grid + cascade, then:
//   - draw(cursorX, cursorY, buttons)         in their draw()
//   - handlePointer(evt)                       in their onPointer()
//   - notifyMilestoneEarned(count)             from cascade.onScoreChanged
//
// Module-level state is fine because only one game scene runs at a time.

import * as render from '../render.js';
import * as powerups from '../powerups.js';
import * as i18n from '../i18n.js';
import { POWERUP_SLOTS, POWERUP_META, TYPES } from '../config.js';
import { STATE } from '../cascade.js';
import { GEM_COLORS } from '../render.js';

let grid = null;
let cascade = null;
let pendingPowerup = null;       // null | 'colorBlast' | 'bombDrop' | 'recolor'
let recolorPickerAt = null;      // {r, c} when recolor needs a color
let milestonePopup = false;      // true when the picker is showing
let pendingMilestones = 0;       // queue of unallocated charges
let milestoneFloor = 0;          // run-local score floor for progress ring

export function bind(g, c)    { grid = g; cascade = c; }
export function unbind()      { grid = null; cascade = null; reset(); }
export function reset() {
  pendingPowerup = null;
  recolorPickerAt = null;
  milestonePopup = false;
  pendingMilestones = 0;
  milestoneFloor = 0;
}

export function setMilestoneFloor(floor) {
  milestoneFloor = floor || 0;
}

export function isModalOpen() {
  return !!(recolorPickerAt || milestonePopup);
}

export function notifyMilestoneEarned(count) {
  if (count <= 0) return;
  pendingMilestones += count;
  milestonePopup = true;
}

// ----- Drawing -----

export function draw(cursorX, cursorY, buttons) {
  if (pendingPowerup) drawTargetModeOverlay(cursorX, cursorY);
  drawPowerupPanel(cursorX, cursorY, buttons);
  if (recolorPickerAt) drawRecolorPicker(cursorX, cursorY, buttons);
  if (milestonePopup) drawMilestonePopup(cursorX, cursorY, buttons);
}

function drawPowerupPanel(cursorX, cursorY, buttons) {
  const px = render.layout.panelX + 6;
  const pw = render.layout.panelW - 12;
  const slotH = pw + 12;
  const gap = 8;
  // Vertically center the slot stack within the board height so the panel
  // hugs the right side of the board on its midline rather than its top edge.
  const stackH = POWERUP_SLOTS.length * slotH + (POWERUP_SLOTS.length - 1) * gap;
  let py = render.layout.boardY + Math.max(0, Math.floor((render.layout.boardSize - stackH) / 2));
  const charges = powerups.getCharges();
  const progress = powerups.milestoneProgress(cascade.score, milestoneFloor);
  for (const slot of POWERUP_SLOTS) {
    const meta = POWERUP_META[slot];
    const hover = cursorX >= px && cursorX <= px + pw && cursorY >= py && cursorY <= py + slotH;
    const isActive = pendingPowerup === slot;
    render.drawPowerupSlot(px, py, pw, slotH, meta.emoji, meta.ring, charges[slot], progress, hover, isActive);
    buttons.push({ x: px, y: py, w: pw, h: slotH, onClick: () => onPowerupSlotClicked(slot), kind: 'powerup' });
    py += slotH + gap;
  }
}

function drawTargetModeOverlay(cursorX, cursorY) {
  const ctx = render.ctxRef();
  const { w, h } = render.getViewport();
  // Dim the 4 strips around the board instead of dimming-then-clearing-then-
  // redrawing the board. The scene already drew the board this frame; leaving
  // the board region untouched keeps it bright without paying for a second
  // render.drawBoard call.
  const bx = render.layout.boardX, by = render.layout.boardY, bs = render.layout.boardSize;
  const pad = 8;
  const tx = Math.max(0, bx - pad);
  const ty = Math.max(0, by - pad);
  const trx = Math.min(w, bx + bs + pad);
  const try_ = Math.min(h, by + bs + pad);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
  if (ty > 0)            ctx.fillRect(0, 0, w, ty);                  // top strip
  if (try_ < h)          ctx.fillRect(0, try_, w, h - try_);          // bottom strip
  if (tx > 0)            ctx.fillRect(0, ty, tx, try_ - ty);          // left strip
  if (trx < w)           ctx.fillRect(trx, ty, w - trx, try_ - ty);   // right strip
  const meta = POWERUP_META[pendingPowerup];
  render.drawText(
    i18n.t('powerup.targetHint', { emoji: meta.emoji, label: i18n.t(`powerup.${pendingPowerup}.label`) }),
    render.boardCenterX(), render.layout.hudY + 6, {
      font: `bold ${render.responsiveFont(18)}px sans-serif`,
      align: 'center', shadow: true,
    },
  );
  render.drawText(i18n.t('powerup.tapOutsideCancel'),
    render.boardCenterX(), render.layout.boardY + render.layout.boardSize + 14, {
      font: '12px sans-serif', align: 'center', color: 'rgba(255,255,255,0.7)',
  });
}

function drawRecolorPicker(cursorX, cursorY, buttons) {
  const { w, h } = render.getViewport();
  const ctx = render.ctxRef();
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, w, h);
  const pw = Math.min(360, w - 32), ph = 110;
  const px = (w - pw) / 2, py = (h - ph) / 2;
  render.roundRect(ctx, px, py, pw, ph, 12);
  ctx.fillStyle = '#1a1530'; ctx.fill();
  render.drawText(i18n.t('powerup.pickColor'), px + pw / 2, py + 22, { font: 'bold 16px sans-serif', align: 'center' });
  const sw = (pw - 32) / TYPES;
  for (let t = 0; t < TYPES; t++) {
    const sx = px + 16 + t * sw;
    const sy = py + 50;
    const sd = sw * 0.85;
    ctx.beginPath();
    ctx.arc(sx + sw / 2, sy + sd / 2, sd / 2 - 4, 0, Math.PI * 2);
    ctx.fillStyle = GEM_COLORS[t]; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.3)'; ctx.stroke();
    buttons.push({
      x: sx + 2, y: sy + 2, w: sw - 4, h: sd - 4,
      onClick: () => onRecolorColorPicked(t), kind: 'colorPick', modal: true,
    });
  }
}

function drawMilestonePopup(cursorX, cursorY, buttons) {
  const { w, h } = render.getViewport();
  const ctx = render.ctxRef();
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, w, h);
  const pw = Math.min(380, w - 32), ph = 280;
  const px = (w - pw) / 2, py = (h - ph) / 2;
  render.roundRect(ctx, px, py, pw, ph, 14);
  ctx.fillStyle = '#1a1530'; ctx.fill();
  render.drawText(i18n.t('powerup.chargeEarned'), px + pw / 2, py + 28, {
    font: 'bold 20px sans-serif', align: 'center',
  });
  render.drawText(i18n.t('powerup.pickFill'), px + pw / 2, py + 56, {
    font: '14px sans-serif', align: 'center', color: 'rgba(255,255,255,0.7)',
  });
  const slotW = (pw - 40) / 4;
  const slotH = 90;
  for (let i = 0; i < POWERUP_SLOTS.length; i++) {
    const slot = POWERUP_SLOTS[i];
    const meta = POWERUP_META[slot];
    const sx = px + 20 + i * slotW;
    const sy = py + 100;
    const charges = powerups.getCharges()[slot];
    const full = powerups.isFull(slot);
    const hover = !full && cursorX >= sx && cursorX <= sx + slotW - 8 && cursorY >= sy && cursorY <= sy + slotH;
    render.drawPowerupSlot(sx, sy, slotW - 8, slotH, meta.emoji, meta.ring, charges, 0, hover, false);
    if (full) {
      ctx.save();
      ctx.globalAlpha = 0.45;
      ctx.fillStyle = '#000';
      render.roundRect(ctx, sx, sy, slotW - 8, slotH, 10);
      ctx.fill();
      ctx.restore();
    } else {
      buttons.push({
        x: sx, y: sy, w: slotW - 8, h: slotH,
        onClick: () => onMilestonePicked(slot), kind: 'milestone', modal: true,
      });
    }
  }
  render.drawText(i18n.t('powerup.saveForLater'), px + pw / 2, py + ph - 30, {
    font: '12px sans-serif', align: 'center', color: 'rgba(255,255,255,0.5)',
  });
}

// ----- Pointer handling -----
// Returns true if the click was handled by the overlay (modal dismiss or board target).
// Slot/button clicks are still handled by the scene's main button-iteration loop
// because they live in the shared buttons[] array.
export function handlePointer(evt) {
  if (evt.type !== 'down') return false;
  if (milestonePopup)   { milestonePopup = false; return true; }
  if (recolorPickerAt)  { recolorPickerAt = null; pendingPowerup = null; return true; }
  if (pendingPowerup) {
    const cell = render.screenToCell(evt.x, evt.y);
    if (cell) { handleTargetTap(cell); return true; }
    pendingPowerup = null;
    return true;
  }
  return false;
}

// ----- Click handlers -----

function onPowerupSlotClicked(slot) {
  if (!powerups.canSpend(slot)) return;
  if (cascade.state !== STATE.IDLE) return;
  if (slot === 'shuffle') {
    powerups.spendCharge(slot);
    // Forward the cascade's seeded rng so Daily/Puzzle determinism survives
    // a Shuffle activation. Currently no seeded mode binds this overlay, but
    // the defense-in-depth lets us add power-ups to those modes later without
    // a silent determinism break.
    powerups.activateShuffle(grid, cascade.rng);
    maybeShowSavedMilestone();
    return;
  }
  pendingPowerup = pendingPowerup === slot ? null : slot;
}

function onMilestonePicked(slot) {
  if (!powerups.addCharge(slot)) return;
  pendingMilestones--;
  if (pendingMilestones <= 0) milestonePopup = false;
}

function onRecolorColorPicked(type) {
  if (!recolorPickerAt) { recolorPickerAt = null; return; }
  const res = powerups.activateRecolor(grid, recolorPickerAt.r, recolorPickerAt.c, type);
  if (res.ok) {
    powerups.spendCharge('recolor');
    cascade.resolveCurrentMatches?.(recolorPickerAt);
    maybeShowSavedMilestone();
  }
  recolorPickerAt = null;
  pendingPowerup = null;
}

function handleTargetTap(cell) {
  if (!cell) { pendingPowerup = null; return; }
  switch (pendingPowerup) {
    case 'colorBlast': {
      const targetType = grid[cell.r][cell.c]?.type;
      if (targetType == null) return;
      const res = powerups.activateColorBlast(grid, targetType);
      if (res.ok) {
        powerups.spendCharge('colorBlast');
        cascade.applyExternalClears(res.clears);
        maybeShowSavedMilestone();
      }
      pendingPowerup = null;
      return;
    }
    case 'bombDrop': {
      const res = powerups.activateBombDrop(grid, cell.r, cell.c);
      if (res.ok) {
        powerups.spendCharge('bombDrop');
        maybeShowSavedMilestone();
      }
      pendingPowerup = null;
      return;
    }
    case 'recolor': {
      if (!powerups.isValidTarget(grid, cell.r, cell.c, 'recolor')) return;
      recolorPickerAt = { r: cell.r, c: cell.c };
      return;
    }
  }
}

function maybeShowSavedMilestone() {
  if (pendingMilestones > 0 && powerups.hasAvailableSlot()) {
    milestonePopup = true;
  }
}
