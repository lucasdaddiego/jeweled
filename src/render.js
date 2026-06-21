// Render: sprite atlas + drawBoard + drawHUD + screen shake transform.

import { GRID, SPECIAL, DEFAULT_EMOJI } from './config.js';
import * as particles from './particles.js';
import * as floaters from './floaters.js';
import * as waves from './waves.js';
import * as painting from './painting.js';
import * as bolts from './bolts.js';
import * as input from './input.js';
import { counters, enabled as _dbgEnabled } from './debugHud.js';
import { clockMs } from './main.js';

// Honor the user's reduced-motion preference, LIVE — drawBoard reads
// `reducedMotion` each frame and a MediaQueryList listener keeps it current, so
// toggling the OS accessibility setting takes effect without a reload (for an
// a11y toggle, "gradual until reload" effectively means never).
let reducedMotion = typeof window !== 'undefined' && window.matchMedia
  ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
  : false;
if (typeof window !== 'undefined' && window.matchMedia) {
  const _rmQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  const _onReducedMotion = (e) => { reducedMotion = e.matches; };
  // addEventListener is the modern API; older Safari only has addListener.
  if (_rmQuery.addEventListener) _rmQuery.addEventListener('change', _onReducedMotion);
  else if (_rmQuery.addListener) _rmQuery.addListener(_onReducedMotion);
}

// Module-level state, populated by setupCanvas + buildAtlas
let canvas = null;
let ctx = null;
let DPR = 1;
let viewportW = 0;
let viewportH = 0;
let atlas = null;            // OffscreenCanvas
let atlasCellPx = 0;          // size of one slot in atlas (DPR-scaled)
let bgLayer = null;           // OffscreenCanvas with the cached board background (grid lines + frame)
let bgLayerKey = '';          // signature of the layout we baked the bg for
let vignetteLayer = null;     // cached vignette gradient (full viewport)
let vignetteKey = '';
let resizeRaf = 0;
// Pre-baked overlays for special gems, keyed by string. Entries are
// OffscreenCanvases drawn back via a single drawImage per cell per frame,
// replacing per-frame gradient/text composition. Invalidated on resize.
const badgeCache = new Map();      // `${emoji}|${ringColor}|${cellSize}|${DPR}|${hasFluent}`
const colorBombCache = new Map();  // `${cellSize}|${DPR}`
const timeBombCache = new Map();   // `${color}|${cellSize}|${DPR}` — badge background, sans number
const lineHCache = new Map();      // `${cellSize}|${DPR}` — horizontal line + arrowheads
const lineVCache = new Map();      // `${cellSize}|${DPR}` — vertical line + arrowheads
const gravityCache = new Map();    // `${cellSize}|${DPR}` — ⇅ glyph + outline
// Cache of ellipsize() results so buttons / HUD labels don't re-run
// measureText every frame on stable text. Keyed by `${ctx.font}|${maxW}|${value}`.
// Cleared on resize (font sizes scale with cellSize) and soft-capped at 256.
const ellipsizeCache = new Map();
// Composed font strings, interned by (weight, sizePx, family). Avoids the
// per-call template-literal allocation in drawButton / TIME_BOMB number text.
const _fontCache = new Map();
function fontString(sizePx, family = '-apple-system, system-ui, sans-serif', weight = '') {
  const key = weight + '|' + sizePx + '|' + family;
  let s = _fontCache.get(key);
  if (s) return s;
  s = (weight ? weight + ' ' : '') + sizePx + 'px ' + family;
  _fontCache.set(key, s);
  return s;
}

// Layout (recomputed on resize). All values in CSS px.
export const layout = {
  cellSize: 64,
  boardSize: 64 * 8,
  boardX: 0,
  boardY: 0,
  hudH: 80,           // height of the reserved HUD strip above the board
  hudY: 16,           // y of the HUD content start
  hudRowH: 28,        // vertical spacing of HUD rows
  safeTop: 0,         // env(safe-area-inset-top) — non-zero on PWA / standalone
  isNarrow: false,    // viewport < 480px width
  panelSize: 0,       // requested power-up panel thickness; 0 = no panel
  panelSide: 'right', // 'right' on wide viewports, 'bottom' when narrow
  panelW: 0,          // reserved column on right (set when panelSide === 'right')
  panelH: 0,          // reserved strip at bottom (set when panelSide === 'bottom')
  panelX: 0,          // left edge of right-side panel
  panelY: 0,          // top edge of bottom panel
};

// Gem color palette for particles (mapped 1:1 to types 0..6)
export const GEM_COLORS = ['#e94560', '#5468ff', '#5fd068', '#ffd166', '#b14aed', '#dddddd', '#444444'];

// Per-color particle palettes — base + lighter + darker shade so bursts have texture.
export const GEM_PARTICLE_PALETTES = GEM_COLORS.map(hex => [
  hex,
  shadeHex(hex,  0.30),
  shadeHex(hex, -0.30),
]);

function shadeHex(hex, amount) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = clamp255(parseInt(h.slice(0, 2), 16) + amount * 255);
  const g = clamp255(parseInt(h.slice(2, 4), 16) + amount * 255);
  const b = clamp255(parseInt(h.slice(4, 6), 16) + amount * 255);
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}
function clamp255(v) { return Math.max(0, Math.min(255, Math.round(v))); }

