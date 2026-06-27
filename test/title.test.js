import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// title.js imports ../main.js (setScene, clockMs). Mock it (hoisted) so importing
// the scene doesn't boot the whole game under jsdom. clockMs is constant so the
// brand-title shimmer math is deterministic.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as i18n from '../src/i18n.js';
import * as dialogs from '../src/dialogs.js';
import { setScene } from '../src/main.js';
import { todayISO } from '../src/rng.js';
import { NAME_MAX_LEN } from '../src/config.js';
import { PUZZLES } from '../src/puzzles.js';
import * as title from '../src/scenes/title.js';

// vitest config sets clearMocks + restoreMocks, so the setScene mock's call log
// and any vi.spyOn are reset/restored between tests automatically.

let renderSpy;

beforeEach(() => {
  // Clear any name-entry / settings state leaked from a prior test. The module
  // holds nameInputWrap/settingsOpen across tests; exit() nulls them out.
  title.exit();
  document.documentElement.style.removeProperty('--sab');
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
  i18n.init();
  // Spy that records every drawHitButton call while still drawing + pushing the
  // hit rect. arg[4]=label, arg[5]=onClick, arg[6]=the live buttons[] reference.
  renderSpy = vi.spyOn(render, 'drawHitButton');
});

// --- helpers ---------------------------------------------------------------

function seedName(name = 'Bob') {
  storage.load().profile.playerName = name;
  return storage.load();
}

// Rect of a button drawn via render.drawHitButton, located by its label.
function rectByLabel(label) {
  const c = renderSpy.mock.calls.find((cc) => cc[4] === label);
  if (!c) throw new Error(`no button labelled ${JSON.stringify(label)}`);
  return { x: c[0], y: c[1], w: c[2], h: c[3], onClick: c[5] };
}

// The live buttons[] array, read off the most recent drawHitButton call. After
// draw() returns it also contains rects pushed directly (toggles, pills, the
// view-source link) since they share the same array reference.
function liveButtons() {
  const calls = renderSpy.mock.calls;
  return calls[calls.length - 1][6];
}

function settingsRects() {
  return liveButtons().filter((b) => b.kind === 'settings');
}

function down(rect) {
  title.onPointer({ type: 'down', x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 });
}

// enter → draw → click Settings → redraw, returning the 7 settings-overlay rects
// in draw order: [haptic, paintingMode, autoPill, enPill, esPill, reset, close].
function openSettings() {
  title.enter();
  title.draw();
  down(rectByLabel(i18n.t('title.settings')));   // settingsOpen = true
  renderSpy.mockClear();
  title.draw();
  return settingsRects();
}

const flushMicro = () => new Promise((r) => setTimeout(r, 0));

// --- enter / exit ----------------------------------------------------------

describe('enter / exit', () => {
  it('first run (no saved name) opens the DOM name-entry modal', () => {
    title.enter();
    expect(document.getElementById('name-input-wrap')).toBeTruthy();
    expect(document.getElementById('name-input').maxLength).toBe(NAME_MAX_LEN);
  });

  it('returning player (saved name) does not open the name modal', () => {
    seedName('Ada');
    title.enter();
    expect(document.getElementById('name-input-wrap')).toBeNull();
  });

  it('exit() hides the name modal and is safe to call when none is open', () => {
    title.enter();                                   // creates the modal
    expect(document.getElementById('name-input-wrap')).toBeTruthy();
    title.exit();                                    // wrap present → removed
    expect(document.getElementById('name-input-wrap')).toBeNull();
    expect(() => title.exit()).not.toThrow();        // wrap null → no-op
  });

  it('showNameEntry is idempotent — a second enter() does not stack modals', () => {
    title.enter();
    title.enter();                                   // needsNameEntry still true
    expect(document.querySelectorAll('#name-input-wrap')).toHaveLength(1);
  });

  it('update(dt) is a no-op', () => {
    expect(() => title.update(16)).not.toThrow();
  });
});

// --- name entry modal ------------------------------------------------------

