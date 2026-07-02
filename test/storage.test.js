import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// storage.js is a singleton with module-level cache + debounce timer + a
// _readOnly latch, so each scenario re-imports it fresh via resetModules. Set
// localStorage BEFORE importing so load() reads the blob we want.
async function fresh(raw) {
  vi.resetModules();
  const config = await import('../src/config.js');
  if (raw !== undefined) localStorage.setItem(config.STORAGE_KEY, raw);
  const storage = await import('../src/storage.js');
  return { storage, KEY: config.STORAGE_KEY, VERSION: config.STORAGE_VERSION };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('load()', () => {
  it('returns a fresh default state when nothing is stored', async () => {
    const { storage, VERSION } = await fresh();
    const s = storage.load();
    expect(s.version).toBe(VERSION);
    expect(s.classic.highestUnlocked).toBe(1);
    expect(s.settings.language).toBe('auto');
  });

  it('caches: a second load() returns the same object', async () => {
    const { storage } = await fresh();
    expect(storage.load()).toBe(storage.load());
  });

  it('falls back to defaults when localStorage is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { storage } = await fresh();
    expect(storage.load().version).toBeDefined();
  });

  it('deep-merges a stored blob, backfilling new default keys', async () => {
    const { storage } = await fresh(JSON.stringify({
      version: 1,
      settings: { haptic: false },
      zen: { bestScore: 42 },
    }));
    const s = storage.load();
    expect(s.settings.haptic).toBe(false);     // preserved
    expect(s.settings.language).toBe('auto');  // backfilled default
    expect(s.zen.bestScore).toBe(42);
    expect(s.zen.totalRunsPlayed).toBe(0);     // backfilled default
  });

  it('treats a pre-versioned (missing version) blob as current and stamps it forward', async () => {
    const { storage, KEY, VERSION } = await fresh(JSON.stringify({ zen: { bestScore: 7 } }));
    const s = storage.load();
    expect(s.zen.bestScore).toBe(7);
    expect(s.version).toBe(VERSION);
    // load() called saveAll() to persist the stamped version.
    expect(JSON.parse(localStorage.getItem(KEY)).version).toBe(VERSION);
  });

  it('treats version 0 / NaN as pre-versioned', async () => {
    const { storage, VERSION } = await fresh(JSON.stringify({ version: 0, daily: { bestEver: 3 } }));
    const s = storage.load();
    expect(s.daily.bestEver).toBe(3);
    expect(s.version).toBe(VERSION);
  });

  it('runs read-only against a future-version blob and never overwrites it', async () => {
    const future = JSON.stringify({ version: 999, zen: { bestScore: 12345 } });
    const { storage, KEY } = await fresh(future);
    const s = storage.load();
    expect(s.zen.bestScore).toBe(0);            // ran on defaults, not the future blob
    storage.saveKey('zen', { bestScore: 1 });   // a write through the debounce...
    storage.flush();
    expect(localStorage.getItem(KEY)).toBe(future); // ...is suppressed; blob untouched
    storage.saveAll();                           // ...and a direct save (no pending timer)
    expect(localStorage.getItem(KEY)).toBe(future); // is suppressed too
  });

  it('resets to defaults on corrupt JSON', async () => {
    const { storage } = await fresh('{not json');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = storage.load();
    expect(s.classic.highestUnlocked).toBe(1);
    expect(warn).toHaveBeenCalled();
  });

  it('keeps the structured default when a stored sub-key is null', async () => {
    const { storage } = await fresh(JSON.stringify({ version: 1, settings: null }));
    expect(storage.load().settings.language).toBe('auto');
  });

  it('keeps the structured default when a stored sub-key has a mismatched scalar type', async () => {
    const { storage } = await fresh(JSON.stringify({ version: 1, settings: 'corrupt' }));
    expect(storage.load().settings.language).toBe('auto');
  });

  it('ignores prototype-polluting keys (__proto__, constructor, prototype)', async () => {
    const { storage } = await fresh(
      '{"version":1,"__proto__":{"polluted":true},"constructor":1,"prototype":2,"settings":{"haptic":false}}',
    );
    storage.load();
    expect({}.polluted).toBeUndefined();
    expect(storage.getSettings().haptic).toBe(false);
  });

  it('keeps keys present in the stored blob but absent from defaults', async () => {
    const { storage } = await fresh(JSON.stringify({ version: 1, legacyFlag: 7, zen: { extra: 'x' } }));
    const s = storage.load();
    expect(s.legacyFlag).toBe(7);       // unknown top-level key preserved
    expect(s.zen.extra).toBe('x');      // unknown nested key preserved
  });

  it('does not re-save when the stored blob is already current', async () => {
    const blob = JSON.stringify({
      version: 1, profile: { playerName: 'X', createdAt: 'x', lastPlayedMode: null },
    });
    const { storage, KEY } = await fresh(blob);
    storage.load();
    // Same version → no migration, no forced save: array of merged defaults is
    // returned but the on-disk blob is left as we wrote it (no saveAll call).
    expect(JSON.parse(localStorage.getItem(KEY)).profile.playerName).toBe('X');
  });
});