export function setupCanvas() {
  canvas = document.getElementById('game');
  ctx = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', scheduleResize);
  // iOS URL-bar collapse/expand and device rotation change the visible viewport
  // without always firing window 'resize' — but the CSS 100dvh canvas box
  // follows them, so layout.* (used by screenToCell hit-testing) and the canvas
  // pixel dims would go stale, mis-scaling the board and shifting touch targets.
  window.addEventListener('orientationchange', scheduleResize);
  if (window.visualViewport) window.visualViewport.addEventListener('resize', scheduleResize);
}

function scheduleResize() {
  if (resizeRaf) return;
  resizeRaf = requestAnimationFrame(() => {
    resizeRaf = 0;
    resize();
    buildAtlas();
  });
}

export function resize() {
  if (!canvas) return;
  DPR = Math.max(1, window.devicePixelRatio || 1);
  // Clamp to at least 1 — viewport occasionally reports 0 during boot on some
  // browsers / preview environments. resize() will be called again on the
  // first real layout event so the proper values land then.
  viewportW = Math.max(1, window.innerWidth);
  viewportH = Math.max(1, window.innerHeight);
  canvas.width = Math.ceil(viewportW * DPR);
  canvas.height = Math.ceil(viewportH * DPR);
  canvas.style.width = viewportW + 'px';
  canvas.style.height = viewportH + 'px';
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  layout.isNarrow = viewportW < 480;
  // Read the top safe-area inset. In iOS Safari with the URL bar visible
  // this is 0 (URL bar provides padding); in standalone / PWA mode it's the
  // status bar height. Either way, we add it to the HUD top so content stays
  // clear of the system UI.
  const safeTop = parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue('--sat'),
  ) || 0;
  layout.safeTop = safeTop;
  // Reserve a fixed HUD strip at the top; board sits in the remaining area.
  // Two HUD rows (e.g. Classic level + progress bar) need the room; tighter
  // on tiny screens. Base padding bumped from 14→22 so HUD content has
  // breathing room from the iOS URL bar even when the safe inset is 0.
  layout.hudY = 22 + safeTop;
  layout.hudH = (layout.isNarrow ? 80 : 96) + safeTop;
  layout.hudRowH = 28;

  // Pick panel orientation: narrow phones get the power-ups in a horizontal
  // strip below the board so vertical real estate (which is plentiful) absorbs
  // the panel instead of squeezing the board horizontally. Wide viewports keep
  // the right-side column.
  if (layout.panelSize > 0) {
    if (layout.isNarrow) {
      layout.panelSide = 'bottom';
      layout.panelW = 0;
      layout.panelH = layout.panelSize;
    } else {
      layout.panelSide = 'right';
      layout.panelW = layout.panelSize;
      layout.panelH = 0;
    }
  } else {
    layout.panelSide = 'right';
    layout.panelW = 0;
    layout.panelH = 0;
  }

  // Cell size is sized to fit board + panel together, leaving 20px bottom
  // breathing room and a small gap between the board and a right-side panel
  // so the two feel like one cohesive unit.
  const panelGap = layout.panelSide === 'right' && layout.panelW > 0 ? 10 : 0;
  const availW = Math.max(1, viewportW - layout.panelW - panelGap);
  const availH = Math.max(1, viewportH - layout.hudH - 20 - layout.panelH);
  const minDim = Math.max(1, Math.min(availW - 16, availH));
  layout.cellSize = Math.max(1, Math.floor((minDim * 0.98) / GRID));
  layout.boardSize = layout.cellSize * GRID;
  // Center the (board + gap + right-panel) unit horizontally so the panel
  // sits adjacent to the board instead of being pushed to the viewport edge.
  const unitW = layout.boardSize + panelGap + layout.panelW;
  layout.boardX = Math.floor((viewportW - unitW) / 2);
  layout.boardY = layout.hudH + Math.floor((availH - layout.boardSize) / 2);
  layout.panelX = layout.boardX + layout.boardSize + panelGap;
  layout.panelY = layout.boardY + layout.boardSize + 10;

  // Invalidate cached layers — they're sized to the old layout.
  bgLayer = null;
  bgLayerKey = '';
  vignetteLayer = null;
  vignetteKey = '';
  badgeCache.clear();
  colorBombCache.clear();
  timeBombCache.clear();
  lineHCache.clear();
  lineVCache.clear();
  gravityCache.clear();
  ellipsizeCache.clear();
}

// Scenes that want a power-up panel call this on enter (and 0 on exit). The
// thickness is interpreted as width on wide viewports and as height on narrow
// ones — resize() decides orientation based on isNarrow.
export function setPanelWidth(px) {
  layout.panelSize = px;
  resize();
  buildAtlas();
}

// Microsoft Fluent Color emoji loader.
//
// The Fluent SVGs drawn by the app are bundled locally under icons/emoji/ so
// the app has no runtime CDN dependency, works offline once the service worker
// has cached them, and only ships the glyphs we actually use (~68KB total).
//
// Fluent's filenames are NAME-based, not codepoint-based, so we keep a
// mapping for every emoji the game uses. Anything missing from the map falls
// back to OS-emoji text rendering.
const fluentCache = new Map();   // emoji string → HTMLImageElement (loaded)
const fluentInflight = new Map(); // emoji string → Promise<HTMLImageElement>
const fluentFailed = new Set();   // emoji string → load failed; keep OS fallback