describe('name entry', () => {
  it('submitting a valid name saves it and closes the modal', () => {
    title.enter();
    const input = document.getElementById('name-input');
    input.value = 'Grace';
    document.getElementById('name-submit').click();
    expect(storage.getProfile().playerName).toBe('Grace');
    expect(document.getElementById('name-input-wrap')).toBeNull();
  });

  it('truncates an over-long name to NAME_MAX_LEN', () => {
    title.enter();
    const input = document.getElementById('name-input');
    input.value = 'X'.repeat(NAME_MAX_LEN + 9);
    document.getElementById('name-submit').click();
    expect(storage.getProfile().playerName).toHaveLength(NAME_MAX_LEN);
  });

  it('a blank / whitespace name is rejected (modal stays open, nothing saved)', () => {
    title.enter();
    const input = document.getElementById('name-input');
    input.value = '   ';
    document.getElementById('name-submit').click();
    expect(storage.getProfile().playerName).toBe('');
    expect(document.getElementById('name-input-wrap')).toBeTruthy();
  });

  it('Enter key commits; other keys do nothing', () => {
    title.enter();
    const input = document.getElementById('name-input');
    input.value = 'Lin';
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }));   // ignored
    expect(document.getElementById('name-input-wrap')).toBeTruthy();
    input.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Enter' }));
    expect(storage.getProfile().playerName).toBe('Lin');
    expect(document.getElementById('name-input-wrap')).toBeNull();
  });

  it('auto-focuses the input ~50ms after the modal opens', () => {
    vi.useFakeTimers();
    try {
      title.enter();
      const focusSpy = vi.spyOn(document.getElementById('name-input'), 'focus');
      vi.advanceTimersByTime(50);   // fire the deferred focus()
      expect(focusSpy).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

// --- draw layout & content branches ----------------------------------------

describe('draw — content branches', () => {
  it('renders the five mode buttons + Stats/Settings for a returning player', () => {
    seedName('Ada');
    title.enter();
    title.draw();
    for (const key of ['title.zen', 'title.classic', 'title.daily', 'title.blitz',
      'title.puzzles', 'title.stats', 'title.settings']) {
      expect(() => rectByLabel(i18n.t(key))).not.toThrow();
    }
    // welcomeBack line is drawn for a named player.
    const ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText'
      && c[1][0] === i18n.t('title.welcomeBack', { name: 'Ada' }))).toBe(true);
  });

  it('first-run draw omits the welcome-back line', () => {
    title.enter();        // no name → needsNameEntry true
    title.draw();
    const ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText'
      && typeof c[1][0] === 'string' && c[1][0].startsWith('Welcome back'))).toBe(false);
  });

  it('shows a Continue Zen button when zen has a saveState', () => {
    const st = seedName('Ada');
    st.profile.lastPlayedMode = 'zen';
    st.zen.saveState = { score: 4321 };
    title.enter();
    title.draw();
    const r = rectByLabel(i18n.t('title.continueZen'));
    down(r);
    expect(setScene).toHaveBeenCalledWith('gameZen', { restoreFrom: { score: 4321 } });
  });

  it('shows a Continue Classic button when classic has a saveState', () => {
    const st = seedName('Ada');
    st.profile.lastPlayedMode = 'classic';
    st.classic.saveState = { level: 5, score: 9999 };
    title.enter();
    title.draw();
    down(rectByLabel(i18n.t('title.continueClassic')));
    expect(setScene).toHaveBeenCalledWith('gameClassic', { restoreFrom: { level: 5, score: 9999 } });
  });

  it('no Continue button when lastPlayedMode points at a mode without a saveState', () => {
    const st = seedName('Ada');
    st.profile.lastPlayedMode = 'zen';   // zen.saveState is null by default
    title.enter();
    title.draw();
    expect(renderSpy.mock.calls.some((c) => c[4] === i18n.t('title.continueZen'))).toBe(false);
  });

  it('no Continue button when lastPlayedMode is an unknown key', () => {
    const st = seedName('Ada');
    st.profile.lastPlayedMode = 'bogusMode';   // state[last] is undefined
    title.enter();
    expect(() => title.draw()).not.toThrow();
    expect(renderSpy.mock.calls.some((c) => /Continue/.test(c[4]))).toBe(false);
  });

  it('counts a continue slot but draws no button when the mode is non-continuable', () => {
    // blitz has a saveState here but is absent from CONTINUE_SCENES, so the slot
    // is reserved (buttonCount) yet the button itself is skipped.
    const st = seedName('Ada');
    st.profile.lastPlayedMode = 'blitz';
    st.blitz.saveState = { score: 1 };
    title.enter();
    expect(() => title.draw()).not.toThrow();
    expect(renderSpy.mock.calls.some((c) => /Continue/.test(c[4]))).toBe(false);
  });

  it('Zen subtitle reflects a best score when one exists, else the endless tag', () => {
    const st = seedName('Ada');
    st.zen.bestScore = 12345;
    title.enter();
    title.draw();
    let ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText'
      && c[1][0] === i18n.t('title.zenBest', { score: i18n.formatNumber(12345) }))).toBe(true);

    storage.reset(); i18n.init();
    renderSpy.mockClear();
    seedName('Ada');
    title.enter();
    title.draw();
    ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === i18n.t('title.zenEndless'))).toBe(true);
  });

  it('Classic subtitle sums earned stars across levels (missing starsEarned counts 0)', () => {
    const st = seedName('Ada');
    st.classic.highestUnlocked = 3;
    st.classic.levels = { 1: { starsEarned: 3 }, 2: {}, 3: { starsEarned: 2 } };
    title.enter();
    title.draw();
    const ctx = render.ctxRef();
    const expected = i18n.t('title.classicSubtitle', { current: 3, total: 300, stars: 5 });
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === expected)).toBe(true);
  });

  it('Daily subtitle marks today as done once submitted', () => {
    const st = seedName('Ada');
    st.daily.todaySubmittedDate = todayISO();
    title.enter();
    title.draw();
    const ctx = render.ctxRef();
    const done = i18n.t('title.dailySubtitleDone', { date: i18n.formatDate(todayISO()) });
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === done)).toBe(true);
  });

  it('Blitz subtitle reflects a best score when one exists', () => {
    const st = seedName('Ada');
    st.blitz.bestScore = 777;
    title.enter();
    title.draw();
    const ctx = render.ctxRef();
    const best = i18n.t('title.blitzSubtitleBest', { score: i18n.formatNumber(777) });
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === best)).toBe(true);
  });

  it('Puzzle subtitle counts completed puzzles', () => {
    const st = seedName('Ada');
    st.puzzle.completed = { 1: { bestScore: 10 }, 2: { bestScore: 20 } };
    title.enter();
    title.draw();
    const ctx = render.ctxRef();
    const sub = i18n.t('title.puzzlesSubtitle', { done: 2, total: PUZZLES.length });
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === sub)).toBe(true);
  });

  it('survives missing blitz/puzzle sub-objects (optional-chaining fallbacks)', () => {
    const st = seedName('Ada');
    delete st.blitz;
    delete st.puzzle;
    title.enter();
    expect(() => title.draw()).not.toThrow();
    const ctx = render.ctxRef();
    // blitz?.bestScore → undefined → the plain "60 active sec" subtitle.
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === i18n.t('title.blitzSubtitle'))).toBe(true);
    // puzzle?.completed || {} → 0 done.
    expect(ctx.__calls.some((c) => c[0] === 'fillText'
      && c[1][0] === i18n.t('title.puzzlesSubtitle', { done: 0, total: PUZZLES.length }))).toBe(true);
  });

  it('lifts the build tag by the safe-area inset when --sab is set', () => {
    seedName('Ada');
    document.documentElement.style.setProperty('--sab', '20px');
    title.enter();
    title.draw();
    // Build tag (BUILD='dev') is bottom-right at y = h - 6 - sab = 600 - 6 - 20.
    const ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === 'dev' && c[1][2] === 574)).toBe(true);
  });

  it('places the build tag flush to the bottom when no safe-area inset is set', () => {
    seedName('Ada');
    title.enter();
    title.draw();
    const ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === 'dev' && c[1][2] === 594)).toBe(true);
  });
});

