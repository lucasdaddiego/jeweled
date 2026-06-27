import { describe, it, expect } from 'vitest';
import { mulberry32, strHash, dateHash, todayISO } from '../src/rng.js';

describe('mulberry32', () => {
  it('is deterministic for a given seed', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seqA = [a(), a(), a(), a()];
    const seqB = [b(), b(), b(), b()];
    expect(seqA).toEqual(seqB);
  });

  it('produces values in [0, 1)', () => {
    const r = mulberry32(1);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('different seeds diverge', () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
  });
});

describe('strHash', () => {
  it('is deterministic and 32-bit unsigned', () => {
    const h = strHash('hello');
    expect(h).toBe(strHash('hello'));
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
  });

  it('handles the empty string', () => {
    expect(strHash('')).toBe(2166136261);
  });

  it('differs for different inputs', () => {
    expect(strHash('a')).not.toBe(strHash('b'));
  });
});

describe('dateHash', () => {
  it('matches strHash of the ISO date', () => {
    const d = new Date(2026, 0, 5); // 2026-01-05
    expect(dateHash(d)).toBe(strHash('2026-01-05'));
  });

  it('defaults to today when called with no argument', () => {
    expect(typeof dateHash()).toBe('number');
  });
});

describe('todayISO', () => {
  it('zero-pads single-digit month and day', () => {
    expect(todayISO(new Date(2026, 0, 5))).toBe('2026-01-05');
  });

  it('leaves two-digit month and day unpadded', () => {
    expect(todayISO(new Date(2026, 10, 23))).toBe('2026-11-23');
  });

  it('defaults to today when called with no argument', () => {
    expect(todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