// Emoji → Fluent name (folder + filename stem). Covers the seven squared gems
// plus the bundled special-overlay emojis used by drawSpecialOverlay. Special
// badges without a local asset (for example Coin) fall back to OS emoji text.
const FLUENT_NAME = {
  '🟥': 'Red square', '🟦': 'Blue square', '🟩': 'Green square',
  '🟨': 'Yellow square', '🟪': 'Purple square',
  '⬜': 'White large square', '⬛': 'Black large square',
  // Special overlays (used by drawSpecialOverlay → drawEmojiBadge)
  '💥': 'Collision', '🔥': 'Fire', '⚡': 'High voltage',
  '⭐': 'Star', '🃏': 'Joker',
};

function fluentUrl(name) {
  const file = name.toLowerCase().replace(/ /g, '_') + '_color.svg';
  return `icons/emoji/${file}`;
}

function loadFluent(emoji) {
  if (fluentCache.has(emoji)) return Promise.resolve(fluentCache.get(emoji));
  if (fluentInflight.has(emoji)) return fluentInflight.get(emoji);
  if (fluentFailed.has(emoji)) return Promise.reject(new Error(`Fluent load previously failed for ${emoji}`));
  const name = FLUENT_NAME[emoji];
  if (!name) return Promise.reject(new Error(`no Fluent mapping for ${emoji}`));
  const p = new Promise((resolve, reject) => {
    const img = new Image();
    // No crossOrigin — assets are same-origin under icons/emoji/.
    img.onload = () => { fluentCache.set(emoji, img); fluentInflight.delete(emoji); resolve(img); };
    img.onerror = (e) => { fluentInflight.delete(emoji); fluentFailed.add(emoji); reject(e); };
    img.src = fluentUrl(name);
  });
  fluentInflight.set(emoji, p);
  return p;
}

// Draw a single OS-emoji fallback into the atlas slot at (slotIndex). Used
// while Fluent SVGs are still loading and as a last resort if a fetch fails.
function drawEmojiFallback(actx, slotPx, slotIndex, emoji) {
  actx.save();
  actx.font = `${Math.floor(slotPx * 0.78)}px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif`;
  actx.textAlign = 'center';
  actx.textBaseline = 'middle';
  actx.fillText(emoji, slotIndex * slotPx + slotPx / 2, slotPx / 2 + slotPx * 0.04);
  actx.restore();
}

export function buildAtlas() {
  // Guard against being called before resize() has run with a real viewport
  // (e.g. preview tab momentarily reporting 0×0). Skip; window 'resize' will
  // trigger another buildAtlas call once dimensions are known.
  if (layout.cellSize <= 0 || !DPR || DPR <= 0) return;
  const slotPx = Math.max(1, Math.ceil(layout.cellSize * DPR));
  atlasCellPx = slotPx;
  const w = slotPx * DEFAULT_EMOJI.length;
  const h = slotPx;
  atlas = new OffscreenCanvas(w, h);
  const actx = atlas.getContext('2d');
  actx.clearRect(0, 0, w, h);

  // Capture identity so an async load that resolves after a later resize
  // doesn't draw stale glyphs onto a stale atlas.
  const atlasAtBuild = atlas;

  for (let i = 0; i < DEFAULT_EMOJI.length; i++) {
    const emoji = DEFAULT_EMOJI[i];
    const cached = fluentCache.get(emoji);
    if (cached) {
      drawFluentIntoSlot(actx, slotPx, i, cached);
    } else {
      // Show OS emoji immediately so the first frame isn't blank, then upgrade
      // to Fluent once the SVG arrives.
      drawEmojiFallback(actx, slotPx, i, emoji);
      loadFluent(emoji).then(img => {
        if (atlas !== atlasAtBuild) return;
        // Clear the slot first so the fallback emoji doesn't bleed through
        // the SVG's transparent edges.
        actx.clearRect(i * slotPx, 0, slotPx, slotPx);
        drawFluentIntoSlot(actx, slotPx, i, img);
      }).catch(err => {
        // Fluent unavailable for this emoji or network blocked — keep
        // the OS fallback. Log so we can spot missing mappings.
        console.warn(`Fluent load failed for "${emoji}":`, err?.message || err);
      });
    }
  }

  // Warm the locally-bundled special badge glyphs too. They are not part of
  // the board atlas, but drawEmojiBadge can draw them directly once loaded.
  for (const emoji of ['💥', '🔥', '⚡', '⭐', '🃏']) {
    if (!fluentCache.has(emoji) && !fluentInflight.has(emoji) && !fluentFailed.has(emoji)) {
      loadFluent(emoji).catch(err => {
        console.warn(`Fluent load failed for "${emoji}":`, err?.message || err);
      });
    }
  }
}

function drawFluentIntoSlot(actx, slotPx, slotIndex, img) {
  // Fluent SVGs include a bit of natural padding around the glyph, so a
  // 0.95× draw size makes the rendered shape match the visible footprint
  // of a system Large Circle emoji at this resolution.
  const drawSize = slotPx * 0.95;
  const offset = (slotPx - drawSize) / 2;
  actx.drawImage(img, slotIndex * slotPx + offset, offset, drawSize, drawSize);
}

export function getCellSize() { return layout.cellSize; }

