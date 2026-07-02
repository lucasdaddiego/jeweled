// Welcome / title scene: mode selector, continue, streak heatmap, settings.

import * as render from '../render.js';
import * as storage from '../storage.js';
import * as sound from '../sound.js';
import * as i18n from '../i18n.js';
import * as dialogs from '../dialogs.js';
import { todayISO } from '../rng.js';
import { dailyStreak, msUntilNextDaily, countdownParts } from '../dailyMeta.js';
import { setScene, clockMs } from '../main.js';
import { NAME_MAX_LEN } from '../config.js';
import { levelCount } from '../levels.js';
import { PUZZLES } from '../puzzles.js';
import { BUILD } from '../build.js';

// Public source repository — linked from the title footer.
const REPO_URL = 'https://github.com/lucasdaddiego/jeweled';

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
  hideImportEntry();
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
  // Continue scans BOTH modes that snapshot (most recent savedAt wins) rather
  // than trusting profile.lastPlayedMode — playing a Daily/Blitz in between
  // used to hide a parked Zen/Classic run, and starting that mode fresh then
  // silently overwrote the save on the first idle snapshot.
  let continueMode = null;
  let continueState = null;
  for (const mode of ['zen', 'classic']) {
    const ss = state[mode]?.saveState;
    if (!ss) continue;
    if (!continueState || String(ss.savedAt || '') > String(continueState.savedAt || '')) {
      continueMode = mode;
      continueState = ss;
    }
  }
  // 5 mode buttons + the Stats/Settings sub-row (counts as one row for layout).
  const buttonCount = (continueState ? 1 : 0) + 5 + 1;

  // Short-viewport mode: tighten everything so the heatmap doesn't get
  // clipped at the bottom edge on laptop/landscape windows.
  const isShort = h < 760;
  const btnH = isShort ? 52 : (render.layout.isNarrow ? 56 : 62);
  const btnGap = isShort ? 8 : 10;
  const subBtnH = Math.max(40, btnH - 12); // Stats/Settings row a touch shorter

  // Heatmap geometry (12 weeks × 7 days)
  const hmCell = isShort ? 11 : 14;
  const hmGap = isShort ? 2 : 3;
  const hmWeeks = 12, hmDays = 7;
  const hmW = hmWeeks * (hmCell + hmGap) - hmGap;
  const hmH = hmDays * (hmCell + hmGap) - hmGap;
  const labelH = isShort ? 20 : 24; // "streak" text below

  // Vertical block sizes
  const titleFontPx = render.layout.isNarrow ? 40 : 56;
  const titleH = titleFontPx + 14; // font + glow margin so the welcome line doesn't sit on the halo
  const welcomeH = 28;
  const titleBlockH = titleH + (needsNameEntry ? 0 : welcomeH);
  // Last "row" is the Stats/Settings pair at subBtnH; the rest at btnH.
  const buttonsH = (buttonCount - 1) * btnH + subBtnH + (buttonCount - 1) * btnGap;
  const heatmapBlockH = hmH + labelH;
  const preButtonsGap = isShort ? 16 : 24;
  const preHeatmapGap = isShort ? 14 : 20;

  const totalH = titleBlockH + preButtonsGap + buttonsH + preHeatmapGap + heatmapBlockH;
  // Add safeTop so the brand title doesn't hide under the iOS status bar
  // in standalone / PWA mode.
  const minTop = (isShort ? 20 : 40) + render.layout.safeTop;
  let y = Math.max(minTop, Math.floor((h - totalH) / 2));

  // Brand name kept as English chip — not translated.
  drawBrandTitle(i18n.t('title.brand'), w / 2, y, titleFontPx);
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
  if (continueState && CONTINUE_SCENES[continueMode]) {
    const label = continueMode === 'classic' ? i18n.t('title.continueClassic') : i18n.t('title.continueZen');
    const subtitle = continueMode === 'classic'
      ? i18n.t('title.continueSubtitleClassic', { level: continueState.level, score: i18n.formatNumber(continueState.score) })
      : i18n.t('title.continueSubtitleZen', { score: i18n.formatNumber(continueState.score) });
    const x = (w - btnW) / 2;
    drawHitButton(x, y, btnW, btnH, label, () => {
      setScene(CONTINUE_SCENES[continueMode], { restoreFrom: continueState });
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
    // Done today → countdown to the next board; otherwise the date, with the
    // running streak appended when there is one worth bragging about.
    let subtitle;
    if (submitted) {
      const parts = countdownParts(msUntilNextDaily());
      subtitle = `${i18n.t('title.dailySubtitleDone', { date: formattedToday })}  ·  ${i18n.t('title.dailyNext', { h: parts.hours, m: parts.minutes })}`;
    } else {
      subtitle = i18n.t('title.dailySubtitle', { date: formattedToday });
      const streak = dailyStreak(state.daily.history || {}, today);
      if (streak >= 2) subtitle += `  ·  ${i18n.t('daily.streak', { n: streak })}`;
    }
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
  // Stats + Settings — paired sub-row, together spanning a single main button.
  {
    const x = (w - btnW) / 2;
    const subW = Math.floor((btnW - btnGap) / 2);
    drawHitButton(x, y, subW, subBtnH, i18n.t('title.stats'),
      () => setScene('stats'), { kind: 'secondary' });
    drawHitButton(x + subW + btnGap, y, subW, subBtnH, i18n.t('title.settings'),
      () => { settingsOpen = !settingsOpen; }, { kind: 'secondary' });
    y += subBtnH + btnGap;
  }

  // Gap before heatmap
  y += preHeatmapGap - btnGap;

  // Heatmap, centered horizontally
  drawHeatmap(state.playHistory, Math.floor((w - hmW) / 2), y, hmWeeks, hmDays, hmCell, hmGap);

  // Build tag — tiny, low-contrast, bottom-right. Lets you confirm at a
  // glance which deploy is loaded without taking up real estate. Lifted off
  // the bottom edge by the safe-area inset so it clears the iOS home bar.
  const sab = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sab')) || 0;
  render.drawText(BUILD, w - 10, h - 6 - sab, {
    font: '10px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    color: 'rgba(255,255,255,0.25)',
    align: 'right',
    baseline: 'bottom',
  });

  // Source-code link — tiny, bottom-left, mirroring the build tag opposite it.
  // Opens the public repo in a new tab. The click runs synchronously inside the
  // pointerdown gesture (input.js → onPointer), so window.open isn't blocked.
  {
    const ctx = render.ctxRef();
    const label = i18n.t('title.viewSource');
    ctx.save();
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    const lw = ctx.measureText(label).width;
    const lx = 10;
    const ly = h - 6 - sab;
    const lTop = ly - 13;
    const hover = cursorX >= lx - 6 && cursorX <= lx + lw + 6 && cursorY >= lTop && cursorY <= ly + 3;
    ctx.fillStyle = hover ? 'rgba(190,160,255,0.95)' : 'rgba(255,255,255,0.42)';
    ctx.fillText(label, lx, ly);
    // Underline to signal the link affordance (no CSS cursor on canvas).
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(lx, ly + 1.5);
    ctx.lineTo(lx + lw, ly + 1.5);
    ctx.stroke();
    ctx.restore();
    buttons.push({
      x: lx - 6, y: lTop, w: lw + 12, h: (ly + 4) - lTop,
      onClick: () => window.open(REPO_URL, '_blank', 'noopener,noreferrer'),
    });
  }

  if (settingsOpen) drawSettingsOverlay();
}

// Brand title: animated gem-tone gradient with pulsing glow.
// Pure decorative — no hit rect, no interaction.
function drawBrandTitle(text, cx, y, fontPx) {
  const ctx = render.ctxRef();
  const t = clockMs() / 1000;
  ctx.save();
  ctx.font = `900 ${fontPx}px -apple-system, system-ui, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';

  const textW = ctx.measureText(text).width;

  // Pulsing outer glow (warm halo behind the glyphs).
  const pulse = 0.5 + 0.5 * Math.sin(t * 1.4);
  ctx.shadowColor = `rgba(180, 110, 255, ${0.55 + pulse * 0.30})`;
  ctx.shadowBlur = 22 + pulse * 12;
  ctx.shadowOffsetY = 2;

  // Gem-tone gradient that drifts horizontally for a slow shimmer.
  const pan = Math.sin(t * 0.5) * (textW * 0.4);
  const grad = ctx.createLinearGradient(cx - textW + pan, 0, cx + textW + pan, 0);
  grad.addColorStop(0.00, '#ff9ec0'); // pink
  grad.addColorStop(0.25, '#d59bff'); // light purple
  grad.addColorStop(0.50, '#8fd1ff'); // sky blue
  grad.addColorStop(0.75, '#d59bff');
  grad.addColorStop(1.00, '#ff9ec0');
  ctx.fillStyle = grad;
  ctx.fillText(text, cx, y);

  // Second pass without the glow keeps the glyph edges crisp.
  ctx.shadowBlur = 0;
  ctx.shadowOffsetY = 0;
  ctx.fillText(text, cx, y);

  // Thin highlight stroke for extra polish.
  ctx.strokeStyle = 'rgba(255,255,255,0.35)';
  ctx.lineWidth = 1;
  ctx.strokeText(text, cx, y);

  ctx.restore();
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
  const panelH = Math.min(560, h - 24);
  const px = (w - panelW) / 2;
  const py = (h - panelH) / 2;
  render.roundRect(ctx, px, py, panelW, panelH, 16);
  ctx.fillStyle = '#1a1530';
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.1)';
  ctx.stroke();

  render.drawText(i18n.t('settings.title'), px + panelW / 2, py + 18, {
    font: 'bold 22px -apple-system, system-ui, sans-serif',
    align: 'center',
  });

  const settings = storage.getSettings();
  let ty = py + 54;
  const rowH = 40;

  drawToggle(px + 20, ty, panelW - 40, i18n.t('settings.haptic'), settings.haptic, () => {
    storage.saveKey('settings', { haptic: !settings.haptic });
  }); ty += rowH;

  drawToggle(px + 20, ty, panelW - 40, i18n.t('settings.sound'), settings.sound !== false, () => {
    const next = !(settings.sound !== false);
    storage.saveKey('settings', { sound: next });
    sound.setEnabled(next);
  }); ty += rowH;

  drawToggle(px + 20, ty, panelW - 40, i18n.t('settings.paintingMode'), settings.paintingMode, () => {
    storage.saveKey('settings', { paintingMode: !settings.paintingMode });
  }); ty += rowH;

  // Language segmented control: label on left, three pills on right.
  drawLanguageRow(px + 20, ty, panelW - 40);
  ty += rowH + 8;

  // Gem style — 'Colors' vs colorblind-friendly 'Shapes'.
  drawGemStyleRow(px + 20, ty, panelW - 40, settings);
  ty += rowH + 8;

  // Gempedia (specials/power-ups reference) + Zen painting gallery.
  {
    const half = (panelW - 40 - 10) / 2;
    drawHitButton(px + 20, ty, half, 36, i18n.t('settings.gempedia'), () => {
      settingsOpen = false;
      setScene('gempedia');
    }, { kind: 'settings' });
    drawHitButton(px + 20 + half + 10, ty, half, 36, i18n.t('zen.gallery'), () => {
      settingsOpen = false;
      setScene('gallery');
    }, { kind: 'settings' });
    ty += 46;
  }

  // Save transfer: export copies a portable code, import pastes one.
  {
    const half = (panelW - 40 - 10) / 2;
    drawHitButton(px + 20, ty, half, 36, i18n.t('settings.exportSave'),
      exportSave, { kind: 'settings' });
    drawHitButton(px + 20 + half + 10, ty, half, 36, i18n.t('settings.importSave'),
      () => { showImportEntry(); }, { kind: 'settings' });
    ty += 46;
  }

  // Reset progress
  drawHitButton(px + 20, ty, panelW - 40, 36, i18n.t('settings.resetProgress'), async () => {
    if (await dialogs.confirm(i18n.t('settings.resetConfirm'))) {
      storage.reset();
      i18n.init();
      needsNameEntry = true;
      settingsOpen = false;
      showNameEntry();
    }
  }, { kind: 'settings' });

  // Close button
  drawHitButton(px + panelW / 2 - 60, py + panelH - 46, 120, 34, i18n.t('settings.close'), () => {
    settingsOpen = false;
  }, { kind: 'settings' });
}

async function exportSave() {
  const code = storage.exportString();
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(code);
      await dialogs.alert(i18n.t('settings.exportCopied'));
      return;
    }
  } catch { /* clipboard denied — fall through to the manual modal */ }
  // No clipboard access: show the code in a copyable input.
  showImportEntry(code);
}

// Two-pill segmented control mirroring drawLanguageRow, for the gem style.
function drawGemStyleRow(x, y, w, settings) {
  render.drawText(i18n.t('settings.gemStyle'), x, y + 10, {
    font: '15px -apple-system, system-ui, sans-serif',
  });
  const labelW = 90;
  const pillsX = x + labelW;
  const pillsW = w - labelW;
  const ctx = render.ctxRef();
  const active = settings.gemStyle === 'shapes' ? 'shapes' : 'color';
  const options = [
    { key: 'color',  label: i18n.t('settings.gemStyleColor') },
    { key: 'shapes', label: i18n.t('settings.gemStyleShapes') },
  ];
  const pillW = (pillsW - 6) / options.length;
  const pillH = 30;
  const py = y + 6;
  for (let i = 0; i < options.length; i++) {
    const opt = options[i];
    const pillX = pillsX + i * (pillW + 6);
    ctx.save();
    render.roundRect(ctx, pillX, py, pillW, pillH, 8);
    ctx.fillStyle = active === opt.key ? '#7c3aed' : 'rgba(255,255,255,0.10)';
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = '13px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(opt.label, pillX + pillW / 2, py + pillH / 2);
    ctx.restore();
    buttons.push({
      x: pillX, y: py, w: pillW, h: pillH, kind: 'settings',
      onClick: () => {
        storage.saveKey('settings', { gemStyle: opt.key });
        render.setGemStyle(opt.key);
      },
    });
  }
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
  if (nameInputWrap || importInputWrap) return; // DOM modals block the canvas
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

// === Save-code import / manual-export modal (second DOM input, mirrors the
// name entry — canvas dialogs can't host a paste-able text field) ===
let importInputWrap = null;

function showImportEntry(prefill = '') {
  if (importInputWrap) return;
  importInputWrap = document.createElement('div');
  importInputWrap.id = 'import-input-wrap';
  const card = document.createElement('div');
  const label = document.createElement('label');
  label.setAttribute('for', 'import-input');
  label.textContent = prefill ? i18n.t('settings.exportManual') : i18n.t('settings.importLabel');
  const input = document.createElement('input');
  input.id = 'import-input';
  input.type = 'text';
  input.autocomplete = 'off';
  if (prefill) { input.value = prefill; input.readOnly = true; }
  const ok = document.createElement('button');
  ok.textContent = prefill ? i18n.t('common.close') : i18n.t('settings.importApply');
  const cancel = document.createElement('button');
  cancel.textContent = i18n.t('common.cancel');
  card.appendChild(label);
  card.appendChild(input);
  card.appendChild(ok);
  if (!prefill) card.appendChild(cancel);
  importInputWrap.appendChild(card);
  document.body.appendChild(importInputWrap);
  setTimeout(() => { input.focus(); if (prefill) input.select(); }, 50);
  cancel.addEventListener('click', hideImportEntry);
  ok.addEventListener('click', async () => {
    if (prefill) { hideImportEntry(); return; }
    const res = storage.importString(input.value);
    hideImportEntry();
    if (res.ok) {
      // Re-derive everything the imported blob controls.
      i18n.init();
      sound.setEnabled(storage.getSettings().sound !== false);
      render.setGemStyle(storage.getSettings().gemStyle);
      needsNameEntry = !storage.getProfile().playerName;
      settingsOpen = false;
      if (needsNameEntry) showNameEntry();
      await dialogs.alert(i18n.t('settings.importDone'));
    } else {
      await dialogs.alert(i18n.t('settings.importBad'));
    }
  });
}

function hideImportEntry() {
  if (importInputWrap && importInputWrap.parentNode) importInputWrap.parentNode.removeChild(importInputWrap);
  importInputWrap = null;
}
