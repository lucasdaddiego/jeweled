// Welcome / title scene: mode selector, continue, streak heatmap, settings.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as i18n from '../i18n.js';
import * as dialogs from '../dialogs.js';
import { todayISO } from '../rng.js';
import { setScene } from '../main.js';
import { NAME_MAX_LEN } from '../config.js';
import { levelCount } from '../levels.js';
import { PUZZLES } from '../puzzles.js';

let buttons = [];          // hit-test rects: { x, y, w, h, onClick, hover }
let nameInputWrap = null;
let settingsOpen = false;
let cursorX = 0, cursorY = 0;
let needsNameEntry = false;

export function enter() {
  // Body keeps its default animated gradient — no class needed unless we want
  // a theme-* palette override.
  document.body.className = '';
  buttons = [];
  settingsOpen = false;
  const profile = storage.getProfile();
  needsNameEntry = !profile.playerName;
  if (needsNameEntry) showNameEntry();
}

export function exit() {
  hideNameEntry();
  settingsOpen = false;
}

export function update(dt) {}

export function draw() {
  const { w, h } = render.getViewport();
  render.clearFrame();
  buttons = [];

  const state = storage.load();
  const profile = state.profile;

  const btnW = Math.min(360, w - 40);
  const btnH = render.layout.isNarrow ? 56 : 62;
  const btnGap = 10;
  const last = profile.lastPlayedMode;
  const continueState = last && state[last] && state[last].saveState ? state[last].saveState : null;
  const buttonCount = (continueState ? 1 : 0) + 5;

  // Heatmap geometry (12 weeks × 7 days, 14px cells with 3px gaps)
  const hmCell = 14, hmGap = 3, hmWeeks = 12, hmDays = 7;
  const hmW = hmWeeks * (hmCell + hmGap) - hmGap;
  const hmH = hmDays * (hmCell + hmGap) - hmGap;
  const labelH = 24; // "streak" text below

  // Vertical block sizes
  const titleH = 56;
  const welcomeH = 28;
  const titleBlockH = titleH + (needsNameEntry ? 0 : welcomeH);
  const buttonsH = buttonCount * btnH + (buttonCount - 1) * btnGap;
  const heatmapBlockH = hmH + labelH;
  const preButtonsGap = 24;     // was 36 — title → buttons
  const preHeatmapGap = 20;     // was 40 — buttons → heatmap

  const totalH = titleBlockH + preButtonsGap + buttonsH + preHeatmapGap + heatmapBlockH;
  let y = Math.max(40, Math.floor((h - totalH) / 2));

  const titleFontPx = render.layout.isNarrow ? 36 : 48;
  // 'GEM MATCH' kept as the brand chip — not translated.
  render.drawText(i18n.t('title.brand'), w / 2, y, {
    font: `bold ${titleFontPx}px -apple-system, system-ui, sans-serif`,
    align: 'center',
    shadow: true,
  });
  y += titleH;

  if (!needsNameEntry) {
    render.drawText(i18n.t('title.welcomeBack', { name: profile.playerName }), w / 2, y, {
      font: `${render.responsiveFont(18)}px -apple-system, system-ui, sans-serif`,
      align: 'center',
      color: 'rgba(255,255,255,0.7)',
    });
    y += welcomeH;
  }
  y += preButtonsGap; // gap before buttons

  // Continue button (if applicable). Only Zen + Classic snapshot saveState today;
  // other modes never set it, so they'll never appear here.
  const CONTINUE_SCENES = { zen: 'gameZen', classic: 'gameClassic' };
  if (continueState && CONTINUE_SCENES[last]) {
    const label = last === 'classic' ? i18n.t('title.continueClassic') : i18n.t('title.continueZen');
    const subtitle = last === 'classic'
      ? i18n.t('title.continueSubtitleClassic', { level: continueState.level, score: i18n.formatNumber(continueState.score) })
      : i18n.t('title.continueSubtitleZen', { score: i18n.formatNumber(continueState.score) });
    const x = (w - btnW) / 2;
    drawHitButton(x, y, btnW, btnH, label, () => {
      setScene(CONTINUE_SCENES[last], { restoreFrom: continueState });
    }, { subtitle });
    y += btnH + btnGap;
  }

  // Zen
  {
    const x = (w - btnW) / 2;
    const subtitle = state.zen.bestScore > 0
      ? i18n.t('title.zenBest', { score: i18n.formatNumber(state.zen.bestScore) })
      : i18n.t('title.zenEndless');
    drawHitButton(x, y, btnW, btnH, i18n.t('title.zen'), () => setScene('gameZen'), { subtitle });
    y += btnH + btnGap;
  }
  // Classic
  {
    const x = (w - btnW) / 2;
    const totalStars = Object.values(state.classic.levels).reduce((s, l) => s + (l.starsEarned || 0), 0);
    const subtitle = i18n.t('title.classicSubtitle', {
      current: state.classic.highestUnlocked, total: levelCount(), stars: totalStars,
    });
    drawHitButton(x, y, btnW, btnH, i18n.t('title.classic'), () => setScene('levelSelect'), { subtitle });
    y += btnH + btnGap;
  }
  // Daily
  {
    const x = (w - btnW) / 2;
    const today = todayISO();
    const formattedToday = i18n.formatDate(today, render.layout.isNarrow
      ? { year: 'numeric', month: 'numeric', day: 'numeric' }
      : undefined);
    const submitted = state.daily.todaySubmittedDate === today;
    const subtitle = submitted
      ? i18n.t('title.dailySubtitleDone', { date: formattedToday })
      : i18n.t('title.dailySubtitle', { date: formattedToday });
    drawHitButton(x, y, btnW, btnH, i18n.t('title.daily'), () => setScene('gameDaily'), { subtitle });
    y += btnH + btnGap;
  }
  // Blitz
  {
    const x = (w - btnW) / 2;
    const subtitle = state.blitz?.bestScore > 0
      ? i18n.t('title.blitzSubtitleBest', { score: i18n.formatNumber(state.blitz.bestScore) })
      : i18n.t('title.blitzSubtitle');
    drawHitButton(x, y, btnW, btnH, i18n.t('title.blitz'), () => setScene('gameBlitz'), { subtitle });
    y += btnH + btnGap;
  }
  // Puzzle
  {
    const x = (w - btnW) / 2;
    const done = Object.keys(state.puzzle?.completed || {}).length;
    const subtitle = i18n.t('title.puzzlesSubtitle', { done, total: PUZZLES.length });
    drawHitButton(x, y, btnW, btnH, i18n.t('title.puzzles'), () => setScene('puzzleSelect'), { subtitle });
    y += btnH + btnGap;
  }

  // Gap before heatmap
  y += preHeatmapGap - btnGap;

  // Heatmap, centered horizontally
  drawHeatmap(state.playHistory, Math.floor((w - hmW) / 2), y, hmWeeks, hmDays, hmCell, hmGap);

  // Stats + Settings icons (top-right corner, near the title rather than the
  // far bottom of the viewport so they read as part of the menu group).
  const sw = 44;
  const iconY = 16;
  drawHitButton(w - sw * 2 - 24, iconY, sw, sw, '📊', () => setScene('stats'));
  drawHitButton(w - sw - 16,     iconY, sw, sw, '⚙', () => { settingsOpen = !settingsOpen; });

  if (settingsOpen) drawSettingsOverlay();
}