export function clearFrame() {
  ctx.clearRect(0, 0, viewportW, viewportH);
}

export function ctxRef() { return ctx; }

// === Coordinate helpers ===
export function screenToCell(x, y) {
  const cs = layout.cellSize;
  const c = Math.floor((x - layout.boardX) / cs);
  const r = Math.floor((y - layout.boardY) / cs);
  if (r < 0 || r >= GRID || c < 0 || c >= GRID) return null;
  return { r, c };
}

// === Board drawing ===
// Cache the static board background (frame + grid lines) in an OffscreenCanvas.
// We rebake when layout changes (resize) — that's it.
function ensureBgLayer() {
  const key = `${layout.boardX}:${layout.boardY}:${layout.cellSize}:${DPR}`;
  if (bgLayer && bgLayerKey === key) return;
  const pad = 8;
  const w = (layout.boardSize + pad * 2) * DPR;
  const h = (layout.boardSize + pad * 2) * DPR;
  bgLayer = new OffscreenCanvas(w, h);
  const bctx = bgLayer.getContext('2d');
  bctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  bctx.fillStyle = 'rgba(255,255,255,0.04)';
  bctx.fillRect(0, 0, layout.boardSize + pad * 2, layout.boardSize + pad * 2);
  bctx.strokeStyle = 'rgba(255,255,255,0.06)';
  bctx.lineWidth = 1;
  bctx.beginPath();
  for (let i = 0; i <= GRID; i++) {
    bctx.moveTo(pad + i * layout.cellSize, pad);
    bctx.lineTo(pad + i * layout.cellSize, pad + layout.boardSize);
    bctx.moveTo(pad,                       pad + i * layout.cellSize);
    bctx.lineTo(pad + layout.boardSize,    pad + i * layout.cellSize);
  }
  bctx.stroke();
  bgLayerKey = key;
}

export function drawBoardBg() {
  ensureBgLayer();
  const pad = 8;
  // Blit the cached bg (DPR-scaled source → CSS-coord destination)
  ctx.drawImage(
    bgLayer,
    0, 0, bgLayer.width, bgLayer.height,
    layout.boardX - pad, layout.boardY - pad,
    layout.boardSize + pad * 2, layout.boardSize + pad * 2,
  );
}

// Apply screen shake + draw board layer (painting -> gems -> overlays -> eyes -> particles -> floaters)
export function drawBoard(grid, opts = {}) {
  if (_dbgEnabled) counters.drawBoard++;
  const shakeAmp = reducedMotion ? 0 : (opts.shakeAmp || 0);
  const settings = opts.settings || {};
  const hint = opts.hint || null;
  // Idle wobble — after 5s of inactivity the board gently sways like it's
  // breathing. ±2deg max, slow sinusoid. Disabled under reduced-motion.
  const idleMs = reducedMotion ? 0 : (opts.idleMs || 0);
  const wobbleK = idleMs > 5000 ? Math.min(1, (idleMs - 5000) / 1500) : 0;
  const wobbleAngle = wobbleK * 0.02 * Math.sin(clockMs() / 1200);  // ~1.15° max

  ctx.save();
  if (shakeAmp > 0.1) {
    ctx.translate((Math.random() - 0.5) * shakeAmp, (Math.random() - 0.5) * shakeAmp);
  }
  if (wobbleAngle !== 0) {
    const cx = layout.boardX + layout.boardSize / 2;
    const cy = layout.boardY + layout.boardSize / 2;
    ctx.translate(cx, cy);
    ctx.rotate(wobbleAngle);
    ctx.translate(-cx, -cy);
  }

  drawBoardBg();

  // Painting layer under gems
  if (painting.isEnabled()) {
    painting.drawInto(ctx, layout.boardX, layout.boardY, layout.boardSize, layout.boardSize, 0.5);
  }

  const cs = layout.cellSize;

  // Gems
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const cell = grid[r][c];
      if (!cell) continue;
      const rr = cell.renderRow != null ? cell.renderRow : r;
      const cc = cell.renderCol != null ? cell.renderCol : c;
      const x = layout.boardX + cc * cs;
      const y = layout.boardY + rr * cs;
      const alpha = cell.clearAlpha != null ? cell.clearAlpha : 1;
      if (alpha < 0.02) continue;

      // Hint highlight (no `selected` codepath today — drag input lifts the
      // dragged gem via scaleX/scaleY instead of a board-level selection).
      if (hint && ((hint.a.r === r && hint.a.c === c) || (hint.b.r === r && hint.b.c === c))) {
        // Soft expanding glow ring around the two hinted gems plus a gentle
        // body pulse so the hint reads as "look here" without being shouty.
        const pulse = 0.5 + 0.5 * Math.sin(clockMs() / 500);
        ctx.fillStyle = `rgba(255,255,255,${0.06 + pulse * 0.08})`;
        ctx.fillRect(x, y, cs, cs);
        ctx.save();
        ctx.strokeStyle = `rgba(255, 235, 150, ${0.20 + pulse * 0.35})`;
        ctx.lineWidth = Math.max(1.5, cs * 0.04);
        const grow = cs * 0.06 * pulse;     // ring breathes outward 0..6% of cs
        ctx.strokeRect(x - grow, y - grow, cs + grow * 2, cs + grow * 2);
        ctx.restore();
      }

      ctx.globalAlpha = alpha;
      drawGemWithEffects(ctx, cell, x, y, cs);
      ctx.globalAlpha = 1;
    }
  }

  // Waves + bolts + particles + floaters drawn in board space.
  // Order: waves (background ring), bolts (lightning/star streaks above),
  // particles (gem-color sparks), floaters (combo + score text) — each layer
  // sits above the previous so the most-informative info reads on top.
  waves.draw(ctx);
  bolts.draw(ctx);
  particles.draw(ctx);
  floaters.draw(ctx);

  ctx.restore();

  // Edge vignette — drawn LAST so it sits over everything (subtle frame).
  drawVignette();
}

