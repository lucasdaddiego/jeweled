import { describe, it, expect, afterEach, vi } from 'vitest';

// i18n.js is a stateful singleton: module-level `_setting` / `_locale` plus
// Intl + interpolation caches. Each scenario re-imports it (and the storage
// singleton it reads settings from) fresh via resetModules so locale state
// starts clean. Import storage first so i18n's `import * as storage` resolves to
// the same fresh instance, letting storage.saveKey() seed what init() reads.
async function fresh() {
  vi.resetModules();
  const storage = await import('../src/storage.js');
  const i18n = await import('../src/i18n.js');
  return { storage, i18n };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();   // required: config doesn't auto-unstub globals
  vi.restoreAllMocks();
});

describe('init() — locale from settings', () => {
  it('resolves directly from settings.language === "en"', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'en' });
    i18n.init();
    expect(i18n.getLanguageSetting()).toBe('en');
    expect(i18n.getLocale()).toBe('en');
    expect(i18n.t('common.start')).toBe('Start');
  });

  it('resolves directly from settings.language === "es"', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'es' });
    i18n.init();
    expect(i18n.getLanguageSetting()).toBe('es');
    expect(i18n.getLocale()).toBe('es');
    expect(i18n.t('common.start')).toBe('Comenzar');
  });

  it('treats a falsy settings.language as "auto" and resolves via navigator', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: '' });   // falsy → `|| 'auto'`
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    vi.stubGlobal('navigator', { languages: ['es-MX'] });
    i18n.init();
    expect(i18n.getLanguageSetting()).toBe('auto');
    expect(i18n.getLocale()).toBe('es');
  });

  it('keeps <html lang> in sync with the resolved locale', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'es' });
    i18n.init();
    expect(document.documentElement.lang).toBe('es');
  });
});

describe('resolveLocale() — "auto" resolution', () => {
  function autoInit(i18n, loc, nav) {
    vi.stubGlobal('location', loc);
    vi.stubGlobal('navigator', nav);
    i18n.init();   // settings default to language:'auto'
  }

  it('honors ?lang=en on localhost (URL override beats navigator)', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'localhost', search: '?lang=en' }, { languages: ['es-AR'] });
    expect(i18n.getLocale()).toBe('en');
  });

  it('honors ?lang=es on 127.0.0.1', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: '127.0.0.1', search: '?lang=es' }, { languages: ['en-US'] });
    expect(i18n.getLocale()).toBe('es');
  });

  it('ignores an unrecognized ?lang value and falls through to navigator', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'localhost', search: '?lang=fr' }, { languages: ['es-AR'] });
    expect(i18n.getLocale()).toBe('es');
  });

  it('ignores ?lang off-localhost (override is localhost-gated)', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '?lang=es' }, { languages: ['en-US'] });
    expect(i18n.getLocale()).toBe('en');
  });

  it('resolves es from a navigator language starting with "es"', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '' }, { languages: ['es-ES', 'en'] });
    expect(i18n.getLocale()).toBe('es');
  });

  it('resolves en from a navigator language starting with "en"', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '' }, { languages: ['en-GB'] });
    expect(i18n.getLocale()).toBe('en');
  });

  it('skips falsy entries in navigator.languages', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '' }, { languages: ['', 'es-MX'] });
    expect(i18n.getLocale()).toBe('es');
  });

  it('falls back to en when no listed language matches', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '' }, { languages: ['fr-FR', 'de'] });
    expect(i18n.getLocale()).toBe('en');
  });

  it('falls back to en when navigator.languages is absent', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '' }, {});   // → `|| []`
    expect(i18n.getLocale()).toBe('en');
  });

  it('tolerates a missing navigator', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, { hostname: 'jeweled.example.com', search: '' }, undefined);
    expect(i18n.getLocale()).toBe('en');
  });

  it('tolerates a missing location (skips the URL override block)', async () => {
    const { i18n } = await fresh();
    autoInit(i18n, undefined, { languages: ['es-AR'] });
    expect(i18n.getLocale()).toBe('es');
  });
});

