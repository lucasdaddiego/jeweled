import { describe, it, expect } from 'vitest';
import {
  dailyStreak, msUntilNextDaily, countdownParts, lastNDays, buildShareText,
} from '../src/dailyMeta.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// Build a history blob from a list of ISO days (score/moves values don't
// matter for the date math, but keep the real record shape).
function hist(...days) {
  const h = {};
  for (const d of days) h[d] = { score: 1000, movesUsed: 30 };
  return h;
}

describe('dailyStreak', () => {
  it('counts consecutive days back from today when today is played', () => {
    const h = hist('2026-06-13', '2026-06-14', '2026-06-15');
    expect(dailyStreak(h, '2026-06-15')).toBe(3);
  });

  it('keeps the streak alive when today is unplayed but yesterday was', () => {
    const h = hist('2026-06-13', '2026-06-14');
    expect(dailyStreak(h, '2026-06-15')).toBe(2);
  });

  it('is 0 when neither today nor yesterday was played', () => {
    const h = hist('2026-06-10', '2026-06-11');
    expect(dailyStreak(h, '2026-06-15')).toBe(0);
  });

  it('is 0 for an empty history', () => {
    expect(dailyStreak({}, '2026-06-15')).toBe(0);
  });

  it('is 0 for a missing history blob', () => {
    expect(dailyStreak(null, '2026-06-15')).toBe(0);
  });

  it('counts a single played day as a 1-day streak', () => {
    expect(dailyStreak(hist('2026-06-15'), '2026-06-15')).toBe(1);
  });

  it('stops at a gap even when older days exist', () => {
    const h = hist('2026-06-15', '2026-06-13', '2026-06-12');
    expect(dailyStreak(h, '2026-06-15')).toBe(1);
  });

  it('walks back across a month boundary (Mar 1 → Feb 28)', () => {
    const h = hist('2026-02-27', '2026-02-28', '2026-03-01');
    expect(dailyStreak(h, '2026-03-01')).toBe(3);
  });

  it('treats Feb 28 → Mar 1 as consecutive in a non-leap year', () => {
    expect(dailyStreak(hist('2026-02-28', '2026-03-01'), '2026-03-01')).toBe(2);
  });

  it('walks through Feb 29 in a leap year', () => {
    const h = hist('2024-02-28', '2024-02-29', '2024-03-01');
    expect(dailyStreak(h, '2024-03-01')).toBe(3);
  });

  it('walks back across a year boundary (Jan 1 → Dec 31)', () => {
    const h = hist('2025-12-30', '2025-12-31', '2026-01-01');
    expect(dailyStreak(h, '2026-01-01')).toBe(3);
  });

  it('applies the yesterday grace across a year boundary', () => {
    const h = hist('2025-12-30', '2025-12-31');
    expect(dailyStreak(h, '2026-01-01')).toBe(2);
  });
});

describe('msUntilNextDaily', () => {
  it('returns 1ms just before local midnight', () => {
    expect(msUntilNextDaily(new Date(2026, 5, 15, 23, 59, 59, 999))).toBe(1);
  });

  it('returns a full day at exactly local midnight', () => {
    expect(msUntilNextDaily(new Date(2026, 5, 15, 0, 0, 0, 0))).toBe(DAY);
  });

  it('returns 12h at local noon', () => {
    expect(msUntilNextDaily(new Date(2026, 5, 15, 12, 0, 0, 0))).toBe(12 * HOUR);
  });

  it('rolls across the year boundary', () => {
    expect(msUntilNextDaily(new Date(2025, 11, 31, 23, 0, 0, 0))).toBe(HOUR);
  });

  it('defaults to now and stays within (0, 24h]', () => {
    const ms = msUntilNextDaily();
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(DAY);
  });
});

describe('countdownParts', () => {
  it('shows 0h 0m only when no time remains', () => {
    expect(countdownParts(0)).toEqual({ hours: 0, minutes: 0 });
  });

  it('clamps negative input to zero', () => {
    expect(countdownParts(-5000)).toEqual({ hours: 0, minutes: 0 });
  });

  it('rounds 1ms up to a full minute (never 0h 0m while time remains)', () => {
    expect(countdownParts(1)).toEqual({ hours: 0, minutes: 1 });
  });

  it('rounds 59s up to a full minute', () => {
    expect(countdownParts(59 * 1000)).toEqual({ hours: 0, minutes: 1 });
  });

  it('keeps an exact minute count un-bumped', () => {
    expect(countdownParts(59 * 60 * 1000)).toEqual({ hours: 0, minutes: 59 });
  });

  it('handles exactly one hour', () => {
    expect(countdownParts(HOUR)).toEqual({ hours: 1, minutes: 0 });
  });

  it('rounds a partial minute past the hour up', () => {
    expect(countdownParts(HOUR + 1)).toEqual({ hours: 1, minutes: 1 });
  });

  it('splits mixed durations into hours and 0-59 minutes', () => {
    expect(countdownParts(90 * 60 * 1000)).toEqual({ hours: 1, minutes: 30 });
    expect(countdownParts(12345678)).toEqual({ hours: 3, minutes: 26 });
  });

  it('rolls a rounded-up 60th minute into the hour', () => {
    // 1ms shy of a day → 1440 whole minutes → 24h 0m, not 23h 60m.
    expect(countdownParts(DAY - 1)).toEqual({ hours: 24, minutes: 0 });
  });
});