function drawVignette() {
  if (!ctx) return;
  const w = viewportW, h = viewportH;
  const vignetteDpr = Math.min(DPR, 2);
  const key = `${w}x${h}x${vignetteDpr}`;
  if (!vignetteLayer || vignetteKey !== key) {
    // Bake the vignette once per layout. createRadialGradient is one of the
    // more expensive 2D-context ops; doing it every frame at 60Hz is wasteful.
    vignetteLayer = new OffscreenCanvas(Math.max(1, Math.ceil(w * vignetteDpr)), Math.max(1, Math.ceil(h * vignetteDpr)));
    const vctx = vignetteLayer.getContext('2d');
    vctx.setTransform(vignetteDpr, 0, 0, vignetteDpr, 0, 0);
    const g = vctx.createRadialGradient(
      w / 2, h / 2, Math.min(w, h) * 0.35,
      w / 2, h / 2, Math.max(w, h) * 0.75,
    );
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, 'rgba(0,0,0,0.45)');
    vctx.fillStyle = g;
    vctx.fillRect(0, 0, w, h);
    vignetteKey = key;
  }
  ctx.drawImage(vignetteLayer, 0, 0, vignetteLayer.width, vignetteLayer.height, 0, 0, w, h);
}

function drawGemAt(ctx, type, x, y, size) {
  if (!atlas) return;
  ctx.drawImage(
    atlas,
    type * atlasCellPx, 0, atlasCellPx, atlasCellPx,
    x, y, size, size,
  );
}

// Compose squash transform, gem, special overlay, and pre-clear flash.
function drawGemWithEffects(ctx, cell, x, y, size) {
  const sx = cell.scaleX != null ? cell.scaleX : 1;
  const sy = cell.scaleY != null ? cell.scaleY : 1;
  const flash = cell.flashAlpha;

  // Gem with optional squash transform.
  if (sx !== 1 || sy !== 1) {
    const cx = x + size * 0.5, cy = y + size * 0.55;
    ctx.save();
    ctx.translate(cx, cy); ctx.scale(sx, sy); ctx.translate(-cx, -cy);
    drawGemAt(ctx, cell.type, x, y, size);
    drawSpecialOverlay(ctx, cell, x, y, size);
    if (flash != null && flash > 0) drawFlash(ctx, x, y, size, flash);
    ctx.restore();
  } else {
    drawGemAt(ctx, cell.type, x, y, size);
    drawSpecialOverlay(ctx, cell, x, y, size);
    if (flash != null && flash > 0) drawFlash(ctx, x, y, size, flash);
  }
}

// White-overlay flash that fades off in ~90ms before a gem clears, so the
// eye locks onto matched gems before they disappear.
function drawFlash(ctx, x, y, size, alpha) {
  ctx.fillStyle = `rgba(255, 255, 255, ${alpha * 0.55})`;
  ctx.fillRect(x, y, size, size);
}

function drawSpecialOverlay(ctx, cell, x, y, size) {
  if (!cell.special) return;
  ctx.save();
  switch (cell.special) {
    case SPECIAL.LINE_H: {
      ctx.drawImage(ensureLineHLayer(size), x, y, size, size);
      break;
    }
    case SPECIAL.LINE_V: {
      ctx.drawImage(ensureLineVLayer(size), x, y, size, size);
      break;
    }
    case SPECIAL.COLOR_BOMB: {
      ctx.drawImage(ensureColorBombLayer(size), x, y, size, size);
      break;
    }
    case SPECIAL.AREA_BOMB: {
      drawEmojiBadge(ctx, x, y, size, '💥', '#ff8a3d');
      break;
    }
    case SPECIAL.GRAVITY: {
      ctx.drawImage(ensureGravityLayer(size), x, y, size, size);
      break;
    }
    case SPECIAL.TIME_BOMB: {
      if (cell.bombCountdown != null) {
        const color = cell.bombCountdown <= 3 ? '#ff4444' : '#ffaa33';
        const side = size * 0.36;
        const bx = x + size * 0.80;
        const by = y + size * 0.20;
        // Pre-baked rounded-square + stroke (no number); number drawn live so
        // the per-tick countdown change doesn't need a fresh bake.
        ctx.drawImage(ensureTimeBombBadge(color, size), bx - side / 2, by - side / 2, side, side);
        ctx.fillStyle = '#fff';
        ctx.font = fontString(Math.floor(side * 0.65), 'sans-serif', 'bold');
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(cell.bombCountdown), bx, by + 1);
      }
      break;
    }
    case SPECIAL.WILDCARD:  drawEmojiBadge(ctx, x, y, size, '🃏', '#7c3aed'); break;
    case SPECIAL.COIN:      drawEmojiBadge(ctx, x, y, size, '🪙', '#ffd166'); break;
    case SPECIAL.FIRE:      drawEmojiBadge(ctx, x, y, size, '🔥', '#ff5722'); break;
    case SPECIAL.LIGHTNING: drawEmojiBadge(ctx, x, y, size, '⚡', '#ffeb3b'); break;
    case SPECIAL.STAR:      drawEmojiBadge(ctx, x, y, size, '⭐', '#ffd700'); break;
  }
  ctx.restore();
}