describe('t()', () => {
  async function withLocale(lang) {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: lang });
    i18n.init();
    return i18n;
  }

  it('looks up a key in the active locale (en)', async () => {
    const i18n = await withLocale('en');
    expect(i18n.t('settings.title')).toBe('Settings');
  });

  it('looks up a key in the active locale (es)', async () => {
    const i18n = await withLocale('es');
    expect(i18n.t('settings.title')).toBe('Ajustes');
  });

  it('falls back to the en string for a key missing in es', async () => {
    const i18n = await withLocale('es');
    expect(i18n.t('title.brand')).toBe('JEWELED');   // intentionally untranslated in es
  });

  it('falls back to the key itself when missing everywhere', async () => {
    const i18n = await withLocale('es');
    expect(i18n.t('totally.unknown.key')).toBe('totally.unknown.key');
  });

  it('interpolates {vars} (en)', async () => {
    const i18n = await withLocale('en');
    expect(i18n.t('classic.level', { n: 5 })).toBe('Level 5');
  });

  it('interpolates {vars} (es)', async () => {
    const i18n = await withLocale('es');
    expect(i18n.t('classic.level', { n: 5 })).toBe('Nivel 5');
  });

  it('returns the raw string when no vars are passed', async () => {
    const i18n = await withLocale('en');
    expect(i18n.t('common.cancel')).toBe('Cancel');
  });

  it('returns the plural "other" form when t() is used on a plural entry', async () => {
    const i18n = await withLocale('en');
    expect(i18n.t('puzzleSelect.tileMoves')).toBe('{n} moves');   // lookup() → raw.other
  });

  it('warns (dev) and returns "" for a null/undefined key', async () => {
    const i18n = await withLocale('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(i18n.t(null)).toBe('');
    expect(i18n.t(undefined)).toBe('');
    expect(warn).toHaveBeenCalled();
  });
});

describe('tn()', () => {
  async function withLocale(lang) {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: lang });
    i18n.init();
    return i18n;
  }

  it('selects the singular form for count === 1 (en)', async () => {
    const i18n = await withLocale('en');
    expect(i18n.tn('puzzleSelect.tileMoves', 1)).toBe('1 move');
  });

  it('selects the plural form for count !== 1 (en)', async () => {
    const i18n = await withLocale('en');
    expect(i18n.tn('puzzleSelect.tileMoves', 5)).toBe('5 moves');
  });

  it('selects singular/plural forms (es)', async () => {
    const i18n = await withLocale('es');
    expect(i18n.tn('puzzleSelect.tileMoves', 1)).toBe('1 movimiento');
    expect(i18n.tn('puzzleSelect.tileMoves', 3)).toBe('3 movimientos');
  });

  it('merges extra vars alongside the auto-injected n', async () => {
    const i18n = await withLocale('en');
    expect(i18n.tn('puzzleSelect.tileMoves', 2, { foo: 'bar' })).toBe('2 moves');
  });

  it('delegates to t() for a non-plural (string) entry — no vars', async () => {
    const i18n = await withLocale('en');
    expect(i18n.tn('common.ok', 2)).toBe('OK');
    expect(i18n.tn('classic.level', 4)).toBe('Level 4');   // n injected through t()
  });

  it('delegates to t() with extra vars for a string entry', async () => {
    const i18n = await withLocale('en');
    expect(i18n.tn('classic.level', 9, { foo: 1 })).toBe('Level 9');
  });

  it('delegates to t() (returning the key) for a missing entry', async () => {
    const i18n = await withLocale('en');
    expect(i18n.tn('no.such.plural', 2)).toBe('no.such.plural');
  });

  it('warns (dev) and returns "" for a null key', async () => {
    const i18n = await withLocale('en');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(i18n.tn(null, 3)).toBe('');
    expect(warn).toHaveBeenCalled();
  });
});