// --- viewport-dependent layout branches ------------------------------------

describe('draw — responsive layout', () => {
  function btnHeightAt(w, h) {
    setViewport(w, h, 1);
    render.setupCanvas();
    seedName('Ada');
    title.enter();
    title.draw();
    return rectByLabel(i18n.t('title.zen')).h;
  }

  it('uses the short-viewport button height on a short window', () => {
    expect(btnHeightAt(800, 600)).toBe(52);   // isShort (h < 760)
  });

  it('uses the wide button height on a tall, wide window', () => {
    expect(btnHeightAt(800, 800)).toBe(62);   // !isShort, !isNarrow
  });

  it('uses the narrow button height on a tall, narrow window', () => {
    expect(btnHeightAt(420, 820)).toBe(56);   // !isShort, isNarrow (w < 480)
  });
});

// --- heatmap ----------------------------------------------------------------

describe('draw — streak heatmap', () => {
  it('draws all 84 day cells across every intensity tier', () => {
    const st = seedName('Ada');
    const day = (back) => { const d = new Date(); d.setDate(d.getDate() - back); return todayISO(d); };
    st.playHistory[day(0)] = { runs: 5 };   // > 3  → brightest
    st.playHistory[day(1)] = { runs: 1 };   // == 1
    st.playHistory[day(2)] = { runs: 2 };   // <= 3
    // every other day is absent → runs 0 → dimmest
    title.enter();
    title.draw();
    const ctx = render.ctxRef();
    // The heatmap is the only thing in a non-settings title frame that calls
    // fillRect (12 weeks × 7 days = 84). Buttons use roundRect+fill, text uses
    // fillText, clearFrame uses clearRect.
    const fillRects = ctx.__calls.filter((c) => c[0] === 'fillRect');
    expect(fillRects).toHaveLength(84);
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === i18n.t('title.streak'))).toBe(true);
  });
});