describe('lastNDays', () => {
  it('returns n slots oldest→newest ending at todayIso, null-filling gaps', () => {
    const h = hist('2026-06-13', '2026-06-15');
    const days = lastNDays(h, 3, '2026-06-15');
    expect(days.map((d) => d.iso)).toEqual(['2026-06-13', '2026-06-14', '2026-06-15']);
    expect(days[0].entry).toBe(h['2026-06-13']); // the record itself, not a copy
    expect(days[1].entry).toBeNull();
    expect(days[2].entry).toBe(h['2026-06-15']);
  });

  it('crosses month boundaries', () => {
    const days = lastNDays({}, 4, '2026-03-02');
    expect(days.map((d) => d.iso)).toEqual(['2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
  });

  it('crosses year boundaries', () => {
    const days = lastNDays({}, 3, '2026-01-02');
    expect(days.map((d) => d.iso)).toEqual(['2025-12-31', '2026-01-01', '2026-01-02']);
  });

  it('includes Feb 29 in leap years', () => {
    const days = lastNDays({}, 2, '2024-03-01');
    expect(days.map((d) => d.iso)).toEqual(['2024-02-29', '2024-03-01']);
  });

  it('handles n=1 (just today)', () => {
    expect(lastNDays({}, 1, '2026-06-15')).toEqual([{ iso: '2026-06-15', entry: null }]);
  });

  it('returns an empty array for n=0', () => {
    expect(lastNDays({}, 0, '2026-06-15')).toEqual([]);
  });

  it('fills all nulls for a missing history blob', () => {
    const days = lastNDays(null, 2, '2026-06-15');
    expect(days.map((d) => d.entry)).toEqual([null, null]);
  });
});

describe('buildShareText', () => {
  it('includes every line, in order, when all fields are present', () => {
    const text = buildShareText({
      dateLabel: 'Jun 15, 2026',
      score: '12,340',
      movesUsed: '28',
      streak: 5,
      url: 'https://jeweled.daddiego.com.ar',
    });
    expect(text).toBe([
      '💎 Jeweled Daily — Jun 15, 2026',
      '🏆 12,340 pts in 28 moves',
      '🔥 5-day streak',
      'https://jeweled.daddiego.com.ar',
    ].join('\n'));
  });

  it('passes pre-formatted numbers through verbatim', () => {
    const text = buildShareText({ dateLabel: 'x', score: '1.234.567', movesUsed: '30', streak: 0 });
    expect(text).toContain('🏆 1.234.567 pts in 30 moves');
  });

  it('drops just the moves clause when movesUsed is null', () => {
    const text = buildShareText({ dateLabel: 'd', score: '900', movesUsed: null, streak: 0 });
    expect(text.split('\n')[1]).toBe('🏆 900 pts');
  });

  it('drops the moves clause when movesUsed is undefined', () => {
    const text = buildShareText({ dateLabel: 'd', score: '900', streak: 0 });
    expect(text).not.toContain('moves');
  });

  it('shows the streak line from 2 days up, numeric strings included', () => {
    expect(buildShareText({ dateLabel: 'd', score: '1', streak: 2 })).toContain('🔥 2-day streak');
    expect(buildShareText({ dateLabel: 'd', score: '1', streak: '3' })).toContain('🔥 3-day streak');
  });

  it('hides the streak line below 2 or when absent', () => {
    expect(buildShareText({ dateLabel: 'd', score: '1', streak: 1 })).not.toContain('🔥');
    expect(buildShareText({ dateLabel: 'd', score: '1' })).not.toContain('🔥');
  });

  it('ends without a trailing newline when no url is given', () => {
    const text = buildShareText({ dateLabel: 'd', score: '1', movesUsed: '9', streak: 0 });
    expect(text.endsWith('\n')).toBe(false);
    expect(text.split('\n')).toHaveLength(2);
  });
});