describe('migration fallback', () => {
  // Drive the fromVersion < STORAGE_VERSION branch by pretending the current
  // schema is v2 (storage.js ships no v1->v2 step, so this exercises the
  // "missing migration => preserve data via deepMerge" safety path + archive).
  it('archives the blob and deep-merges when a migration step is missing', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', async () => ({
      ...(await vi.importActual('../src/config.js')),
      STORAGE_VERSION: 2,
    }));
    try {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const config = await import('../src/config.js');
      expect(config.STORAGE_VERSION).toBe(2);
      localStorage.setItem(config.STORAGE_KEY, JSON.stringify({ version: 1, zen: { bestScore: 5 } }));
      const storage = await import('../src/storage.js');
      const s = storage.load();
      expect(s.zen.bestScore).toBe(5);   // data preserved through the fallback
      expect(s.version).toBe(2);          // stamped forward
      expect(warn).toHaveBeenCalled();    // logged the missing-step warning
      expect(localStorage.getItem(`${config.STORAGE_KEY}:v1:archive`)).toBeTruthy();
    } finally {
      vi.doUnmock('../src/config.js');
    }
  });

  it('applies a defined migration step and stamps the version forward', async () => {
    vi.resetModules();
    vi.doMock('../src/config.js', async () => ({
      ...(await vi.importActual('../src/config.js')),
      STORAGE_VERSION: 2,
    }));
    // MIGRATIONS is deliberately module-private (nothing exported to mutate),
    // so inject the v1→v2 step through the prototype chain instead: the
    // literal has no own [1], making `MIGRATIONS[1]` fall through to
    // Object.prototype. Non-enumerable so no spread / for-in anywhere can see
    // it; removed in finally.
    Object.defineProperty(Object.prototype, 1, {
      value: (v1) => ({ ...v1, zen: { ...v1.zen, migratedBadge: true } }),
      configurable: true,
      writable: true,
      enumerable: false,
    });
    try {
      const config = await import('../src/config.js');
      localStorage.setItem(config.STORAGE_KEY, JSON.stringify({ version: 1, zen: { bestScore: 5 } }));
      const storage = await import('../src/storage.js');
      const s = storage.load();
      expect(s.zen.bestScore).toBe(5);          // data carried through the step
      expect(s.zen.migratedBadge).toBe(true);   // the step actually ran
      expect(s.version).toBe(2);                // stamped forward by the loop
      // The pre-migration blob was archived before the step ran.
      expect(JSON.parse(localStorage.getItem(`${config.STORAGE_KEY}:v1:archive`)).version).toBe(1);
    } finally {
      delete Object.prototype[1];
      vi.doUnmock('../src/config.js');
    }
  });
});

