// Radial-wave effect — small expanding rings spawned at match centers.
// Pooled, no allocations during gameplay.

const POOL_SIZE = 24;

class Wave {
  constructor() {
    this.x = 0; this.y = 0;
    this.t = 0; this.maxT = 420;
    this.startR = 8; this.endR = 80;
    this.color = '#fff';
    this.alive = false;
  }
}

const pool = [];
for (let i = 0; i < POOL_SIZE; i++) pool.push(new Wave());
let aliveCount = 0;

export function spawn(x, y, color = 'rgba(255,255,255,0.6)', endR = 80, duration = 420) {
  for (let i = 0; i < pool.length; i++) {
    const w = pool[i];
    if (!w.alive) {
      w.x = x; w.y = y;
      w.t = 0; w.maxT = duration;
      w.startR = 8; w.endR = endR;
      w.color = color;
      w.alive = true;
      aliveCount++;
      return;
    }
  }
}

export function update(dt) {
  if (aliveCount === 0) return;
  for (let i = 0; i < pool.length; i++) {
    const w = pool[i];
    if (!w.alive) continue;
    w.t += dt;
    if (w.t >= w.maxT) { w.alive = false; aliveCount--; }
  }
}

export function draw(ctx) {
  if (aliveCount === 0) return;
  ctx.save();
  for (let i = 0; i < pool.length; i++) {
    const w = pool[i];
    if (!w.alive) continue;
    const k = w.t / w.maxT;
    const r = w.startR + (w.endR - w.startR) * easeOutQuart(k);
    const alpha = (1 - k) * 0.55;
    if (alpha < 0.02) continue;
    ctx.strokeStyle = w.color;
    ctx.globalAlpha = alpha;
    ctx.lineWidth = 2 + (1 - k) * 2;
    ctx.beginPath();
    ctx.arc(w.x, w.y, r, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

function easeOutQuart(k) { return 1 - Math.pow(1 - k, 4); }

export function clear() {
  for (let i = 0; i < pool.length; i++) pool[i].alive = false;
  aliveCount = 0;
}