// --- pointer: mode navigation ----------------------------------------------

describe('onPointer — mode navigation', () => {
  it('routes each mode button to its scene', () => {
    seedName('Ada');
    title.enter();
    title.draw();
    const map = [
      ['title.zen', 'gameZen'],
      ['title.classic', 'levelSelect'],
      ['title.daily', 'gameDaily'],
      ['title.blitz', 'gameBlitz'],
      ['title.puzzles', 'puzzleSelect'],
      ['title.stats', 'stats'],
    ];
    for (const [key, target] of map) down(rectByLabel(i18n.t(key)));
    const targets = setScene.mock.calls.map((c) => c[0]);
    expect(targets).toEqual(map.map(([, t]) => t));
  });

  it('a tap that misses every button does nothing', () => {
    seedName('Ada');
    title.enter();
    title.draw();
    title.onPointer({ type: 'down', x: 5, y: 300 });   // far left gutter
    expect(setScene).not.toHaveBeenCalled();
  });

  it('ignores non-down pointer events', () => {
    seedName('Ada');
    title.enter();
    title.draw();
    title.onPointer({ type: 'up', x: 400, y: 300 });
    title.onPointer({ type: 'move', x: 400, y: 300 });
    expect(setScene).not.toHaveBeenCalled();
  });

  it('blocks taps while the name-entry modal is open', () => {
    title.enter();        // first run → modal open
    title.draw();
    title.onPointer({ type: 'down', x: 400, y: 300 });
    expect(setScene).not.toHaveBeenCalled();
  });

  it('opens the source repo in a new tab via the footer link', () => {
    seedName('Ada');
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    title.enter();
    title.draw();
    // The view-source link is pushed last (after the mode buttons, before any
    // overlay) and isn't a drawHitButton, so read it off the live array.
    const link = liveButtons()[liveButtons().length - 1];
    down(link);
    expect(openSpy).toHaveBeenCalledWith('https://github.com/lucasdaddiego/jeweled', '_blank', 'noopener,noreferrer');
  });
});

