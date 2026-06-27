import { describe, it, expect } from 'vitest';
import { SPECIAL } from '../src/config.js';
import {
  PUZZLES, getPuzzle, isGoalMet, goalText, progressText,
} from '../src/puzzles.js';

// i18n is never init()'d here, so formatNumber falls back to String(n) and the
// active locale stays 'en' — making the rendered strings deterministic.

describe('PUZZLES table + getPuzzle', () => {
  it('has 12 puzzles with unique, sequential ids', () => {
    expect(PUZZLES).toHaveLength(12);
    expect(PUZZLES.map(p => p.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('getPuzzle finds a puzzle by id', () => {
    expect(getPuzzle(1)).toBe(PUZZLES[0]);
    expect(getPuzzle(12)).toBe(PUZZLES[11]);
  });

  it('getPuzzle returns undefined for an unknown id', () => {
    expect(getPuzzle(0)).toBeUndefined();
    expect(getPuzzle(999)).toBeUndefined();
  });
});

describe('isGoalMet', () => {
  it('totalScore: met once score reaches the amount', () => {
    expect(isGoalMet({ type: 'totalScore', amount: 200 }, { score: 200 })).toBe(true);
    expect(isGoalMet({ type: 'totalScore', amount: 200 }, { score: 199 })).toBe(false);
  });

  it('clearGemsOfColor: uses the per-color tally, treating a missing color as 0', () => {
    expect(isGoalMet({ type: 'clearGemsOfColor', color: 0, count: 10 }, { clearedByColor: { 0: 10 } })).toBe(true);
    expect(isGoalMet({ type: 'clearGemsOfColor', color: 1, count: 10 }, { clearedByColor: {} })).toBe(false);
  });

  it('createSpecial: combines LINE_H + LINE_V into one "line gem" tally', () => {
    expect(isGoalMet(
      { type: 'createSpecial', special: SPECIAL.LINE_H, count: 3 },
      { specialsCreated: { LINE_H: 2, LINE_V: 1 } },
    )).toBe(true);
    expect(isGoalMet(
      { type: 'createSpecial', special: SPECIAL.LINE_V, count: 1 },
      { specialsCreated: {} },
    )).toBe(false);
  });

  it('createSpecial: counts non-line specials directly, missing as 0', () => {
    expect(isGoalMet(
      { type: 'createSpecial', special: SPECIAL.COLOR_BOMB, count: 1 },
      { specialsCreated: { COLOR_BOMB: 1 } },
    )).toBe(true);
    expect(isGoalMet(
      { type: 'createSpecial', special: SPECIAL.AREA_BOMB, count: 1 },
      { specialsCreated: {} },
    )).toBe(false);
  });

  it('cascadeDepth: met once maxCascadeDepth reaches depth', () => {
    expect(isGoalMet({ type: 'cascadeDepth', depth: 3 }, { maxCascadeDepth: 3 })).toBe(true);
    expect(isGoalMet({ type: 'cascadeDepth', depth: 3 }, { maxCascadeDepth: 2 })).toBe(false);
  });

  it('returns false for an unknown goal type', () => {
    expect(isGoalMet({ type: 'mystery' }, {})).toBe(false);
  });
});

describe('goalText', () => {
  it('totalScore', () => {
    expect(goalText({ type: 'totalScore', amount: 200 })).toBe('Score 200');
  });

  it('clearGemsOfColor resolves the color name', () => {
    expect(goalText({ type: 'clearGemsOfColor', color: 0, count: 10 })).toBe('Clear 10 red gems');
  });

  it('createSpecial names a mapped special', () => {
    expect(goalText({ type: 'createSpecial', special: SPECIAL.LINE_H, count: 2 })).toBe('Make 2 Line Gem');
    expect(goalText({ type: 'createSpecial', special: SPECIAL.COLOR_BOMB, count: 1 })).toBe('Make 1 Color Bomb');
  });

  it('createSpecial falls back to the generic label for an unmapped special', () => {
    expect(goalText({ type: 'createSpecial', special: SPECIAL.GRAVITY, count: 1 })).toBe('Make 1 special');
  });

  it('cascadeDepth', () => {
    expect(goalText({ type: 'cascadeDepth', depth: 3 })).toBe('Trigger a 3-chain cascade');
  });

  it('returns ??? for an unknown goal type', () => {
    expect(goalText({ type: 'mystery' })).toBe('???');
  });
});

describe('progressText', () => {
  it('totalScore', () => {
    expect(progressText({ type: 'totalScore', amount: 200 }, { score: 50 })).toBe('50 / 200');
  });

  it('clearGemsOfColor with a recorded tally', () => {
    expect(progressText(
      { type: 'clearGemsOfColor', color: 0, count: 10 },
      { clearedByColor: { 0: 5 } },
    )).toBe('5 / 10');
  });

  it('clearGemsOfColor defaults a missing tally to 0', () => {
    expect(progressText(
      { type: 'clearGemsOfColor', color: 1, count: 10 },
      { clearedByColor: {} },
    )).toBe('0 / 10');
  });

  it('createSpecial', () => {
    expect(progressText(
      { type: 'createSpecial', special: SPECIAL.COLOR_BOMB, count: 1 },
      { specialsCreated: { COLOR_BOMB: 1 } },
    )).toBe('1 / 1');
  });

  it('cascadeDepth with a recorded best', () => {
    expect(progressText({ type: 'cascadeDepth', depth: 3 }, { maxCascadeDepth: 2 })).toBe('Best chain: 2 / 3');
  });

  it('cascadeDepth defaults a missing best to 0', () => {
    expect(progressText({ type: 'cascadeDepth', depth: 3 }, {})).toBe('Best chain: 0 / 3');
  });

  it('returns an empty string for an unknown goal type', () => {
    expect(progressText({ type: 'mystery' }, {})).toBe('');
  });
});