describe('interpolate() — caching & missing vars', () => {
  async function en() {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'en' });
    i18n.init();
    return i18n;
  }

  it('substitutes {name} from vars', async () => {
    const i18n = await en();
    expect(i18n.t('title.welcomeBack', { name: 'Lu' })).toBe('Welcome back, Lu');
  });

  it('leaves a placeholder without a matching var untouched', async () => {
    const i18n = await en();
    expect(i18n.t('title.welcomeBack', { other: 'x' })).toBe('Welcome back, {name}');
  });

  it('returns a cached interpolation on repeat calls', async () => {
    const i18n = await en();
    expect(i18n.t('classic.level', { n: 7 })).toBe('Level 7');
    expect(i18n.t('classic.level', { n: 7 })).toBe('Level 7');   // cache hit
  });

  it('handles an empty vars object (loop body not entered)', async () => {
    const i18n = await en();
    expect(i18n.t('common.ok', {})).toBe('OK');
  });

  it('evicts the cache once it grows past 256 distinct entries', async () => {
    const i18n = await en();
    for (let n = 0; n < 300; n++) expect(i18n.t('classic.level', { n })).toBe(`Level ${n}`);
    expect(i18n.t('classic.level', { n: 5 })).toBe('Level 5');   // still correct after eviction
  });
});

describe('formatNumber()', () => {
  it('groups digits with commas (en)', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'en' });
    i18n.init();
    expect(i18n.formatNumber(1234567)).toBe('1,234,567');
  });

  it('groups digits per the es locale (dots, not commas)', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'es' });
    i18n.init();
    const es = i18n.formatNumber(1234567);
    expect(es).toBe('1.234.567');
    expect(es).not.toBe('1,234,567');
  });

  it('falls back to String(n) before init() builds a formatter', async () => {
    const { i18n } = await fresh();
    expect(i18n.formatNumber(1234567)).toBe('1234567');
  });
});

describe('formatDate()', () => {
  async function en() {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'en' });
    i18n.init();
    return i18n;
  }

  it('formats a Date with the default medium style (en)', async () => {
    const i18n = await en();
    const out = i18n.formatDate(new Date(2024, 0, 15));
    expect(out).toContain('Jan');
    expect(out).toContain('15');
    expect(out).toContain('2024');
  });

  it('formats a Date with the default medium style (es)', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'es' });
    i18n.init();
    const out = i18n.formatDate(new Date(2024, 0, 15));
    expect(out).toMatch(/ene/i);
    expect(out).toContain('15');
    expect(out).toContain('2024');
  });

  it('parses a YYYY-MM-DD string as a local date', async () => {
    const i18n = await en();
    const out = i18n.formatDate('2024-03-15');
    expect(out).toContain('Mar');
    expect(out).toContain('15');
    expect(out).toContain('2024');
  });

  it('accepts a numeric timestamp', async () => {
    const i18n = await en();
    expect(i18n.formatDate(Date.UTC(2024, 5, 15, 12))).toContain('2024');
  });

  it('returns the stringified input for an unparseable date string', async () => {
    const i18n = await en();
    expect(i18n.formatDate('not-a-date')).toBe('not-a-date');
  });

  it('returns "" for an undefined date (date ?? "")', async () => {
    const i18n = await en();
    expect(i18n.formatDate(undefined)).toBe('');
  });

  it('falls back to String(date) before init() builds a formatter', async () => {
    const { i18n } = await fresh();
    const d = new Date(2024, 0, 1);
    expect(i18n.formatDate(d)).toBe(String(d));
  });

  it('memoizes opts-based formatters (cache miss, then hit)', async () => {
    const i18n = await en();
    const d = new Date(2024, 0, 15);
    expect(i18n.formatDate(d, { year: 'numeric' })).toBe('2024');
    expect(i18n.formatDate(d, { year: 'numeric' })).toBe('2024');   // reuses cached formatter
  });

  it('returns String(date) when normalization yields a non-Date (defensive guard)', async () => {
    const { i18n } = await fresh();
    // Replace Date so normalizeDateInput's `new Date(date)` produces a non-Date,
    // exercising the otherwise-dead `!(normalized instanceof Date)` guard. The
    // `||` short-circuits before getTime(), so the plain object never crashes.
    vi.stubGlobal('Date', class { constructor() { return {}; } });
    expect(i18n.formatDate(5)).toBe('5');
  });
});

