import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// achievements.js holds module-level singletons: an in-memory toastQueue and a
// one-shot `_hydrated` latch. Both must start clean per scenario, so each test
// re-imports the module fresh via resetModules. achievements + storage resolve
// to the same (post-reset) storage instance, so persisted writes are visible to
// both. localStorage is cleared by the global setup beforeEach; pass a blob to
// seed it BEFORE the modules load (drives hydrateUnshownToasts).
async function fresh(seedAchievements) {
  vi.resetModules();
  const config = await import('../src/config.js');
  if (seedAchievements !== undefined) {
    localStorage.setItem(config.STORAGE_KEY, JSON.stringify({
      version: config.STORAGE_VERSION,
      achievements: seedAchievements,
    }));
  }
  const storage = await import('../src/storage.js');
  const ach = await import('../src/achievements.js');
  return { storage, ach };
}

function unlockedIds(ach) {
  return Object.keys(ach.summary().unlockedSet);
}

// Fake timers neutralise storage's 250ms debounced save: writes mutate the
// in-memory cache synchronously (what we assert on), and the orphaned timers
// left behind by resetModules never fire into a later test.
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('ACHIEVEMENTS catalogue + summary', () => {
  it('exposes 20 achievements with unique ids and full metadata', async () => {
    const { ach } = await fresh();
    expect(ach.ACHIEVEMENTS).toHaveLength(20);
    const ids = ach.ACHIEVEMENTS.map(a => a.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of ach.ACHIEVEMENTS) {
      expect(a).toMatchObject({
        id: expect.any(String),
        nameKey: expect.any(String),
        descKey: expect.any(String),
        icon: expect.any(String),
      });
    }
  });

  it('summary() reports totals against a fresh (empty) state', async () => {
    const { ach } = await fresh();
    const s = ach.summary();
    expect(s).toEqual({
      unlocked: 0,
      total: 20,
      counters: { totalMatches: 0 },
      unlockedSet: {},
    });
  });
});

describe('notifyMatchCleared', () => {
  it('unlocks first_match, accumulates the counter, and stays below the tiers', async () => {
    const { ach } = await fresh();
    ach.notifyMatchCleared(5, 1);                // 2 args: specialsCleared defaults to []
    expect(unlockedIds(ach)).toEqual(['first_match']);
    expect(ach.summary().counters.totalMatches).toBe(5);

    ach.notifyMatchCleared(3, 1);                // counter accumulates onto the existing value
    expect(ach.summary().counters.totalMatches).toBe(8);
    expect(unlockedIds(ach)).toEqual(['first_match']);  // 8 matches, depth 1 → no new tiers
  });

  it('unlocks every match-count and cascade tier at/above the thresholds', async () => {
    const { ach } = await fresh();
    ach.notifyMatchCleared(10000, 8, ['COLOR_BOMB']);   // 3rd arg supplied explicitly
    expect(unlockedIds(ach)).toEqual(expect.arrayContaining([
      'first_match', 'matches_100', 'matches_1000', 'matches_10000',
      'cascade_3', 'cascade_5', 'cascade_8',
    ]));
    expect(ach.summary().counters.totalMatches).toBe(10000);
  });
});

describe('notifySpecialSpawned', () => {
  it('unlocks the achievement matching each tracked special', async () => {
    const { ach } = await fresh();
    ach.notifySpecialSpawned('COLOR_BOMB');
    ach.notifySpecialSpawned('AREA_BOMB');
    ach.notifySpecialSpawned('STAR');
    expect(unlockedIds(ach).sort()).toEqual(['special_area', 'special_color', 'special_star']);
  });

  it('ignores a special with no associated achievement', async () => {
    const { ach } = await fresh();
    ach.notifySpecialSpawned('WILDCARD');
    expect(unlockedIds(ach)).toEqual([]);
  });
});

describe('notifyLevelWin', () => {
  it('unlocks the classic milestones up to the level reached', async () => {
    const { ach } = await fresh();
    ach.notifyLevelWin(100);
    expect(unlockedIds(ach).sort()).toEqual(['classic_l10', 'classic_l100', 'classic_l50']);
  });

  it('unlocks the grandmaster tier at level 200', async () => {
    const { ach } = await fresh();
    ach.notifyLevelWin(200);
    expect(unlockedIds(ach)).toContain('classic_l200');
  });

  it('unlocks nothing below level 10', async () => {
    const { ach } = await fresh();
    ach.notifyLevelWin(9);
    expect(unlockedIds(ach)).toEqual([]);
  });
});