describe('saveKey / debounce / flush', () => {
  it('patches a sub-key and persists after the debounce window', async () => {
    const { storage, KEY } = await fresh();
    vi.useFakeTimers();
    storage.saveKey('settings', { haptic: false });
    expect(localStorage.getItem(KEY)).toBeNull();      // not yet written
    vi.advanceTimersByTime(250);
    expect(JSON.parse(localStorage.getItem(KEY)).settings.haptic).toBe(false);
  });

  it('coalesces multiple writes into a single timer', async () => {
    const { storage, KEY } = await fresh();
    vi.useFakeTimers();
    storage.saveKey('settings', { haptic: false });
    storage.saveKey('settings', { eyes: false });      // reuses the pending timer
    vi.advanceTimersByTime(250);
    const s = JSON.parse(localStorage.getItem(KEY)).settings;
    expect(s.haptic).toBe(false);
    expect(s.eyes).toBe(false);
  });

  it('flush() forces a pending write through synchronously', async () => {
    const { storage, KEY } = await fresh();
    vi.useFakeTimers();
    storage.saveKey('settings', { haptic: false });
    storage.flush();
    expect(JSON.parse(localStorage.getItem(KEY)).settings.haptic).toBe(false);
  });

  it('flush() is a no-op when nothing is dirty', async () => {
    const { storage, KEY } = await fresh();
    storage.flush();
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('warns but does not throw when setItem fails (quota)', async () => {
    const { storage } = await fresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota'); });
    expect(() => { storage.saveKey('settings', { haptic: false }); storage.flush(); }).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe('reset()', () => {
  it('wipes cache and stored blob and re-enables writes', async () => {
    const { storage, KEY } = await fresh(JSON.stringify({ version: 1, zen: { bestScore: 99 } }));
    storage.load();
    storage.reset();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(storage.load().zen.bestScore).toBe(0);
  });

  it('clears a pending debounced write', async () => {
    const { storage, KEY } = await fresh();
    vi.useFakeTimers();
    storage.saveKey('settings', { haptic: false });
    storage.reset();
    vi.advanceTimersByTime(250);
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('warns but does not throw when removeItem fails', async () => {
    const { storage } = await fresh();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => { throw new Error('boom'); });
    expect(() => storage.reset()).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });

  it('is a no-op on localStorage when storage is unavailable', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { storage } = await fresh();
    expect(() => storage.reset()).not.toThrow();
  });
});

describe('convenience getters + recordPlayDay', () => {
  it('getSettings / getProfile read through load()', async () => {
    const { storage } = await fresh();
    expect(storage.getSettings()).toBe(storage.load().settings);
    expect(storage.getProfile()).toBe(storage.load().profile);
  });

  it('recordPlayDay creates then increments today\'s entry', async () => {
    const { storage } = await fresh();
    storage.recordPlayDay(100);
    storage.recordPlayDay(50);
    const hist = Object.values(storage.load().playHistory);
    expect(hist).toHaveLength(1);
    expect(hist[0]).toEqual({ runs: 2, totalScore: 150 });
  });

  it('recordPlayDay defaults the score delta to 0', async () => {
    const { storage } = await fresh();
    storage.recordPlayDay();
    expect(Object.values(storage.load().playHistory)[0]).toEqual({ runs: 1, totalScore: 0 });
  });
});

describe('saveAll when storage unavailable', () => {
  it('returns early without throwing', async () => {
    vi.stubGlobal('localStorage', undefined);
    const { storage } = await fresh();
    storage.saveKey('settings', { haptic: false });
    expect(() => storage.flush()).not.toThrow();
  });
});

describe('saveAll() called before any load()', () => {
  it('lazily initialises the default cache', async () => {
    const { storage, KEY, VERSION } = await fresh();
    storage.saveAll();   // cache is still null here -> defaultState()
    expect(JSON.parse(localStorage.getItem(KEY)).version).toBe(VERSION);
  });
});

describe('defaultState additions', () => {
  it('pins the newer default leaves: sound, gemStyle, undo charge, zen gallery', async () => {
    const { storage } = await fresh();
    const s = storage.load();
    expect(s.settings.sound).toBe(true);
    expect(s.settings.gemStyle).toBe('color');
    expect(s.powerups.charges).toEqual({ shuffle: 0, colorBlast: 0, bombDrop: 0, recolor: 0, undo: 0 });
    expect(s.zen.gallery).toEqual([]);
  });
});

describe('exportString / importString', () => {
  // 'JWLD1.' is the wire-format contract for portable save codes — hardcoded
  // here on purpose so an accidental prefix change in storage.js fails a test.
  const PREFIX = 'JWLD1.';
  // Build a code around an ASCII JSON payload (btoa alone is latin1-only;
  // storage.js goes through TextEncoder for the general unicode case).
  const codeOf = (json) => PREFIX + btoa(json);

  it('exportString emits PREFIX + base64(JSON of the live state)', async () => {
    const { storage, VERSION } = await fresh();
    const code = storage.exportString();
    expect(code.startsWith(PREFIX)).toBe(true);
    const decoded = JSON.parse(atob(code.slice(PREFIX.length)));   // default state is pure ASCII
    expect(decoded.version).toBe(VERSION);
    expect(decoded.settings.gemStyle).toBe('color');
  });

  it('roundtrips: export → reset → import restores state, unicode intact', async () => {
    const { storage, KEY } = await fresh();
    storage.saveKey('profile', { playerName: 'Ana☃|x' });   // non-latin1 char exercises the TextEncoder path
    storage.saveKey('zen', { bestScore: 777 });
    const code = storage.exportString();                     // exports the live cache, pending debounce and all

    storage.reset();
    expect(storage.load().zen.bestScore).toBe(0);            // really gone

    expect(storage.importString(`  ${code}\n`)).toEqual({ ok: true });  // surrounding whitespace is trimmed
    const s = storage.load();
    expect(s.profile.playerName).toBe('Ana☃|x');
    expect(s.zen.bestScore).toBe(777);
    // importString saveAll()s immediately — persisted without any flush().
    expect(JSON.parse(localStorage.getItem(KEY)).profile.playerName).toBe('Ana☃|x');
  });

  it('rejects a missing / unprefixed code with reason "format"', async () => {
    const { storage, KEY } = await fresh();
    expect(storage.importString()).toEqual({ ok: false, reason: 'format' });
    expect(storage.importString('   ')).toEqual({ ok: false, reason: 'format' });
    expect(storage.importString('GEMS1.' + btoa('{}'))).toEqual({ ok: false, reason: 'format' });
    expect(localStorage.getItem(KEY)).toBeNull();            // failed imports never save
  });

  it('rejects corrupt base64 and non-JSON payloads with reason "parse"', async () => {
    const { storage } = await fresh();
    expect(storage.importString(`${PREFIX}%%%not base64%%%`)).toEqual({ ok: false, reason: 'parse' });
    expect(storage.importString(codeOf('{not json'))).toEqual({ ok: false, reason: 'parse' });
  });

  it('rejects well-formed JSON that is not a plausible save with reason "shape"', async () => {
    const { storage, KEY } = await fresh();
    expect(storage.importString(codeOf('null'))).toEqual({ ok: false, reason: 'shape' });            // null
    expect(storage.importString(codeOf('"progress"'))).toEqual({ ok: false, reason: 'shape' });      // not an object
    expect(storage.importString(codeOf('{"settings":{}}'))).toEqual({ ok: false, reason: 'shape' }); // missing profile
    expect(storage.importString(codeOf('{"profile":{}}'))).toEqual({ ok: false, reason: 'shape' });  // missing settings
    expect(localStorage.getItem(KEY)).toBeNull();            // failed imports never save
  });

  it('deep-merges the import over defaults, backfilling missing leaf keys', async () => {
    const { storage, VERSION } = await fresh();
    const res = storage.importString(codeOf(JSON.stringify({
      version: 999,                                    // stamped back to current, not trusted
      profile: { playerName: 'P' },                    // missing createdAt / lastPlayedMode
      settings: { haptic: false },                     // missing every newer settings leaf
      zen: { bestScore: 9 },                           // missing gallery / saveState / ...
    })));
    expect(res).toEqual({ ok: true });
    const s = storage.load();
    expect(s.version).toBe(VERSION);
    expect(s.profile.playerName).toBe('P');
    expect(s.profile.lastPlayedMode).toBeNull();       // backfilled
    expect(s.settings.haptic).toBe(false);             // imported value wins
    expect(s.settings.sound).toBe(true);               // backfilled new defaults
    expect(s.settings.gemStyle).toBe('color');
    expect(s.settings.language).toBe('auto');
    expect(s.zen.bestScore).toBe(9);
    expect(s.zen.gallery).toEqual([]);                 // backfilled
    expect(s.powerups.charges.undo).toBe(0);           // whole missing subtree backfilled
  });

  it('clears the future-version read-only latch so the import and later saves persist', async () => {
    const future = JSON.stringify({ version: 999, zen: { bestScore: 12345 } });
    const { storage, KEY } = await fresh(future);
    storage.load();                                    // future blob → this session went read-only
    storage.saveAll();
    expect(localStorage.getItem(KEY)).toBe(future);    // latch engaged: write suppressed

    const res = storage.importString(codeOf('{"profile":{"playerName":"Imp"},"settings":{}}'));
    expect(res).toEqual({ ok: true });
    // importString itself persisted (its saveAll ran un-suppressed)...
    expect(JSON.parse(localStorage.getItem(KEY)).profile.playerName).toBe('Imp');
    // ...and the latch stays cleared for later writes too.
    storage.saveKey('zen', { bestScore: 5 });
    storage.flush();
    expect(JSON.parse(localStorage.getItem(KEY)).zen.bestScore).toBe(5);
  });

  it('filters prototype-polluting keys out of an imported blob', async () => {
    const { storage } = await fresh();
    const res = storage.importString(codeOf(
      '{"profile":{"playerName":"safe"},"settings":{"haptic":false},"__proto__":{"polluted":true},"constructor":1,"prototype":2}',
    ));
    expect(res).toEqual({ ok: true });
    expect({}.polluted).toBeUndefined();
    const s = storage.load();
    expect(Object.prototype.hasOwnProperty.call(s, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(s, 'prototype')).toBe(false);
    expect(s.profile.playerName).toBe('safe');
    expect(s.settings.haptic).toBe(false);
  });
});