// Small rounded-square emoji badge in the top-right corner of a gem.
// Backed by an OffscreenCanvas cache so the rounded rect + stroke + glyph are
// composed once per (emoji, ringColor, cellSize) and then blitted with a
// single drawImage. The cache key includes a `hasFluent` flag so the badge is
// re-baked once the async Fluent SVG load resolves, upgrading from OS-emoji
// to Fluent glyph without per-frame work.
//
// globalAlpha is honored automatically: drawImage respects the destination
// context's globalAlpha, so a fading cell's clear-alpha carries through to
// the badge with no extra plumbing.
function drawEmojiBadge(ctx, x, y, size, emoji, ringColor) {
  // Kick off Fluent load if it's available but not yet cached.
  if (!fluentCache.has(emoji) && FLUENT_NAME[emoji] && !fluentInflight.has(emoji) && !fluentFailed.has(emoji)) {
    loadFluent(emoji).catch(err => {
      console.warn(`Fluent load failed for "${emoji}":`, err?.message || err);
    });
  }
  const side = size * 0.44;
  const bx = x + size * 0.78 - side / 2;
  const by = y + size * 0.22 - side / 2;
  ctx.drawImage(ensureBadgeLayer(emoji, ringColor, size), bx, by, side, side);
}

function ensureBadgeLayer(emoji, ringColor, cellSize) {
  const hasFluent = fluentCache.has(emoji) ? 1 : 0;
  const key = `${emoji}|${ringColor}|${cellSize}|${DPR}|${hasFluent}`;
  let canvas = badgeCache.get(key);
  if (canvas) return canvas;
  const side = cellSize * 0.44;
  const px = Math.max(8, Math.ceil(side * DPR));
  canvas = new OffscreenCanvas(px, px);
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Filled rounded square so the badge reads against any gem color.
  c.fillStyle = ringColor;
  c.globalAlpha = 0.85;
  const r = side * 0.25;
  roundRect(c, 0, 0, side, side, r);
  c.fill();
  c.globalAlpha = 1;
  c.strokeStyle = 'rgba(0,0,0,0.6)';
  c.lineWidth = 1.5;
  c.stroke();
  // Emoji centered. Prefer Fluent SVG; OS-emoji fallback otherwise.
  const img = fluentCache.get(emoji);
  if (img) {
    const drawSize = side * 0.78;
    c.drawImage(img, side / 2 - drawSize / 2, side / 2 - drawSize / 2, drawSize, drawSize);
  } else {
    c.font = `${Math.floor(side * 0.75)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(emoji, side / 2, side / 2 + 1);
  }
  badgeCache.set(key, canvas);
  return canvas;
}

// Pre-baked COLOR_BOMB layer: square stroke frame + inner radial sparkle.
// One entry per cellSize × DPR.
function ensureColorBombLayer(cellSize) {
  const key = `${cellSize}|${DPR}`;
  let canvas = colorBombCache.get(key);
  if (canvas) return canvas;
  const px = Math.max(8, Math.ceil(cellSize * DPR));
  canvas = new OffscreenCanvas(px, px);
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  // Square frame on the gem face.
  c.strokeStyle = 'rgba(255,255,255,0.95)';
  c.lineWidth = cellSize * 0.05;
  const inset = cellSize * 0.08;
  c.strokeRect(inset, inset, cellSize - inset * 2, cellSize - inset * 2);
  // Inner radial gradient sparkle — reads as a glowing core inside the frame.
  const g = c.createRadialGradient(cellSize * 0.5, cellSize * 0.5, 0,
                                    cellSize * 0.5, cellSize * 0.5, cellSize * 0.5);
  g.addColorStop(0, 'rgba(255,255,255,0.5)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  c.fillStyle = g;
  c.fillRect(0, 0, cellSize, cellSize);
  colorBombCache.set(key, canvas);
  return canvas;
}

// Pre-baked LINE_H overlay: horizontal stripe + arrowheads. One entry per
// cellSize × DPR. Replaces a per-cell-per-frame stroke + 2× arrowhead path.
function ensureLineHLayer(cellSize) {
  const key = `${cellSize}|${DPR}`;
  let canvas = lineHCache.get(key);
  if (canvas) return canvas;
  const px = Math.max(8, Math.ceil(cellSize * DPR));
  canvas = new OffscreenCanvas(px, px);
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = cellSize * 0.06;
  c.beginPath();
  c.moveTo(cellSize * 0.15, cellSize * 0.5);
  c.lineTo(cellSize * 0.85, cellSize * 0.5);
  c.stroke();
  drawArrowHead(c, cellSize * 0.85, cellSize * 0.5, cellSize, 0);
  drawArrowHead(c, cellSize * 0.15, cellSize * 0.5, cellSize, Math.PI);
  lineHCache.set(key, canvas);
  return canvas;
}

function ensureLineVLayer(cellSize) {
  const key = `${cellSize}|${DPR}`;
  let canvas = lineVCache.get(key);
  if (canvas) return canvas;
  const px = Math.max(8, Math.ceil(cellSize * DPR));
  canvas = new OffscreenCanvas(px, px);
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.strokeStyle = 'rgba(255,255,255,0.85)';
  c.lineWidth = cellSize * 0.06;
  c.beginPath();
  c.moveTo(cellSize * 0.5, cellSize * 0.15);
  c.lineTo(cellSize * 0.5, cellSize * 0.85);
  c.stroke();
  drawArrowHead(c, cellSize * 0.5, cellSize * 0.85, cellSize, Math.PI / 2);
  drawArrowHead(c, cellSize * 0.5, cellSize * 0.15, cellSize, -Math.PI / 2);
  lineVCache.set(key, canvas);
  return canvas;
}

// Pre-baked GRAVITY overlay: outlined ⇅ glyph near the bottom of the cell.
function ensureGravityLayer(cellSize) {
  const key = `${cellSize}|${DPR}`;
  let canvas = gravityCache.get(key);
  if (canvas) return canvas;
  const px = Math.max(8, Math.ceil(cellSize * DPR));
  canvas = new OffscreenCanvas(px, px);
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = 'rgba(255,255,255,0.9)';
  c.strokeStyle = 'rgba(0,0,0,0.8)';
  c.lineWidth = 2;
  c.font = `${Math.floor(cellSize * 0.35)}px sans-serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  c.strokeText('⇅', cellSize * 0.5, cellSize * 0.86);
  c.fillText('⇅', cellSize * 0.5, cellSize * 0.86);
  gravityCache.set(key, canvas);
  return canvas;
}

// Pre-baked TIME_BOMB badge background (rounded-square + stroke). The
// countdown number is drawn live on top so per-tick changes don't bust this
// cache — only the two color variants (red/orange) get baked.
function ensureTimeBombBadge(color, cellSize) {
  const key = `${color}|${cellSize}|${DPR}`;
  let canvas = timeBombCache.get(key);
  if (canvas) return canvas;
  const side = cellSize * 0.36;
  const px = Math.max(8, Math.ceil(side * DPR));
  canvas = new OffscreenCanvas(px, px);
  const c = canvas.getContext('2d');
  c.setTransform(DPR, 0, 0, DPR, 0, 0);
  c.fillStyle = color;
  c.strokeStyle = 'rgba(0,0,0,0.9)';
  c.lineWidth = Math.max(1, cellSize * 0.02);
  const r = side * 0.25;
  roundRect(c, 0, 0, side, side, r);
  c.fill();
  c.stroke();
  timeBombCache.set(key, canvas);
  return canvas;
}

function drawArrowHead(ctx, x, y, size, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-size * 0.12, -size * 0.08);
  ctx.lineTo(-size * 0.12, size * 0.08);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fill();
  ctx.restore();
}

