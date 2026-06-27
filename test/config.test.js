import { describe, it, expect } from 'vitest';
import {
  GRID, TYPES, DEFAULT_EMOJI, SPECIAL, SPAWN_RATES,
  BIG_WAVE_AREA_BOMB, BIG_WAVE_COLOR_BOMB, COIN_MULTIPLIER,
  STAR_CASCADE_TRIGGER, LIGHTNING_TARGETS, POWERUP_MILESTONE,
  POWERUP_MAX_CHARGES, POWERUP_SLOTS, POWERUP_META, TIME_BOMB_START,
  TIMING, SLOWMO_FACTOR, SCORE, PARTICLE_POOL, FLOATER_POOL,
  STORAGE_KEY, STORAGE_VERSION, NAME_MAX_LEN, SHAKE_MIN_DEPTH,
  SLOWMO_MIN_DEPTH, DAILY_MOVES, BLITZ_DURATION_MS,
} from '../src/config.js';

describe('board + gem constants', () => {
  it('defines an 8x8 board with 7 gem types', () => {
    expect(GRID).toBe(8);
    expect(TYPES).toBe(7);
  });

  it('ships exactly TYPES distinct gem emoji', () => {
    expect(DEFAULT_EMOJI).toHaveLength(TYPES);
    expect(new Set(DEFAULT_EMOJI).size).toBe(TYPES);
  });
});

describe('SPECIAL identifiers', () => {
  it('uses null for NONE and stable string tags for the rest', () => {
    expect(SPECIAL.NONE).toBeNull();
    expect(SPECIAL.LINE_H).toBe('LINE_H');
    expect(SPECIAL.LINE_V).toBe('LINE_V');
    expect(SPECIAL.COLOR_BOMB).toBe('COLOR_BOMB');
    expect(SPECIAL.WILDCARD).toBe('WILDCARD');
    expect(SPECIAL.STAR).toBe('STAR');
  });
});

describe('SCORE.CASCADE_MULTIPLIER', () => {
  it('is 1x at depth 1 and grows +0.5 per depth', () => {
    expect(SCORE.CASCADE_MULTIPLIER(1)).toBe(1);
    expect(SCORE.CASCADE_MULTIPLIER(2)).toBe(1.5);
    expect(SCORE.CASCADE_MULTIPLIER(3)).toBe(2);
    expect(SCORE.CASCADE_MULTIPLIER(4)).toBe(2.5);
    expect(SCORE.CASCADE_MULTIPLIER(5)).toBe(3);
  });

  it('follows 1 + (depth-1)*0.5 for arbitrary depths', () => {
    for (let d = 1; d <= 12; d++) {
      expect(SCORE.CASCADE_MULTIPLIER(d)).toBeCloseTo(1 + (d - 1) * 0.5, 10);
    }
  });

  it('exposes the flat scoring constants', () => {
    expect(SCORE.PER_GEM_CLEARED).toBe(10);
    expect(SCORE.BOMB_DEFUSE_BONUS).toBe(500);
    expect(SCORE.SPECIAL_SPAWN_BONUS).toBe(50);
  });
});

describe('spawn + powerup tunables', () => {
  it('keeps every spawn rate a positive integer (1-in-N)', () => {
    const rates = Object.values(SPAWN_RATES);
    expect(rates.length).toBeGreaterThan(0);
    for (const v of rates) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
  });

  it('orders the big-wave thresholds (area bomb before color bomb)', () => {
    expect(BIG_WAVE_AREA_BOMB).toBe(6);
    expect(BIG_WAVE_COLOR_BOMB).toBe(7);
    expect(BIG_WAVE_AREA_BOMB).toBeLessThan(BIG_WAVE_COLOR_BOMB);
  });

  it('defines emoji + ring metadata for every powerup slot', () => {
    expect(POWERUP_SLOTS).toEqual(['shuffle', 'colorBlast', 'bombDrop', 'recolor']);
    for (const slot of POWERUP_SLOTS) {
      expect(POWERUP_META[slot]).toMatchObject({
        emoji: expect.any(String),
        ring: expect.any(String),
      });
    }
  });
});

describe('storage + timing + misc tunables', () => {
  it('pins the storage key and version', () => {
    expect(STORAGE_KEY).toBe('gem-match:v1');
    expect(STORAGE_VERSION).toBe(1);
  });

  it('has positive animation timings and a sub-1 slowmo factor', () => {
    expect(TIMING.SWAP).toBeGreaterThan(0);
    expect(TIMING.HINT_AFTER).toBeGreaterThan(0);
    expect(SLOWMO_FACTOR).toBeGreaterThan(0);
    expect(SLOWMO_FACTOR).toBeLessThan(1);
  });

  it('orders the cascade depth thresholds and sizes the durations', () => {
    expect(SHAKE_MIN_DEPTH).toBeLessThan(SLOWMO_MIN_DEPTH);
    expect(DAILY_MOVES).toBeGreaterThan(0);
    expect(BLITZ_DURATION_MS).toBe(60_000);
  });

  it('exposes the remaining scalar tunables with expected values', () => {
    expect(PARTICLE_POOL).toBeGreaterThan(0);
    expect(FLOATER_POOL).toBeGreaterThan(0);
    expect(COIN_MULTIPLIER).toBe(5);
    expect(STAR_CASCADE_TRIGGER).toBe(3);
    expect(LIGHTNING_TARGETS).toBe(3);
    expect(POWERUP_MILESTONE).toBe(1500);
    expect(POWERUP_MAX_CHARGES).toBe(3);
    expect(TIME_BOMB_START).toBe(7);
    expect(NAME_MAX_LEN).toBe(16);
  });
});