describe('setLanguage() & getters', () => {
  it('switches locale and persists on a valid, different value', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'en' });
    i18n.init();
    expect(i18n.getLocale()).toBe('en');

    i18n.setLanguage('es');
    expect(i18n.getLanguageSetting()).toBe('es');
    expect(i18n.getLocale()).toBe('es');
    expect(i18n.t('common.ok')).toBe('Aceptar');
    expect(storage.getSettings().language).toBe('es');
    expect(document.documentElement.lang).toBe('es');
  });

  it('persists the setting but skips the rebuild when the resolved locale is unchanged', async () => {
    const { storage, i18n } = await fresh();
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    vi.stubGlobal('navigator', { languages: ['en-US'] });
    i18n.init();                       // setting 'auto' → locale 'en'
    expect(i18n.getLanguageSetting()).toBe('auto');

    i18n.setLanguage('en');            // resolves to 'en' === current locale
    expect(i18n.getLanguageSetting()).toBe('en');
    expect(i18n.getLocale()).toBe('en');
    expect(storage.getSettings().language).toBe('en');
  });

  it('accepts "auto" and re-resolves the locale via navigator', async () => {
    const { storage, i18n } = await fresh();
    storage.saveKey('settings', { language: 'en' });
    i18n.init();                       // locale 'en' (explicit, navigator not read)
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    vi.stubGlobal('navigator', { languages: ['es-AR'] });

    i18n.setLanguage('auto');          // valid; navigator → 'es' → locale changes
    expect(i18n.getLanguageSetting()).toBe('auto');
    expect(i18n.getLocale()).toBe('es');
    expect(storage.getSettings().language).toBe('auto');
  });

  it('ignores an out-of-range value (no change, no persist)', async () => {
    const { storage, i18n } = await fresh();
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    vi.stubGlobal('navigator', { languages: ['en-US'] });
    i18n.init();                       // setting 'auto'

    i18n.setLanguage('fr');            // invalid → early return before any mutation
    expect(i18n.getLanguageSetting()).toBe('auto');
    expect(i18n.getLocale()).toBe('en');
    expect(storage.getSettings().language).toBe('auto');
  });
});

describe('syncDocumentLang() — defensive paths', () => {
  it('tolerates a missing document', async () => {
    const { i18n } = await fresh();
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    vi.stubGlobal('navigator', { languages: ['en-US'] });
    vi.stubGlobal('document', undefined);
    expect(() => i18n.init()).not.toThrow();
    expect(i18n.getLocale()).toBe('en');
  });

  it('tolerates a document without a documentElement', async () => {
    const { i18n } = await fresh();
    vi.stubGlobal('location', { hostname: 'jeweled.example.com', search: '' });
    vi.stubGlobal('navigator', { languages: ['es-ES'] });
    vi.stubGlobal('document', { documentElement: null });
    expect(() => i18n.init()).not.toThrow();
    expect(i18n.getLocale()).toBe('es');
  });
});

describe('warnDev() — dev-only logging gate', () => {
  it('logs on localhost', async () => {
    const { i18n } = await fresh();
    vi.stubGlobal('location', { hostname: 'localhost', search: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    i18n.t(null);
    expect(warn).toHaveBeenCalledWith('i18n.t() called with empty key');
  });

  it('logs on 127.0.0.1', async () => {
    const { i18n } = await fresh();
    vi.stubGlobal('location', { hostname: '127.0.0.1', search: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    i18n.tn(null, 1);
    expect(warn).toHaveBeenCalledWith('i18n.tn() called with empty key');
  });

  it('stays silent on a production host', async () => {
    const { i18n } = await fresh();
    vi.stubGlobal('location', { hostname: 'jeweled.daddiego.com.ar', search: '' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    i18n.t(null);
    expect(warn).not.toHaveBeenCalled();
  });

  it('stays silent when location is undefined', async () => {
    const { i18n } = await fresh();
    vi.stubGlobal('location', undefined);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    i18n.t(null);
    expect(warn).not.toHaveBeenCalled();
  });
});