function drawHitButton(x, y, w, h, label, onClick, opts = {}) {
  render.drawHitButton(x, y, w, h, label, onClick, buttons, cursorX, cursorY, opts);
}

function drawHeatmap(history, x, y, weeks, days, cell = 14, gap = 3) {
  const ctx = render.ctxRef();
  const now = new Date();
  const totalDays = weeks * days;
  ctx.save();
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(now);
    d.setDate(d.getDate() - (totalDays - 1 - i));
    const iso = todayISO(d);
    const col = Math.floor(i / days);
    const row = i % days;
    const entry = history[iso];
    const runs = entry?.runs || 0;
    let color;
    if (runs === 0) color = 'rgba(255,255,255,0.08)';
    else if (runs === 1) color = 'rgba(124, 58, 237, 0.4)';
    else if (runs <= 3) color = 'rgba(124, 58, 237, 0.7)';
    else color = 'rgba(124, 58, 237, 1)';
    ctx.fillStyle = color;
    ctx.fillRect(x + col * (cell + gap), y + row * (cell + gap), cell, cell);
  }
  ctx.restore();
  // Centered "streak" label below
  const w = weeks * (cell + gap) - gap;
  render.drawText(i18n.t('title.streak'), x + w / 2, y + days * (cell + gap) + 4, {
    font: '11px -apple-system, system-ui, sans-serif',
    color: 'rgba(255,255,255,0.5)',
    align: 'center',
  });
}