// --- onMove + footer-link hover --------------------------------------------

describe('onMove', () => {
  it('updates the cursor the next draw hit-tests against', () => {
    seedName('Ada');
    title.enter();
    title.draw();
    title.onMove(317, 248);
    renderSpy.mockClear();
    title.draw();
    const c = renderSpy.mock.calls[0];   // cursorX/cursorY are args 7 & 8
    expect(c[7]).toBe(317);
    expect(c[8]).toBe(248);
  });

  it('drives the footer-link hover hit-test through all of its bounds checks', () => {
    seedName('Ada');
    title.enter();
    // 800×600, --sab 0 → link box ≈ x:[4,82], y:[581,597].
    const cursors = [
      [40, 590],   // inside  → hover true (all four comparisons pass)
      [0, 590],    // x too small
      [200, 590],  // x too large
      [40, 100],   // y too small
      [40, 700],   // y too large
    ];
    for (const [x, y] of cursors) {
      title.onMove(x, y);
      expect(() => title.draw()).not.toThrow();
    }
    // The link label is drawn regardless of hover state.
    const ctx = render.ctxRef();
    expect(ctx.__calls.some((c) => c[0] === 'fillText' && c[1][0] === i18n.t('title.viewSource'))).toBe(true);
  });
});

// --- settings overlay -------------------------------------------------------

describe('settings overlay', () => {
  it('toggles open from the Settings button and closed from Close', () => {
    seedName('Ada');
    const rects = openSettings();
    expect(rects).toHaveLength(7);
    down(rects[6]);                       // Close
    renderSpy.mockClear();
    title.draw();
    expect(settingsRects()).toHaveLength(0);
  });

  it('tapping outside the panel dismisses the overlay', () => {
    seedName('Ada');
    openSettings();
    title.onPointer({ type: 'down', x: 3, y: 3 });   // outside every settings rect
    renderSpy.mockClear();
    title.draw();
    expect(settingsRects()).toHaveLength(0);
  });

  it('haptic toggle flips and persists the setting', () => {
    seedName('Ada');
    const before = storage.getSettings().haptic;     // default true
    const rects = openSettings();
    down(rects[0]);                                   // haptic toggle
    expect(storage.getSettings().haptic).toBe(!before);
  });

  it('painting-mode toggle flips and persists the setting', () => {
    seedName('Ada');
    const before = storage.getSettings().paintingMode; // default false
    const rects = openSettings();
    down(rects[1]);                                    // painting-mode toggle
    expect(storage.getSettings().paintingMode).toBe(!before);
  });

  it('language pills switch the active language via i18n.setLanguage', () => {
    seedName('Ada');
    const setLang = vi.spyOn(i18n, 'setLanguage');
    const rects = openSettings();
    down(rects[4]);                                    // Español pill
    expect(setLang).toHaveBeenCalledWith('es');
    expect(i18n.getLanguageSetting()).toBe('es');
    expect(storage.getSettings().language).toBe('es');
  });

  it('Reset progress, when confirmed, wipes state and reopens name entry', async () => {
    seedName('Bob');
    vi.spyOn(dialogs, 'confirm').mockResolvedValue(true);
    const rects = openSettings();
    down(rects[5]);                                    // Reset (async onClick)
    await flushMicro();
    expect(storage.getProfile().playerName).toBe('');  // progress wiped
    expect(document.getElementById('name-input')).toBeTruthy(); // name entry reopened
  });

  it('Reset progress, when cancelled, changes nothing', async () => {
    seedName('Bob');
    vi.spyOn(dialogs, 'confirm').mockResolvedValue(false);
    const rects = openSettings();
    down(rects[5]);                                    // Reset
    await flushMicro();
    expect(storage.getProfile().playerName).toBe('Bob');
    expect(document.getElementById('name-input')).toBeNull();
  });
});
