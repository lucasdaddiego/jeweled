// Combo text floaters — pooled.

import { FLOATER_POOL, FLOATER_LABELS } from './config.js';
import * as i18n from './i18n.js';

class Floater {
  constructor() {
    this.x = 0; this.y = 0;
    this.x0 = 0; this.y0 = 0;   // spawn position (for fly trajectories)
    this.targetX = null; this.targetY = null;   // optional fly destination
    this.text = '';
    this.life = 0; this.maxLife = 600;
    this.fontSize = 24;
    this.color = '#fff';
    this.alive = false;
    this.kind = 'combo';   // 'combo' | 'score' — different styling
  }
}

const pool = [];
for (let i = 0; i < FLOATER_POOL; i++) pool.push(new Floater());
let aliveCount = 0;

function spawnForCascade(depth, x, y) {
  let text = FLOATER_LABELS[depth];
  let fontSize = 28;
  if (!text) {
    if (depth >= 5) {
      text = `MEGA x${depth}!`;
      fontSize = 32 + Math.min(depth - 5, 8) * 2;
    } else return;
  }
  const f = findDead();
  if (!f) return;
  if (!f.alive) aliveCount++;
  f.x = x; f.y = y;
  f.text = text;
  f.life = f.maxLife = 700;
  f.fontSize = fontSize;
  f.color = depth >= 5 ? '#ffd700' : depth >= 4 ? '#ff88dd' : depth >= 3 ? '#88ddff' : '#ffffff';
  f.kind = 'combo';
  f.alive = true;
}

// One-stop handler for cascade.onMatchCleared.
// Spawns the per-gem particle burst, optional painting brushstrokes, a single
// radial wave + (optionally) a cascade combo floater, all centered on the
// cleared cells. Returns the centroid {x, y} so the scene can position a
// score-popup later when the score-delta arrives.
//
// This function used to be duplicated 3× across gameZen / gameClassic / gameDaily.
export function handleMatchCleared(cells, depth, deps) {
  const { render, particles, palettes, painting, haptic } = deps;
  const cs = render.getCellSize();
  let sumX = 0, sumY = 0;
  for (const { r, c, type } of cells) {
    const x = render.layout.boardX + c * cs + cs / 2;
    const y = render.layout.boardY + r * cs + cs / 2;
    particles.spawnBurst(x, y, palettes[type], 12);
    if (painting && painting.isEnabled()) {
      painting.brushAt(c * cs + cs / 2, r * cs + cs / 2, render.layout.boardSize, palettes[type][0]);
    }
    sumX += x; sumY += y;
  }
  const centerX = sumX / cells.length;
  const centerY = sumY / cells.length;
  const radius = Math.max(60, cs * Math.sqrt(cells.length) * 0.75);
  deps.waves.spawn(centerX, centerY, 'rgba(255,255,255,0.55)', radius, 450);
  if (depth >= 2) spawnForCascade(depth, centerX, centerY - 40);
  if (haptic && navigator.vibrate) navigator.vibrate(15);
  return { x: centerX, y: centerY };
}

// Special-gem activation effects. Dispatches the right visual per special type:
//   COLOR_BOMB → big white shockwave
//   LIGHTNING  → lightning arcs from source to each target
//   FIRE       → expanding orange ring + directional sparks per neighbour
//   STAR       → gold shooting trails from source to each target
// `act` is { r, c, special, targets:[{r,c}] } from cascade.onSpecialActivated.
export function handleSpecialActivated(act, deps) {
  const { render, waves, bolts, particles, palettes, SPECIAL, haptic } = deps;
  const cs = render.getCellSize();
  const fromX = render.layout.boardX + act.c * cs + cs / 2;
  const fromY = render.layout.boardY + act.r * cs + cs / 2;
  const targets = act.targets || [];
  const toScreen = (t) => ({
    x: render.layout.boardX + t.c * cs + cs / 2,
    y: render.layout.boardY + t.r * cs + cs / 2,
  });
  switch (act.special) {
    case SPECIAL.COLOR_BOMB: {
      waves.spawn(fromX, fromY, 'rgba(255,255,255,0.9)', cs * 5, 600);
      waves.spawn(fromX, fromY, 'rgba(180,210,255,0.7)', cs * 3.5, 500);
      break;
    }
    case SPECIAL.LIGHTNING: {
      // One arc per target, staggered slightly via natural firing.
      for (const t of targets) {
        const p = toScreen(t);
        bolts.spawnLightning(fromX, fromY, p.x, p.y);
      }
      break;
    }
    case SPECIAL.FIRE: {
      waves.spawn(fromX, fromY, 'rgba(255,140,40,0.7)', cs * 1.8, 360);
      // Particle sparks toward each neighbour for a "spread" feel.
      for (const t of targets) {
        const p = toScreen(t);
        if (palettes) particles.spawnBurst((fromX + p.x) / 2, (fromY + p.y) / 2,
          ['#ff5722', '#ff8a3d', '#ffd166'], 8);
      }
      break;
    }
    case SPECIAL.STAR: {
      for (const t of targets) {
        const p = toScreen(t);
        bolts.spawnStarTrail(fromX, fromY, p.x, p.y);
      }
      break;
    }
    case SPECIAL.AREA_BOMB: {
      waves.spawn(fromX, fromY, 'rgba(255,138,61,0.85)', cs * 2.6, 420);
      break;
    }
    case SPECIAL.LINE_H:
    case SPECIAL.LINE_V: {
      waves.spawn(fromX, fromY, 'rgba(200,220,255,0.6)', cs * 2, 320);
      break;
    }
  }
  // Double-buzz haptic — distinguishable from the single 15ms buzz that
  // handleMatchCleared fires for normal matches, so the player can feel the
  // "this was a special!" cue without needing to look at the board.
  if (haptic && navigator.vibrate) navigator.vibrate([0, 30, 20, 30]);
}