function drawSettingsOverlay() {
  const { w, h } = render.getViewport();
  const ctx = render.ctxRef();
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillRect(0, 0, w, h);

  const panelW = Math.min(380, w - 40);
  const panelH = 420;   // bumped to fit the language row
  const px = (w - panelW) / 2;
  const py = (h - panelH) / 2;
  render.roundRect(ctx, px, py, panelW, panelH, 16);
  ctx.fillStyle = '#1a1530';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();

  render.drawText(i18n.t('settings.title'), px + panelW / 2, py + 20, {
    font: 'bold 22px -apple-system, system-ui, sans-serif',
    align: 'center',
  });

  const settings = storage.getSettings();
  let ty = py + 60;
  const rowH = 44;

  drawToggle(px + 20, ty, panelW - 40, i18n.t('settings.haptic'), settings.haptic, () => {
    storage.saveKey('settings', { haptic: !settings.haptic });
  }); ty += rowH;

  drawToggle(px + 20, ty, panelW - 40, i18n.t('settings.paintingMode'), settings.paintingMode, () => {
    storage.saveKey('settings', { paintingMode: !settings.paintingMode });
  }); ty += rowH;

  // Language segmented control: label on left, three pills on right.
  drawLanguageRow(px + 20, ty, panelW - 40);
  ty += rowH + 12;

  // Reset progress
  drawHitButton(px + 20, ty + 4, panelW - 40, 40, i18n.t('settings.resetProgress'), async () => {
    if (await dialogs.confirm(i18n.t('settings.resetConfirm'))) {
      storage.reset();
      i18n.init();
      needsNameEntry = true;
      settingsOpen = false;
      showNameEntry();
    }
  }, { kind: 'settings' });
  ty += 60;

  // Close button
  drawHitButton(px + panelW / 2 - 60, py + panelH - 50, 120, 36, i18n.t('settings.close'), () => {
    settingsOpen = false;
  }, { kind: 'settings' });
}

// Three-pill segmented control: Auto / English / Español. The active pill is
// highlighted in purple. Clicking a pill calls i18n.setLanguage, which saves
// the setting and recomputes the active locale; the next frame redraws every
// scene's text in the new language.
function drawLanguageRow(x, y, w) {
  render.drawText(i18n.t('settings.language'), x, y + 10, {
    font: '15px -apple-system, system-ui, sans-serif',
  });
  const labelW = 90;
  const pillsX = x + labelW;
  const pillsW = w - labelW;
  const ctx = render.ctxRef();
  const setting = i18n.getLanguageSetting();
  const options = [
    { key: 'auto', label: i18n.t('settings.languageAuto') },
    { key: 'en',   label: i18n.t('settings.languageEn') },
    { key: 'es',   label: i18n.t('settings.languageEs') },
  ];
  const pillW = (pillsW - 2 * 6) / options.length;
  const pillH = 30;
  const py = y + 6;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const pillX = pillsX + i * (pillW + 6);
    const active = setting === opt.key;
    ctx.save();
    render.roundRect(ctx, pillX, py, pillW, pillH, 8);
    ctx.fillStyle = active ? '#7c3aed' : 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '13px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opt.label, pillX + pillW / 2, py + pillH / 2);
    ctx.restore();
    buttons.push({ x: pillX, y: py, w: pillW, h: pillH, onClick: () => i18n.setLanguage(opt.key), kind: 'settings' });
  }
}

