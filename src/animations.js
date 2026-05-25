// Time-based tweens, no library.

export const easings = {
  linear:       (k) => k,
  easeOutCubic: (k) => 1 - Math.pow(1 - k, 3),
  easeInQuad:   (k) => k * k,
  // Smooth settle without overshoot — good for everyday swaps.
  easeOutSpring:(k) => {
    if (k <= 0) return 0;
    if (k >= 1) return 1;
    return 1 - Math.cos(k * Math.PI * 0.5) * Math.exp(-k * 2.2);
  },
  // Visible overshoot, useful for spawn pops and squash recoveries.
  easeOutBack:  (k) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2);
  },
  // Rubbery elastic — used for the bounce-back on an invalid drop.
  easeOutElastic: (k) => {
    if (k <= 0) return 0;
    if (k >= 1) return 1;
    const p = 0.4;
    return Math.pow(2, -8 * k) * Math.sin((k - p / 4) * (2 * Math.PI) / p) + 1;
  },
};

export class Tween {
  constructor({ from, to, duration, delay = 0, ease = easings.easeOutCubic, onDone = null, onUpdate = null, onStart = null }) {
    this.from = from;
    this.to = to;
    this.duration = Math.max(1, duration);
    this.delay = Math.max(0, delay);
    this.ease = ease;
    this.onDone = onDone;
    this.onUpdate = onUpdate;
    this.onStart = onStart;
    this.t = 0;
    this.value = from;
    this.done = false;
    this.started = false;
  }
  update(dt) {
    if (this.done) return;
    // Drain the delay window first; while the delay is ticking the tween
    // value stays at `from` and onUpdate isn't called.
    if (this.delay > 0) {
      this.delay -= dt;
      if (this.delay > 0) return;
      dt = -this.delay;   // carry overshoot into the actual tween time
      this.delay = 0;
    }
    if (!this.started) {
      this.started = true;
      if (this.onStart) this.onStart();
    }
    this.t += dt;
    const k = Math.min(this.t / this.duration, 1);
    this.value = this.from + (this.to - this.from) * this.ease(k);
    if (this.onUpdate) this.onUpdate(this.value);
    if (k >= 1) {
      this.done = true;
      if (this.onDone) this.onDone();
    }
  }
}
