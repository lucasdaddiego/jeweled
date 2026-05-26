// Painting Zen: brushstroke layer that accumulates over a session.

let canvas = null;
let ctx = null;
let enabled = false;

export function init(width = 1080, height = 1080) {
  // Idempotent: reuse the existing OffscreenCanvas across Zen sessions to
  // avoid re-allocating a fresh ~4.5MB buffer (1080×1080×4 bytes) each enter.
  // Re-init with different dimensions allocates fresh.
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d');
  }
  clear();
}

export function setEnabled(v) {
  enabled = v;
}

export function isEnabled() { return enabled; }

export function clear() {
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

// gridX/gridY: cell center on the canvas; color: stroke color (CSS string).
// boardSize: width of the rendered board in CSS px (so we can map into the offscreen layer)
export function brushAt(gridX, gridY, boardSize, color) {
  if (!enabled || !ctx) return;
  const sx = (gridX / boardSize) * canvas.width;
  const sy = (gridY / boardSize) * canvas.height;
  const radius = (40 + Math.random() * 60) * (canvas.width / 1080);
  const jitter = (Math.random() - 0.5) * 30;
  const g = ctx.createRadialGradient(sx + jitter, sy + jitter, 0, sx + jitter, sy + jitter, radius);
  g.addColorStop(0, hexToRgba(color, 0.55));
  g.addColorStop(1, hexToRgba(color, 0));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(sx + jitter, sy + jitter, radius, 0, Math.PI * 2);
  ctx.fill();
}

// Draw the painting layer into a target ctx at (x, y, w, h), at given alpha.
export function drawInto(targetCtx, x, y, w, h, alpha = 0.55) {
  if (!ctx) return;
  targetCtx.save();
  targetCtx.globalAlpha = alpha;
  targetCtx.drawImage(canvas, x, y, w, h);
  targetCtx.restore();
}

export async function toBlob() {
  if (!canvas) return null;
  return await canvas.convertToBlob({ type: 'image/png' });
}

function hexToRgba(hex, a) {
  // Accept #rgb or #rrggbb
  if (hex.startsWith('#')) hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}