// Spawn a "+30" style score floater. If targetX/Y are provided, the floater
// flies toward that point (typically the HUD score counter) and vanishes on
// arrival — gives "+N → score" feedback like classic match-3 polish.
export function spawnScore(x, y, amount, targetX = null, targetY = null) {
  if (amount <= 0) return;
  const f = findDead();
  if (!f) return;
  if (!f.alive) aliveCount++;
  f.x0 = f.x = x;
  f.y0 = f.y = y;
  f.targetX = targetX;
  f.targetY = targetY;
  f.text = `+${i18n.formatNumber(amount)}`;
  f.life = f.maxLife = 850;
  f.fontSize = amount >= 500 ? 24 : amount >= 100 ? 20 : 17;
  f.color = amount >= 500 ? '#ffd166' : amount >= 100 ? '#a4ffa4' : '#ffffff';
  f.kind = 'score';
  f.alive = true;
}

function findDead() {
  for (let i = 0; i < pool.length; i++) if (!pool[i].alive) return pool[i];
  // Pool saturated. Evict the oldest (closest to dying) so a fresh, important
  // floater (e.g. "MEGA x6!") isn't lost to a stale "+10" — the previous
  // behavior dropped the *new* floater, which felt wrong on big cascades.
  let oldest = pool[0];
  let oldestRatio = oldest.life / oldest.maxLife;
  for (let i = 1; i < pool.length; i++) {
    const f = pool[i];
    const r = f.life / f.maxLife;
    if (r < oldestRatio) { oldest = f; oldestRatio = r; }
  }
  // "Kill" the evicted slot so the spawner's `if (!f.alive) aliveCount++`
  // rebalances correctly. Without this, aliveCount stays flat across evictions
  // (spawner sees f.alive===true, skips the increment) but natural deaths
  // still decrement it — eventually aliveCount drops below the true alive
  // count and update()/draw() early-return at aliveCount===0, leaving live
  // floaters frozen on screen until clear() is called manually.
  oldest.alive = false;
  aliveCount--;
  return oldest;
}

export function update(dt) {
  if (aliveCount === 0) return;
  for (let i = 0; i < pool.length; i++) {
    const f = pool[i];
    if (!f.alive) continue;
    f.life -= dt;
    if (f.life <= 0) { f.alive = false; aliveCount--; continue; }
    if (f.kind === 'score' && f.targetX != null) {
      // Fly-to-counter: ease from spawn pos toward the HUD score over the
      // floater's lifetime so the eye traces "match → score gain".
      const k = 1 - f.life / f.maxLife;     // 0 → 1
      const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;   // easeInOutQuad
      f.x = f.x0 + (f.targetX - f.x0) * ease;
      f.y = f.y0 + (f.targetY - f.y0) * ease;
    } else {
      const rise = f.kind === 'score' ? 56 : 40;
      f.y -= (rise / f.maxLife) * dt;
    }
  }
}

export function draw(ctx) {
  if (aliveCount === 0) return;
  ctx.save();
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  for (let i = 0; i < pool.length; i++) {
    const f = pool[i];
    if (!f.alive) continue;
    const k = f.life / f.maxLife;
    const popK = 1 - f.life / f.maxLife;
    // Score floaters use a softer pop curve so they read as "value gained"
    // while combo floaters get the bigger scale-jump for impact.
    const scale = f.kind === 'score'
      ? (popK < 0.15 ? 0.6 + popK * 2.6 : 1)
      : (popK < 0.2 ? 0.4 + popK * 3 : 1);
    ctx.globalAlpha = Math.min(1, k * 1.5);
    ctx.font = `bold ${Math.round(f.fontSize * scale)}px -apple-system, system-ui, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillText(f.text, f.x + 2, f.y + 2);
    ctx.fillStyle = f.color;
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.restore();
}

export function clear() {
  for (let i = 0; i < pool.length; i++) pool[i].alive = false;
  aliveCount = 0;
}