// === Generic HUD helpers ===
export function drawText(text, x, y, opts = {}) {
  ctx.save();
  ctx.font = opts.font || '20px -apple-system, system-ui, sans-serif';
  ctx.fillStyle = opts.color || '#f3f0ff';
  ctx.textAlign = opts.align || 'left';
  ctx.textBaseline = opts.baseline || 'top';
  if (opts.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.7)';
    ctx.shadowBlur = 4;
    ctx.shadowOffsetY = 2;
  }
  ctx.fillText(text, x, y);
  ctx.restore();
}

// Convenience: draws a button AND pushes its hit rect onto the scene's buttons[].
// Used by every scene; centralizes the hover detection + push idiom.
export function drawHitButton(x, y, w, h, label, onClick, buttons, cursorX, cursorY, opts = {}) {
  const hover = cursorX >= x && cursorX <= x + w && cursorY >= y && cursorY <= y + h;
  // Pressed = pointer currently held inside the hit rect. Gives every button
  // a tactile shrink so the touch feels physical.
  const pressed = hover && input.isPointerDown();
  drawButton(x, y, w, h, label, { hover, pressed, ...opts });
  buttons.push({ x, y, w, h, onClick, kind: opts.kind, modal: opts.modal });
}

export function drawButton(x, y, w, h, label, opts = {}) {
  const hover = opts.hover || false;
  const pressed = opts.pressed || false;
  const disabled = opts.disabled || false;
  ctx.save();
  // Apply press depress — scale around the button's center by ~3%.
  if (pressed && !disabled) {
    const cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy);
    ctx.scale(0.97, 0.97);
    ctx.translate(-cx, -cy);
  }
  ctx.fillStyle = disabled ? 'rgba(80,80,100,0.4)'
    : pressed ? 'rgba(100, 48, 200, 0.95)'
    : hover ? 'rgba(124, 58, 237, 0.85)'
    : 'rgba(60, 50, 100, 0.85)';
  roundRect(ctx, x, y, w, h, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.fillStyle = disabled ? '#888' : '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  if (opts.subtitle) {
    // Two-line layout: title in the upper third, subtitle in the lower third,
    // with a clear gap so they never visually collide.
    ctx.font = (opts.font || fontString(Math.floor(h * 0.36)));
    fillTextEllipsized(ctx, label, x + w / 2, y + h * 0.36, w - 24);
    ctx.font = fontString(Math.floor(h * 0.20));
    ctx.fillStyle = 'rgba(255,255,255,0.7)';
    fillTextEllipsized(ctx, opts.subtitle, x + w / 2, y + h * 0.72, w - 24);
  } else {
    ctx.font = (opts.font || fontString(Math.floor(h * 0.4)));
    fillTextEllipsized(ctx, label, x + w / 2, y + h / 2, w - 24);
  }
  ctx.restore();
}

