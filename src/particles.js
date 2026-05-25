// Pre-allocated particle pool — no allocations during gameplay.

import { PARTICLE_POOL } from './config.js';

const GRAV = 0.0008; // px/ms^2
const DRAG = 0.998;

class Particle {
  constructor() {
    this.x = 0; this.y = 0;
    this.vx = 0; this.vy = 0;
    this.life = 0; this.maxLife = 1;
    this.color = '#fff';
    this.size = 4;
    this.alive = false;
  }
}

const pool = [];
for (let i = 0; i < PARTICLE_POOL; i++) pool.push(new Particle());

// Walking cursor for findDead — amortizes the scan across spawn calls so we
// don't pay O(POOL) every single spawn. A 12-particle burst × 12 matches/
// cascade was ~74k reads/frame on the naive scan; this drops to ~POOL once.
let nextDeadCursor = 0;
let aliveCount = 0;

export function spawnBurst(x, y, color, count = 12, opts = {}) {
  const speed = opts.speed ?? 0.35;          // px/ms
  const life  = opts.life  ?? 700;            // ms
  const size  = opts.size  ?? 5;
  // Accept either a single color or an array of shades for per-particle variation.
  const isArr = Array.isArray(color);
  for (let i = 0; i < count; i++) {
    const p = findDead();
    if (!p) break;
    const a = Math.random() * Math.PI * 2;
    const s = speed * (0.6 + Math.random() * 0.8);
    p.x = x; p.y = y;
    p.vx = Math.cos(a) * s;
    p.vy = Math.sin(a) * s - 0.15;
    p.life = p.maxLife = life * (0.7 + Math.random() * 0.6);
    p.color = isArr ? color[(Math.random() * color.length) | 0] : color;
    p.size = size * (0.6 + Math.random() * 0.8);
    p.alive = true;
    aliveCount++;
  }
}

function findDead() {
  // Walk forward from the cursor; one full lap means the pool is saturated.
  const start = nextDeadCursor;
  for (let n = 0; n < pool.length; n++) {
    const i = (start + n) % pool.length;
    if (!pool[i].alive) {
      nextDeadCursor = (i + 1) % pool.length;
      return pool[i];
    }
  }
  return null;
}

export function update(dt) {
  if (aliveCount === 0) return;
  // Hoist per-frame computations outside the per-particle loop. dt is the
  // same for every particle in a single tick, so the drag factor and the
  // gravity step are identical — no point recomputing 512 times.
  const dragFactor = Math.pow(DRAG, dt / 16);
  const gravStep = GRAV * dt;
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.alive) continue;
    p.life -= dt;
    if (p.life <= 0) { p.alive = false; aliveCount--; continue; }
    p.vy += gravStep;
    p.vx *= dragFactor;
    p.x += p.vx * dt;
    p.y += p.vy * dt;
  }
}

export function draw(ctx) {
  if (aliveCount === 0) return;
  ctx.save();
  for (let i = 0; i < pool.length; i++) {
    const p = pool[i];
    if (!p.alive) continue;
    const alpha = Math.min(1, p.life / p.maxLife);
    if (alpha < 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

export function clear() {
  for (let i = 0; i < pool.length; i++) pool[i].alive = false;
  nextDeadCursor = 0;
  aliveCount = 0;
}