describe('notifyMode', () => {
  it('unlocks the first-play achievement for each mode', async () => {
    const { ach } = await fresh();
    ach.notifyMode('zen');
    ach.notifyMode('daily');
    ach.notifyMode('blitz');
    ach.notifyMode('puzzle');
    expect(unlockedIds(ach).sort()).toEqual(['first_blitz', 'first_daily', 'first_puzzle', 'first_zen']);
  });

  it('ignores an unknown mode', async () => {
    const { ach } = await fresh();
    ach.notifyMode('classic');
    expect(unlockedIds(ach)).toEqual([]);
  });
});

describe('notifyZenScore', () => {
  it('unlocks the 10k tier at 10,000', async () => {
    const { ach } = await fresh();
    ach.notifyZenScore(10000);
    expect(unlockedIds(ach)).toEqual(['score_zen_10k']);
  });

  it('unlocks both tiers at 100,000', async () => {
    const { ach } = await fresh();
    ach.notifyZenScore(100000);
    expect(unlockedIds(ach).sort()).toEqual(['score_zen_100k', 'score_zen_10k']);
  });

  it('unlocks nothing below 10,000', async () => {
    const { ach } = await fresh();
    ach.notifyZenScore(9999);
    expect(unlockedIds(ach)).toEqual([]);
  });
});

describe('unlock short-circuit + consumeToast', () => {
  it('returns null when there is nothing queued', async () => {
    const { ach } = await fresh();
    expect(ach.consumeToast()).toBeNull();
  });

  it('does not re-queue or re-stamp an already-unlocked achievement', async () => {
    const { ach } = await fresh();
    ach.notifyMode('zen');                                 // unlock → queue 1 toast
    const firstAt = ach.summary().unlockedSet.first_zen.at;

    ach.notifyMode('zen');                                 // isUnlocked → short-circuits
    expect(ach.summary().unlockedSet.first_zen.at).toBe(firstAt);   // not re-stamped

    const t = ach.consumeToast();
    expect(t).toMatchObject({ id: 'first_zen', nameKey: 'achievement.first_zen.name', icon: '🧘' });
    expect(ach.consumeToast()).toBeNull();                 // only one toast ever queued
  });

  it('stamps shownAt on the unlock record when a toast is consumed', async () => {
    const { ach } = await fresh();
    ach.notifyMode('daily');
    expect(ach.summary().unlockedSet.first_daily.shownAt).toBeNull();
    ach.consumeToast();
    expect(ach.summary().unlockedSet.first_daily.shownAt).toEqual(expect.any(String));
  });

  it('drops a queued toast whose unlock record was wiped underneath it', async () => {
    const { storage, ach } = await fresh();
    ach.notifyMode('zen');             // queue a toast + persist the unlock
    storage.reset();                    // wipe unlocked; the toast lingers in the module queue
    const t = ach.consumeToast();       // toast present, but no record to stamp (if(rec) === false)
    expect(t).toMatchObject({ id: 'first_zen' });
    expect(ach.summary().unlockedSet.first_zen).toBeUndefined();
  });
});

describe('hydrateUnshownToasts (re-queue owed toasts on load)', () => {
  it('re-queues only the unshown, valid unlocks and skips the rest', async () => {
    const { ach } = await fresh({
      counters: { totalMatches: 0 },
      unlocked: {
        first_match:  null,                                          // null record → skip
        matches_100:  { at: 'x' },                                   // legacy (no shownAt) → skip
        matches_1000: { at: 'x', shownAt: '2020-01-01T00:00:00.000Z' }, // already shown → skip
        cascade_3:    { at: 'x', shownAt: null },                    // owed → re-queue (1st)
        cascade_5:    { at: 'x', shownAt: null },                    // owed → re-queue (2nd: exercises queue scan)
        bogus_id:     { at: 'x', shownAt: null },                    // owed but unknown id → skip
      },
    });

    // First state access triggers hydrate; toasts come out in object-key order.
    expect(ach.consumeToast()).toMatchObject({ id: 'cascade_3' });
    expect(ach.consumeToast()).toMatchObject({ id: 'cascade_5' });
    expect(ach.consumeToast()).toBeNull();
  });

  it('does nothing when there are no persisted unlocks', async () => {
    const { ach } = await fresh({ counters: { totalMatches: 0 }, unlocked: {} });
    expect(ach.consumeToast()).toBeNull();
    expect(ach.summary().unlocked).toBe(0);
  });
});
