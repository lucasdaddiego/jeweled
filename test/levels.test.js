import { describe, it, expect } from 'vitest';
import {
  LEVELS, LEVELS_PER_PAGE, pageCount, pageOfLevel,
  getLevel, levelCount, starsFor,
} from '../src/levels.js';

describe('LEVELS table', () => {
  it('has 300 levels (50 hand-tuned + 250 generated)', () => {
    expect(LEVELS).toHaveLength(300);
    expect(levelCount()).toBe(300);
  });

  it('matches the published hand-tuned endpoints', () => {
    expect(LEVELS[0]).toEqual({ moves: 30, targetScore: 500 });
    // L50 is a boss level (every 10th) — the tuning numbers still hold.
    expect(LEVELS[49]).toEqual({ moves: 20, targetScore: 365500, boss: true });
  });

  it('marks every 10th level as a boss and attaches ice layouts sparsely', () => {
    for (let i = 10; i <= LEVELS.length; i += 10) expect(LEVELS[i - 1].boss).toBe(true);
    expect(LEVELS[9 - 1].boss).toBeUndefined();
    expect(Array.isArray(LEVELS[5 - 1].ice)).toBe(true);     // hand-picked L5
    expect(Array.isArray(LEVELS[63 - 1].ice)).toBe(true);    // generated 63 = 7×9
    expect(LEVELS[6 - 1].ice).toBeUndefined();
    // Ice coordinates are unique, in-bounds board cells.
    for (const def of LEVELS) {
      if (!def.ice) continue;
      const seen = new Set();
      for (const [r, c] of def.ice) {
        expect(r).toBeGreaterThanOrEqual(0); expect(r).toBeLessThan(8);
        expect(c).toBeGreaterThanOrEqual(0); expect(c).toBeLessThan(8);
        const k = `${r},${c}`;
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it('generates levels 51+ with a 20-move budget and 500-rounded targets', () => {
    for (let i = 50; i < LEVELS.length; i++) {
      expect(LEVELS[i].moves).toBe(20);
      expect(LEVELS[i].targetScore % 500).toBe(0);
    }
  });

  it('keeps targets strictly increasing across the whole table', () => {
    for (let i = 1; i < LEVELS.length; i++) {
      expect(LEVELS[i].targetScore).toBeGreaterThan(LEVELS[i - 1].targetScore);
    }
  });
});

describe('pagination helpers', () => {
  it('pageCount = ceil(levels / per-page)', () => {
    expect(LEVELS_PER_PAGE).toBe(20);
    expect(pageCount()).toBe(Math.ceil(LEVELS.length / LEVELS_PER_PAGE));
    expect(pageCount()).toBe(15);
  });

  it('pageOfLevel maps a level number to its 1-based page', () => {
    expect(pageOfLevel(1)).toBe(1);
    expect(pageOfLevel(20)).toBe(1);
    expect(pageOfLevel(21)).toBe(2);
    expect(pageOfLevel(300)).toBe(15);
  });
});

describe('getLevel clamping', () => {
  it('returns the matching config for an in-range level', () => {
    expect(getLevel(1)).toBe(LEVELS[0]);
    expect(getLevel(50)).toBe(LEVELS[49]);
    expect(getLevel(300)).toBe(LEVELS[299]);
  });

  it('truncates a fractional level number toward zero', () => {
    expect(getLevel(5.9)).toBe(LEVELS[4]);
  });

  it('clamps zero and negatives up to level 1', () => {
    expect(getLevel(0)).toBe(LEVELS[0]);
    expect(getLevel(-10)).toBe(LEVELS[0]);
  });

  it('clamps past-the-end down to the last level', () => {
    expect(getLevel(301)).toBe(LEVELS[299]);
    expect(getLevel(99999)).toBe(LEVELS[299]);
  });
});

describe('starsFor', () => {
  it('awards 0 stars below target', () => {
    expect(starsFor(499, 500)).toBe(0);
  });

  it('awards 1 star from target up to (but not at) +50%', () => {
    expect(starsFor(500, 500)).toBe(1);
    expect(starsFor(749, 500)).toBe(1);
  });

  it('awards 2 stars from +50% up to (but not at) +100%', () => {
    expect(starsFor(750, 500)).toBe(2);
    expect(starsFor(999, 500)).toBe(2);
  });

  it('awards 3 stars at +100% or above', () => {
    expect(starsFor(1000, 500)).toBe(3);
    expect(starsFor(5000, 500)).toBe(3);
  });
});