export function ellipsize(ctx, text, maxW) {
  const value = String(text ?? '');
  const key = ctx.font + '|' + maxW + '|' + value;
  const cached = ellipsizeCache.get(key);
  if (cached !== undefined) return cached;
  let out;
  if (ctx.measureText(value).width <= maxW) {
    out = value;
  } else {
    const suffix = '…';
    let lo = 0, hi = value.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ctx.measureText(value.slice(0, mid) + suffix).width <= maxW) lo = mid;
      else hi = mid - 1;
    }
    out = value.slice(0, lo) + suffix;
  }
  if (ellipsizeCache.size > 256) ellipsizeCache.clear();
  ellipsizeCache.set(key, out);
  return out;
}

export function fillTextEllipsized(ctx, text, x, y, maxW) {
  ctx.fillText(ellipsize(ctx, text, maxW), x, y);
}

export function roundRect(ctx, x, y, w, h, r) {
  // Clamp the corner radius so it can never exceed half the shortest side —
  // otherwise the quadratic curves overlap and produce a malformed shape
  // (visible on narrow buttons / small slots).
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

export function getViewport() { return { w: viewportW, h: viewportH }; }

// Right edge of the board (handy for HUD right-alignment).
export function boardRight() { return layout.boardX + layout.boardSize; }
// Right edge of the whole play area — board, plus any right-side power-up
// panel. HUD elements that should sit at the rightmost edge of the visible
// game (e.g. an End / Back button) should anchor to this, not boardRight,
// so they stay aligned with the panel instead of floating in the gap.
export function contentRight() {
  return layout.panelSide === 'right' && layout.panelW > 0
    ? layout.panelX + layout.panelW
    : layout.boardX + layout.boardSize;
}
export function boardCenterX() { return layout.boardX + layout.boardSize / 2; }

// Pick a font size by viewport width (clamp for tiny phones).
export function responsiveFont(desktopPx, minPx = 14) {
  if (layout.isNarrow) return Math.max(minPx, Math.floor(desktopPx * 0.78));
  return desktopPx;
}

// Menu scenes (level select, puzzle select, stats) share a centered content
// column so back-buttons, titles, and grids all anchor to the same horizontal
// bounds. Without this, wide viewports leave the back-button floating alone
// in the corner while content sits centered far from it.
export const MENU_COLUMN_MAX_W = 720;
export function menuColumn() {
  const w = Math.min(MENU_COLUMN_MAX_W, viewportW - 32);
  const x = Math.floor((viewportW - w) / 2);
  return { x, w, right: x + w };
}

// Draw a single power-up slot. Returns its hit rect for the caller to register.
// charges: int (0..MAX), progressToNext: 0..1 (drawn as a ring around the icon),
// activeMode: bool (highlights when in target mode for this powerup),
// hover: bool
export function drawPowerupSlot(x, y, w, h, emoji, ring, charges, progressToNext, hover, activeMode) {
  // Background
  ctx.save();
  roundRect(ctx, x, y, w, h, 10);
  ctx.fillStyle = activeMode ? 'rgba(124, 58, 237, 0.95)'
    : hover ? 'rgba(80, 60, 130, 0.9)'
    : charges > 0 ? 'rgba(50, 40, 80, 0.85)' : 'rgba(30, 25, 50, 0.5)';
  ctx.fill();
  ctx.strokeStyle = activeMode ? '#fff' : 'rgba(255,255,255,0.12)';
  ctx.lineWidth = activeMode ? 2 : 1;
  ctx.stroke();

  // Progress ring (around the emoji area)
  const cx = x + w / 2;
  const cy = y + h * 0.40;
  const rr = Math.min(w, h) * 0.30;
  if (progressToNext > 0 && progressToNext < 1) {
    ctx.beginPath();
    ctx.arc(cx, cy, rr + 4, -Math.PI / 2, -Math.PI / 2 + progressToNext * Math.PI * 2);
    ctx.strokeStyle = ring;
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  // Emoji
  ctx.font = `${Math.floor(rr * 1.6)}px "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.globalAlpha = charges > 0 ? 1 : 0.4;
  ctx.fillText(emoji, cx, cy);
  ctx.globalAlpha = 1;

  // Charge dots beneath the icon
  const dotR = 3;
  const dotsY = y + h * 0.78;
  const totalDotsW = 3 * (dotR * 2) + 2 * 4;
  const dotsStartX = cx - totalDotsW / 2 + dotR;
  for (let i = 0; i < 3; i++) {
    ctx.beginPath();
    ctx.arc(dotsStartX + i * (dotR * 2 + 4), dotsY, dotR, 0, Math.PI * 2);
    ctx.fillStyle = i < charges ? ring : 'rgba(255,255,255,0.15)';
    ctx.fill();
  }

  ctx.restore();
  return { x, y, w, h };
}
