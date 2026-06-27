import { describe, it, expect, vi } from 'vitest';
import { easings, Tween } from '../src/animations.js';

describe('easings', () => {
  // Every easing is a normalized curve: f(0) === 0 and f(1) === 1. Iterating the
  // whole map guarantees each function (incl. the clamped spring/elastic guards)
  // is exercised; the 0 / 0.5 / 1 samples cover both `k<=0` and `k>=1` branches.
  it('every easing maps 0->0 and 1->1 and returns a finite mid value', () => {
    const names = Object.keys(easings);
    expect(names).toEqual(
      expect.arrayContaining([
        'linear', 'easeOutCubic', 'easeInQuad',
        'easeOutSpring', 'easeOutBack', 'easeOutElastic',
      ]),
    );
    for (const name of names) {
      const fn = easings[name];
      expect(fn(0), `${name}(0)`).toBeCloseTo(0, 6);
      expect(fn(1), `${name}(1)`).toBeCloseTo(1, 6);
      const mid = fn(0.5);
      expect(Number.isFinite(mid), `${name}(0.5) finite`).toBe(true);
    }
  });

  it('linear is the identity', () => {
    expect(easings.linear(0.25)).toBe(0.25);
    expect(easings.linear(0.5)).toBe(0.5);
  });

  it('easeInQuad squares its input', () => {
    expect(easings.easeInQuad(0.5)).toBeCloseTo(0.25, 10);
    expect(easings.easeInQuad(0.2)).toBeCloseTo(0.04, 10);
  });

  it('easeOutCubic eases toward 1 (decelerating)', () => {
    expect(easings.easeOutCubic(0.5)).toBeCloseTo(1 - Math.pow(0.5, 3), 10);
    expect(easings.easeOutCubic(0.5)).toBeGreaterThan(0.5); // ahead of linear
  });

  it('easeOutSpring clamps the out-of-range guards', () => {
    expect(easings.easeOutSpring(-1)).toBe(0); // k <= 0 guard
    expect(easings.easeOutSpring(0)).toBe(0);  // k <= 0 guard (boundary)
    expect(easings.easeOutSpring(1)).toBe(1);  // k >= 1 guard
    expect(easings.easeOutSpring(2)).toBe(1);  // k >= 1 guard (over)
    const mid = easings.easeOutSpring(0.5);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1); // settles without overshoot
  });

  it('easeOutBack overshoots past 1 before settling', () => {
    expect(easings.easeOutBack(0.5)).toBeGreaterThan(1); // visible overshoot
  });

  it('easeOutElastic clamps the out-of-range guards', () => {
    expect(easings.easeOutElastic(-1)).toBe(0); // k <= 0 guard
    expect(easings.easeOutElastic(0)).toBe(0);  // k <= 0 guard (boundary)
    expect(easings.easeOutElastic(1)).toBe(1);  // k >= 1 guard
    expect(easings.easeOutElastic(2)).toBe(1);  // k >= 1 guard (over)
    expect(Number.isFinite(easings.easeOutElastic(0.3))).toBe(true);
  });
});

describe('Tween', () => {
  it('clamps duration to >=1 and delay to >=0', () => {
    const tw = new Tween({ from: 0, to: 1, duration: 0, delay: -5 });
    expect(tw.duration).toBe(1);
    expect(tw.delay).toBe(0);
  });

  it('uses defaults (easeOutCubic, no callbacks) and completes in one step', () => {
    // Only from/to/duration passed -> default ease + null onStart/onUpdate/onDone.
    const tw = new Tween({ from: 0, to: 10, duration: 10 });
    expect(tw.value).toBe(0);
    expect(tw.done).toBe(false);
    tw.update(10); // k = 1 -> easeOutCubic(1) === 1 -> value === to, done
    expect(tw.value).toBe(10);
    expect(tw.done).toBe(true);
    // No callbacks set: the null-callback branches are exercised without throwing.
    expect(() => tw.update(5)).not.toThrow();
  });

  it('holds at `from` through the delay window, then carries overshoot into the tween', () => {
    const onStart = vi.fn();
    const onUpdate = vi.fn();
    const onDone = vi.fn();
    const tw = new Tween({
      from: 0, to: 100, duration: 100, delay: 50,
      ease: easings.linear, onStart, onUpdate, onDone,
    });

    // Inside the delay window: value frozen, nothing fires.
    tw.update(30); // delay 50 -> 20, still > 0 -> early return
    expect(tw.value).toBe(0);
    expect(tw.started).toBe(false);
    expect(onStart).not.toHaveBeenCalled();
    expect(onUpdate).not.toHaveBeenCalled();

    // Crossing the delay boundary: 20 - 30 = -10 -> 10ms of overshoot tween time.
    tw.update(30);
    expect(tw.started).toBe(true);
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(tw.value).toBeCloseTo(10, 10); // linear: 10/100 of the 0..100 range
    expect(onUpdate).toHaveBeenLastCalledWith(expect.closeTo(10, 10));
    expect(onDone).not.toHaveBeenCalled();

    // Mid-progress: onStart not fired again, still not done.
    tw.update(40); // t = 50
    expect(onStart).toHaveBeenCalledTimes(1);
    expect(tw.value).toBeCloseTo(50, 10);
    expect(tw.done).toBe(false);

    // Reaches the end: k clamps to 1, onDone fires exactly once.
    tw.update(60); // t = 110 -> k clamped to 1
    expect(tw.value).toBeCloseTo(100, 10);
    expect(tw.done).toBe(true);
    expect(onDone).toHaveBeenCalledTimes(1);

    // Further updates are no-ops once done.
    tw.update(100);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenLastCalledWith(expect.closeTo(100, 10));
  });

  it('interpolates mid-flight with a custom ease without firing onDone early', () => {
    const onUpdate = vi.fn();
    const tw = new Tween({ from: 10, to: 20, duration: 100, ease: easings.linear, onUpdate });
    tw.update(25); // k = 0.25 -> value 12.5
    expect(tw.value).toBeCloseTo(12.5, 10);
    expect(tw.done).toBe(false);
    tw.update(25); // started already true (skips onStart), k = 0.5 -> value 15
    expect(tw.value).toBeCloseTo(15, 10);
    expect(tw.done).toBe(false);
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });
});