function drawToggle(x, y, w, label, value, onClick) {
  const ctx = render.ctxRef();
  render.drawText(label, x, y + 10, { font: '15px -apple-system, system-ui, sans-serif' });
  const toggleW = 50, toggleH = 26;
  const tx = x + w - toggleW, ty = y + 8;
  ctx.save();
  render.roundRect(ctx, tx, ty, toggleW, toggleH, 13);
  ctx.fillStyle = value ? '#7c3aed' : 'rgba(255,255,255,0.15)';
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.arc(tx + (value ? toggleW - toggleH / 2 : toggleH / 2), ty + toggleH / 2, toggleH / 2 - 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  buttons.push({ x: tx, y: ty, w: toggleW, h: toggleH, onClick, kind: 'settings' });
}

export function onPointer(evt) {
  if (evt.type !== 'down') return;
  if (nameInputWrap) return; // name modal blocks
  if (settingsOpen) {
    for (let i = buttons.length - 1; i >= 0; i--) {
      const b = buttons[i];
      if (b.kind !== 'settings') continue;
      if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
        b.onClick();
        return;
      }
    }
    settingsOpen = false;
    return;
  }
  // Iterate in reverse so the most-recently-drawn (top-most) button wins.
  // Critical when the settings overlay is open — its toggles sit visually on top
  // of the mode buttons, so they need first dibs on the click.
  for (let i = buttons.length - 1; i >= 0; i--) {
    const b = buttons[i];
    if (evt.x >= b.x && evt.x <= b.x + b.w && evt.y >= b.y && evt.y <= b.y + b.h) {
      b.onClick();
      return;
    }
  }
}

export function onMove(x, y) {
  cursorX = x; cursorY = y;
}

// === Name entry modal (the one DOM input) ===
function showNameEntry() {
  if (nameInputWrap) return;
  nameInputWrap = document.createElement('div');
  nameInputWrap.id = 'name-input-wrap';
  // Build child nodes via DOM APIs rather than innerHTML so localized strings
  // are inserted safely (no escaping concerns, no accidental HTML injection).
  const card = document.createElement('div');
  const label = document.createElement('label');
  label.setAttribute('for', 'name-input');
  label.textContent = i18n.t('name_entry.label');
  const input = document.createElement('input');
  input.id = 'name-input';
  input.type = 'text';
  input.maxLength = NAME_MAX_LEN;
  input.autocomplete = 'off';
  input.autofocus = true;
  const submit = document.createElement('button');
  submit.id = 'name-submit';
  submit.textContent = i18n.t('name_entry.start');
  card.appendChild(label);
  card.appendChild(input);
  card.appendChild(submit);
  nameInputWrap.appendChild(card);
  document.body.appendChild(nameInputWrap);
  setTimeout(() => input.focus(), 50);
  const tryCommit = () => {
    const name = input.value.trim().slice(0, NAME_MAX_LEN);
    if (!name) { input.focus(); return; }
    storage.saveKey('profile', { playerName: name });
    needsNameEntry = false;
    hideNameEntry();
  };
  submit.addEventListener('click', tryCommit);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') tryCommit(); });
}

function hideNameEntry() {
  if (nameInputWrap && nameInputWrap.parentNode) nameInputWrap.parentNode.removeChild(nameInputWrap);
  nameInputWrap = null;
}
