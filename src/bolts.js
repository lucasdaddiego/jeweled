// Animated line-segment effects: lightning arcs and star shooting trails.
// Pooled, no allocations during gameplay.
//
// Each bolt is a polyline from (x1,y1) to (x2,y2) with a few jittered midpoints.
// It fades over its lifetime; lightning uses sharp white-yellow, star uses gold.

const POOL_SIZE = 32;

class Bolt {
  constructor() {
    this.x1 = 0; this.y1 = 0;
    this.x2 = 0; this.y2 = 0;
    this.points = null;   // pre-baked midpoints (xy pairs)
    this.t = 0; this.maxT = 320;
    this.color = '#fff';
    this.width = 3;
    this.glowColor = 'rgba(255,255,255,0.5)';
    this.alive = false;
  }
}

const pool = [];
for (let i = 0; i < POOL_SIZE; i++) pool.push(new Bolt());
let aliveCount = 0;

function findDead() {
  for (let i = 0; i < pool.length; i++) if (!pool[i].alive) return pool[i];
  return pool[0];   // worst case: stomp the oldest
}

// Pre-compute a jittered polyline between two points. Number of segments
// scales with distance so far targets read as more "zappy".
function buildPath(x1, y1, x2, y2, jitter) {
  const dx = x2 - x1, dy = y2 - y1;
  const dist = Math.hypot(dx, dy);
  const segs = Math.max(4, Math.floor(dist / 28));
  const pts = [x1, y1];
  // Perpendicular unit vector for the jitter
  const px = -dy / (dist || 1);
  const py = dx / (dist || 1);
  for (let i = 1; i < segs; i++) {
    const k = i / segs;
    const j = (Math.random() - 0.5) * jitter;
    pts.push(x1 + dx * k + px * j, y1 + dy * k + py * j);
  }
  pts.push(x2, y2);
  return pts;
}

// Lightning arc: short, jagged, white-yellow.
export function spawnLightning(x1, y1, x2, y2) {
  const b = findDead();
  if (!b.alive) aliveCount++;
  b.x1 = x1; b.y1 = y1; b.x2 = x2; b.y2 = y2;
  b.points = buildPath(x1, y1, x2, y2, 16);
  b.t = 0; b.maxT = 340;
  b.color = '#ffffff';
  b.glowColor = 'rgba(255, 235, 100, 0.65)';
  b.width = 3;
  b.alive = true;
}

// Star shooting trail: longer, gold, smoother arc.
export function spawnStarTrail(x1, y1, x2, y2) {
  const b = findDead();
  if (!b.alive) aliveCount++;
  b.x1 = x1; b.y1 = y1; b.x2 = x2; b.y2 = y2;
  b.points = buildPath(x1, y1, x2, y2, 6);
  b.t = 0; b.maxT = 460;
  b.color = '#ffe48a';
  b.glowColor = 'rgba(255, 215, 0, 0.55)';
  b.width = 4;
  b.alive = true;
}

export function update(dt) {
  if (aliveCount === 0) return;
  for (let i = 0; i < pool.length; i++) {
    const b = pool[i];
    if (!b.alive) continue;
    b.t += dt;
    if (b.t >= b.maxT) { b.alive = false; aliveCount--; }
  }
}

export function draw(ctx) {
  if (aliveCount === 0) return;
  ctx.save();
  for (let i = 0; i < pool.length; i++) {
    const b = pool[i];
    if (!b.alive || !b.points) continue;
    const k = b.t / b.maxT;
    const alpha = 1 - k;
    if (alpha < 0.02) continue;
    // Soft glow underlayer
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = b.glowColor;
    ctx.lineWidth = b.width * 3;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(b.points[0], b.points[1]);
    for (let p = 2; p < b.points.length; p += 2) ctx.lineTo(b.points[p], b.points[p + 1]);
    ctx.stroke();
    // Crisp core
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = b.color;
    ctx.lineWidth = b.width;
    ctx.beginPath();
    ctx.moveTo(b.points[0], b.points[1]);
    for (let p = 2; p < b.points.length; p += 2) ctx.lineTo(b.points[p], b.points[p + 1]);
    ctx.stroke();
  }
  ctx.restore();
}

export function clear() {
  for (let i = 0; i < pool.length; i++) pool[i].alive = false;
  aliveCount = 0;
}
