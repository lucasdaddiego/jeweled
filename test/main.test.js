import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { flushRAF, installCanvas } from './helpers.js';

// main.js is pure orchestration (scene dispatch, RAF loop, history nav, input
// routing, SW update). We mock every collaborator so we can drive each branch
// directly and assert routing, not real scene/render behavior.
const h = vi.hoisted(() => {
  const makeScene = () => ({
    enter: vi.fn(), exit: vi.fn(), update: vi.fn(), draw: vi.fn(),
    onPointer: vi.fn(), onMove: vi.fn(), onWheel: vi.fn(),
  });
  const sceneNames = ['title', 'levelSelect', 'gameZen', 'gameClassic', 'gameDaily',
    'gameBlitz', 'gamePuzzle', 'puzzleSelect', 'stats', 'result'];
  const scenes = {};
  for (const n of sceneNames) scenes[n] = makeScene();
  // gamePuzzle is intentionally a "bare" scene — handlers present but undefined —
  // so main's optional-handler guards (if (current.update), current && current.onX)
  // hit their false arms. No other test navigates to gamePuzzle.
  scenes.gamePuzzle = {
    enter: undefined, exit: undefined, update: undefined, draw: undefined,
    onPointer: undefined, onMove: undefined, onWheel: undefined,
  };
  const ctxStub = {
    fillStyle: '', font: '', textAlign: '', textBaseline: '',
    save() {}, restore() {}, fillRect() {}, fillText() {},
    measureText: () => ({ width: 20 }),
  };
  return {
    scenes, ctxStub,
    render: {
      setupCanvas: vi.fn(), buildAtlas: vi.fn(), setGemStyle: vi.fn(),
      ctxRef: vi.fn(() => ctxStub),
      getViewport: vi.fn(() => ({ w: 800, h: 600 })),
    },
    input: { setup: vi.fn(), on: vi.fn(), isPointerDown: vi.fn(() => false) },
    storage: { load: vi.fn(), flush: vi.fn(), getSettings: vi.fn(() => ({ sound: true, gemStyle: 'color' })) },
    toasts: { update: vi.fn(), draw: vi.fn() },
    i18n: { init: vi.fn(), setLanguage: vi.fn(), getLocale: vi.fn(() => 'en'), t: vi.fn((k) => k) },
    dialogs: {
      draw: vi.fn(), isOpen: vi.fn(() => false), handlePointer: vi.fn(() => false),
      onMove: vi.fn(), consumeBack: vi.fn(() => false),
    },
    debugHud: {
      counters: { findMatches: 3, drawBoard: 5 },
      resetFrameCounters: vi.fn(), recordFrame: vi.fn(),
      frameStats: vi.fn(() => ({ fps: 60, p95: 5 })),
      activeCascade: vi.fn(() => null), setEnabled: vi.fn(),
    },
  };
});

vi.mock('../src/render.js', () => h.render);
vi.mock('../src/input.js', () => h.input);
vi.mock('../src/storage.js', () => h.storage);
vi.mock('../src/toasts.js', () => h.toasts);
vi.mock('../src/i18n.js', () => h.i18n);
vi.mock('../src/dialogs.js', () => h.dialogs);
vi.mock('../src/debugHud.js', () => h.debugHud);
vi.mock('../src/scenes/title.js', () => h.scenes.title);
vi.mock('../src/scenes/levelSelect.js', () => h.scenes.levelSelect);
vi.mock('../src/scenes/gameZen.js', () => h.scenes.gameZen);
vi.mock('../src/scenes/gameClassic.js', () => h.scenes.gameClassic);
vi.mock('../src/scenes/gameDaily.js', () => h.scenes.gameDaily);
vi.mock('../src/scenes/gameBlitz.js', () => h.scenes.gameBlitz);
vi.mock('../src/scenes/gamePuzzle.js', () => h.scenes.gamePuzzle);
vi.mock('../src/scenes/puzzleSelect.js', () => h.scenes.puzzleSelect);
vi.mock('../src/scenes/stats.js', () => h.scenes.stats);
vi.mock('../src/scenes/result.js', () => h.scenes.result);

// Capture the input callback bundle main registers via input.on({...}).
function inputCbs() { return h.input.on.mock.calls.at(-1)[0]; }

async function boot() {
  vi.resetModules();
  installCanvas();
  // jsdom's location persists across tests in a file; a #hash left behind by
  // an earlier test's pushState would otherwise be picked up by main's
  // hash-boot routing and land the app on a non-title scene.
  history.replaceState(null, '', '/');
  return import('../src/main.js');
}

// main.js attaches listeners to the shared window/document and never removes
// them; resetModules + re-boot would otherwise leak a listener per test, and
// stale ones (from earlier main instances) fire first. Track and detach them.
let tracked = [];

beforeEach(() => {
  // Pin the frame clock seed so frame() dt is driven solely by flushRAF(now).
  vi.spyOn(performance, 'now').mockReturnValue(0);
  tracked = [];
  for (const tgt of [window, document]) {
    const orig = tgt.addEventListener.bind(tgt);
    vi.spyOn(tgt, 'addEventListener').mockImplementation((type, fn, opts) => {
      tracked.push([tgt, type, fn, opts]);
      return orig(type, fn, opts);
    });
  }
  h.input.isPointerDown.mockReturnValue(false);
  h.dialogs.isOpen.mockReturnValue(false);
  h.dialogs.handlePointer.mockReturnValue(false);
  h.dialogs.consumeBack.mockReturnValue(false);
  h.debugHud.activeCascade.mockReturnValue(null);
});

afterEach(() => {
  for (const [tgt, type, fn, opts] of tracked) tgt.removeEventListener(type, fn, opts);
  tracked = [];
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  // Restore a clean document.readyState in case a test forced 'loading'.
  Object.defineProperty(document, 'readyState', { value: 'complete', configurable: true });
});

describe('init (auto-runs on import; jsdom readyState=complete, hostname=localhost)', () => {
  it('boots: canvas, input/i18n/storage wired, lands on title, debug enabled on localhost', async () => {
    const main = await boot();
    expect(h.render.setupCanvas).toHaveBeenCalled();
    expect(h.render.buildAtlas).toHaveBeenCalled();
    expect(h.storage.load).toHaveBeenCalled();
    expect(h.i18n.init).toHaveBeenCalled();
    expect(h.scenes.title.enter).toHaveBeenCalled();
    // localhost => debug HUD enabled + window.__game exposed.
    expect(h.debugHud.setEnabled).toHaveBeenCalledWith(true);
    expect(window.__game).toBeTruthy();
    expect(window.__game.getLocale()).toBe('en');
    window.__game.setLanguage('es');
    expect(h.i18n.setLanguage).toHaveBeenCalledWith('es');
    expect(typeof main.clockMs).toBe('function');
  });

  it('flushes storage on pagehide', async () => {
    await boot();
    window.dispatchEvent(new Event('pagehide'));
    expect(h.storage.flush).toHaveBeenCalled();
  });

  it('does not enable debug off-localhost and exposes no global; frame skips HUD work', async () => {
    vi.stubGlobal('location', { hostname: 'jeweled.example', search: '', hash: '#title', reload: vi.fn() });
    delete window.__game;
    await boot();
    expect(h.debugHud.setEnabled).toHaveBeenLastCalledWith(false);
    expect(window.__game).toBeUndefined();
    flushRAF(16);   // _dbg=false → frame skips the counter snapshot + drawDebugHud
    expect(h.debugHud.recordFrame).not.toHaveBeenCalled();
  });

  it('enables debug via ?debug even off-localhost', async () => {
    vi.stubGlobal('location', { hostname: 'jeweled.example', search: '?debug=1', hash: '#title', reload: vi.fn() });
    await boot();
    expect(h.debugHud.setEnabled).toHaveBeenLastCalledWith(true);
  });

  it('boots straight into a directly-enterable scene named by the URL hash', async () => {
    vi.stubGlobal('location', { hostname: 'localhost', search: '', hash: '#gameBlitz', reload: vi.fn() });
    await boot();
    expect(h.scenes.gameBlitz.enter).toHaveBeenCalled();     // PWA shortcut boot
    expect(h.scenes.title.enter).not.toHaveBeenCalled();
  });

  it('falls back to title for a hash that is not a boot scene', async () => {
    vi.stubGlobal('location', { hostname: 'localhost', search: '', hash: '#result', reload: vi.fn() });
    await boot();                                            // 'result' not directly enterable
    expect(h.scenes.title.enter).toHaveBeenCalled();
    expect(h.scenes.result.enter).not.toHaveBeenCalled();
  });
});

describe('announce (aria-live region)', () => {
  // installCanvas() doesn't create #sr-live (index.html does in production).
  function addLiveRegion() {
    const el = document.createElement('div');
    el.id = 'sr-live';
    document.body.appendChild(el);
    return el;
  }

  it('clears-then-writes the region so repeats re-announce', async () => {
    const main = await boot();
    const live = addLiveRegion();
    main.announce('Daily challenge started');
    expect(live.textContent).toBe('Daily challenge started');
    main.announce('Daily challenge started');                // same text again → still set
    expect(live.textContent).toBe('Daily challenge started');
  });

  it('announces scene changes with the sr.scene.* key', async () => {
    const main = await boot();
    const live = addLiveRegion();
    main.setScene('stats');                                  // i18n.t mock echoes the key
    expect(live.textContent).toBe('sr.scene.stats');
  });

  it('is a no-op for empty text or a missing region', async () => {
    const main = await boot();
    expect(() => main.announce('lost')).not.toThrow();       // no #sr-live in DOM
    const live = addLiveRegion();
    live.textContent = 'kept';
    main.announce('');                                       // falsy text → untouched
    expect(live.textContent).toBe('kept');
  });
});

describe('boot() failure path', () => {
  it('swaps the splash spinner for the unsupported-browser notice when init throws', async () => {
    h.render.setupCanvas.mockImplementationOnce(() => { throw new Error('no OffscreenCanvas'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    installCanvas();
    const dots = document.createElement('div');
    dots.className = 'boot-dots';
    document.getElementById('boot-splash').appendChild(dots);
    history.replaceState(null, '', '/');
    await expect(import('../src/main.js')).resolves.toBeTruthy();   // no crash
    expect(error).toHaveBeenCalledWith('boot failed:', expect.any(Error));
    const msg = document.querySelector('#boot-splash .boot-error');
    expect(msg).toBeTruthy();
    expect(msg.textContent).toContain('too old');
    expect(document.querySelector('#boot-splash .boot-dots')).toBeNull(); // spinner removed
    expect(h.scenes.title.enter).not.toHaveBeenCalled();             // init never finished
  });

  it('appends the notice even when the splash has no spinner to remove', async () => {
    h.render.setupCanvas.mockImplementationOnce(() => { throw new Error('boom'); });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    installCanvas();                       // splash ships .boot-gem, no .boot-dots
    history.replaceState(null, '', '/');
    await import('../src/main.js');
    expect(document.querySelector('#boot-splash .boot-error')).toBeTruthy();
  });

  it('stays silent when even the boot splash is missing', async () => {
    h.render.setupCanvas.mockImplementationOnce(() => { throw new Error('boom'); });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.resetModules();
    installCanvas();
    document.getElementById('boot-splash').remove();
    history.replaceState(null, '', '/');
    await expect(import('../src/main.js')).resolves.toBeTruthy();
    expect(error).toHaveBeenCalledWith('boot failed:', expect.any(Error));
    expect(document.querySelector('.boot-error')).toBeNull();
  });
});

describe('init deferred when document is still loading', () => {
  it('waits for DOMContentLoaded before init', async () => {
    Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
    await boot();
    expect(h.render.setupCanvas).not.toHaveBeenCalled();   // init not yet run
    document.dispatchEvent(new Event('DOMContentLoaded'));
    expect(h.render.setupCanvas).toHaveBeenCalled();        // now it has
  });
});

describe('setScene / history', () => {
  it('pushes history for a normal scene change', async () => {
    const main = await boot();
    const push = vi.spyOn(history, 'pushState');
    main.setScene('stats', { foo: 'bar' });
    expect(h.scenes.stats.enter).toHaveBeenCalledWith({ foo: 'bar' });
    expect(push).toHaveBeenCalledWith(
      { scene: 'stats', args: { foo: 'bar' } }, '', '#stats');
  });

  it('replaces history when opts.replace is set', async () => {
    const main = await boot();
    const replace = vi.spyOn(history, 'replaceState');
    main.setScene('stats', {}, { replace: true });
    expect(replace).toHaveBeenCalled();
  });

  it('replaces (not pushes) when coming from a transient source (result)', async () => {
    const main = await boot();
    main.setScene('result', {});            // current becomes a transient source
    const push = vi.spyOn(history, 'pushState');
    const replace = vi.spyOn(history, 'replaceState');
    main.setScene('gameClassic', { level: 1 });
    expect(replace).toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('replaces when args carry a non-serializable restoreFrom', async () => {
    const main = await boot();
    const replace = vi.spyOn(history, 'replaceState');
    main.setScene('gameZen', { restoreFrom: { grid: [[1]] } });
    expect(replace).toHaveBeenCalledWith(
      { scene: 'gameZen', args: {} }, '', '#gameZen');   // restoreFrom stripped
  });

  it('serializes only JSON-scalar args and drops the rest', async () => {
    const main = await boot();
    const push = vi.spyOn(history, 'pushState');
    main.setScene('stats', { s: 'x', n: 1, b: true, nul: null, fn: () => {}, obj: {} });
    expect(push).toHaveBeenCalledWith(
      { scene: 'stats', args: { s: 'x', n: 1, b: true, nul: null } }, '', '#stats');
  });

  it('calls exit on the outgoing scene', async () => {
    const main = await boot();
    main.setScene('stats');
    main.setScene('title');
    expect(h.scenes.stats.exit).toHaveBeenCalled();
  });

  it('falls back to title for an unknown scene', async () => {
    const main = await boot();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    h.scenes.title.enter.mockClear();
    main.setScene('nope');
    expect(warn).toHaveBeenCalledWith('unknown scene:', 'nope');
    expect(h.scenes.title.enter).toHaveBeenCalled();
  });

  it('swallows the next pointer-up when a pointer is down during a swap', async () => {
    const main = await boot();
    h.input.isPointerDown.mockReturnValue(true);
    main.setScene('stats');
    // onUp should be swallowed once now.
    const cbs = inputCbs();
    h.scenes.stats.onPointer.mockClear();
    cbs.onUp(10, 10);
    expect(h.scenes.stats.onPointer).not.toHaveBeenCalled();   // swallowed
    cbs.onUp(10, 10);
    expect(h.scenes.stats.onPointer).toHaveBeenCalled();        // next one passes
  });
});

describe('popstate navigation', () => {
  it('swaps to the scene encoded in history state', async () => {
    await boot();
    window.dispatchEvent(new PopStateEvent('popstate', { state: { scene: 'stats', args: { a: 1 } } }));
    expect(h.scenes.stats.enter).toHaveBeenCalledWith({ a: 1 });
  });

  it('lands on title and replaces state when there is no history state', async () => {
    await boot();
    const replace = vi.spyOn(history, 'replaceState');
    h.scenes.title.enter.mockClear();
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(h.scenes.title.enter).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith({ scene: 'title', args: {} }, '', '#title');
  });

  it('defaults missing popstate args to {}', async () => {
    await boot();
    window.dispatchEvent(new PopStateEvent('popstate', { state: { scene: 'stats' } }));
    expect(h.scenes.stats.enter).toHaveBeenCalledWith({});   // s.args || {}
  });

  it('handles a known scene then a stateless popstate on the same instance', async () => {
    // Both the then- and else-arms of `if (scene && SCENES[scene])` on one
    // module instance, so v8 records both (it doesn't aggregate the else-arm
    // across resetModules-reimported instances).
    await boot();
    window.dispatchEvent(new PopStateEvent('popstate', { state: { scene: 'stats', args: {} } }));
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(h.scenes.stats.enter).toHaveBeenCalled();   // then-arm
    expect(h.scenes.title.enter).toHaveBeenCalled();    // else-arm (title fallback)
  });

  it('treats Back as "close dialog" and re-pushes the CURRENT scene (not the popped one)', async () => {
    await boot();
    h.dialogs.consumeBack.mockReturnValue(true);
    const push = vi.spyOn(history, 'pushState');
    // The pop landed on the 'stats' entry, but the visible scene is still
    // title — the re-push must describe what's on screen so a later Back
    // doesn't land somewhere unexpected.
    window.dispatchEvent(new PopStateEvent('popstate', { state: { scene: 'stats' } }));
    expect(push).toHaveBeenCalledWith({ scene: 'title', args: {} }, '', '#title');
  });

  it('consumes Back with no state without re-pushing', async () => {
    await boot();
    h.dialogs.consumeBack.mockReturnValue(true);
    const push = vi.spyOn(history, 'pushState');
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
    expect(push).not.toHaveBeenCalled();
  });
});

describe('input routing', () => {
  it('onTapCell routes to the current scene, unless a dialog consumes it', async () => {
    await boot();
    const cbs = inputCbs();
    cbs.onTapCell({ r: 1, c: 2 }, 5, 6);
    expect(h.scenes.title.onPointer).toHaveBeenCalledWith({ type: 'down', cell: { r: 1, c: 2 }, x: 5, y: 6 });
    h.scenes.title.onPointer.mockClear();
    h.dialogs.handlePointer.mockReturnValue(true);
    cbs.onTapCell({ r: 0, c: 0 }, 1, 1);
    expect(h.scenes.title.onPointer).not.toHaveBeenCalled();
  });

  it('onMove routes to dialog when open, else to the scene', async () => {
    await boot();
    const cbs = inputCbs();
    cbs.onMove(3, 4);
    expect(h.scenes.title.onMove).toHaveBeenCalledWith(3, 4);
    h.dialogs.isOpen.mockReturnValue(true);
    cbs.onMove(7, 8);
    expect(h.dialogs.onMove).toHaveBeenCalledWith(7, 8);
  });

  it('onUp routes to scene unless a dialog consumes it', async () => {
    await boot();
    const cbs = inputCbs();
    cbs.onUp(1, 1);
    expect(h.scenes.title.onPointer).toHaveBeenCalledWith({ type: 'up', x: 1, y: 1 });
    h.scenes.title.onPointer.mockClear();
    h.dialogs.handlePointer.mockReturnValue(true);
    cbs.onUp(2, 2);
    expect(h.scenes.title.onPointer).not.toHaveBeenCalled();
  });

  it('onCancel clears a pending swallow and routes cancel', async () => {
    const main = await boot();
    const cbs = inputCbs();
    cbs.onCancel(1, 1);
    expect(h.scenes.title.onPointer).toHaveBeenCalledWith({ type: 'cancel', x: 1, y: 1 });
    // dialog-consumed cancel:
    h.scenes.title.onPointer.mockClear();
    h.dialogs.handlePointer.mockReturnValue(true);
    cbs.onCancel(2, 2);
    expect(h.scenes.title.onPointer).not.toHaveBeenCalled();
  });

  it('onCancel consumes a pending swallow flag (set during a down-driven swap)', async () => {
    const main = await boot();
    h.input.isPointerDown.mockReturnValue(true);
    main.setScene('stats');           // sets _swallowNextUp
    const cbs = inputCbs();
    cbs.onCancel(1, 1);               // clears the flag
    h.scenes.stats.onPointer.mockClear();
    cbs.onUp(1, 1);                   // should NOT be swallowed now
    expect(h.scenes.stats.onPointer).toHaveBeenCalled();
  });

  it('onWheel routes to scene unless a dialog is open', async () => {
    await boot();
    const cbs = inputCbs();
    cbs.onWheel(10, 1, 2);
    expect(h.scenes.title.onWheel).toHaveBeenCalledWith(10, 1, 2);
    h.scenes.title.onWheel.mockClear();
    h.dialogs.isOpen.mockReturnValue(true);
    cbs.onWheel(10, 1, 2);
    expect(h.scenes.title.onWheel).not.toHaveBeenCalled();
  });
});

describe('frame loop', () => {
  it('updates+draws the scene, crossfades, advances the clock, fades the splash', async () => {
    const main = await boot();
    expect(document.getElementById('boot-splash')).toBeTruthy();
    flushRAF(16);                // run one frame at now=16
    expect(h.scenes.title.update).toHaveBeenCalled();
    expect(h.scenes.title.draw).toHaveBeenCalled();
    expect(h.toasts.update).toHaveBeenCalled();
    expect(h.toasts.draw).toHaveBeenCalled();
    expect(h.dialogs.draw).toHaveBeenCalled();
    expect(main.clockMs()).toBeGreaterThan(0);
    // first frame schedules the boot-splash removal
    expect(document.getElementById('boot-splash').classList.contains('fade-out')).toBe(true);
  });

  it('removes the splash after its timeout', async () => {
    // Only fake setTimeout — faking rAF would replace our controllable queue.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await boot();
    flushRAF(16);
    vi.advanceTimersByTime(200);
    expect(document.getElementById('boot-splash')).toBeNull();
  });

  it('clamps large positive and negative dt', async () => {
    const main = await boot();
    flushRAF(1000);             // huge gap -> clamped to 50
    const after1 = main.clockMs();
    expect(after1).toBe(50);
    flushRAF(0);                // now < lastFrameTime -> dt clamped to 0
    expect(main.clockMs()).toBe(50);
  });

  it('while paused, reschedules without updating the scene', async () => {
    await boot();
    document.dispatchEvent(new Event('visibilitychange')); // visible -> not paused yet
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange')); // hidden -> paused + flush
    expect(h.storage.flush).toHaveBeenCalled();
    h.scenes.title.update.mockClear();
    flushRAF(16);
    expect(h.scenes.title.update).not.toHaveBeenCalled();   // paused: skipped
  });

  it('resumes on becoming visible again', async () => {
    await boot();
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    h.scenes.title.update.mockClear();
    flushRAF(16);
    expect(h.scenes.title.update).toHaveBeenCalled();
  });

  it('draws the debug HUD with an active cascade anim count', async () => {
    h.debugHud.activeCascade.mockReturnValue({ anims: new Map([['a', 1]]) });
    await boot();
    flushRAF(16);
    expect(h.debugHud.recordFrame).toHaveBeenCalled();
    expect(h.debugHud.frameStats).toHaveBeenCalled();
  });
});

describe('branch edge cases', () => {
  it('serializes null and non-object args to empty', async () => {
    const main = await boot();
    const push = vi.spyOn(history, 'pushState');
    main.setScene('stats', null);
    expect(push).toHaveBeenLastCalledWith({ scene: 'stats', args: {} }, '', '#stats');
    main.setScene('levelSelect', 'weird');
    expect(push).toHaveBeenLastCalledWith({ scene: 'levelSelect', args: {} }, '', '#levelSelect');
  });

  it('tolerates a current scene missing every optional handler', async () => {
    const main = await boot();
    main.setScene('gamePuzzle');     // bare scene: no enter()
    flushRAF(16);                    // frame: no update()/draw()
    const cbs = inputCbs();
    expect(() => {
      cbs.onTapCell({ r: 0, c: 0 }, 1, 1);   // no onPointer
      cbs.onMove(1, 1);                       // no onMove
      cbs.onUp(1, 1);                         // no onPointer
      cbs.onCancel(1, 1);                     // no onPointer
      cbs.onWheel(1, 1, 1);                   // no onWheel
    }).not.toThrow();
  });

  it('skips history writes when a scene re-navigates during popstate restore', async () => {
    const main = await boot();
    h.scenes.stats.enter.mockImplementationOnce(() => main.setScene('title'));
    const push = vi.spyOn(history, 'pushState');
    window.dispatchEvent(new PopStateEvent('popstate', { state: { scene: 'stats', args: {} } }));
    expect(push).not.toHaveBeenCalled();   // _handlingPopState short-circuited setScene
    expect(h.scenes.title.enter).toHaveBeenCalled();
  });

  it('falls back to title on popstate to an unknown scene', async () => {
    await boot();
    const replace = vi.spyOn(history, 'replaceState');
    h.scenes.title.enter.mockClear();
    window.dispatchEvent(new PopStateEvent('popstate', { state: { scene: 'ghost' } }));
    expect(h.scenes.title.enter).toHaveBeenCalled();
    expect(replace).toHaveBeenCalledWith({ scene: 'title', args: {} }, '', '#title');
  });

  it('falls back to title on popstate with a stateless object (no scene)', async () => {
    await boot();
    h.scenes.title.enter.mockClear();
    window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));  // s truthy, s.scene undefined
    expect(h.scenes.title.enter).toHaveBeenCalled();
  });

  it('stops drawing the crossfade overlay once it completes', async () => {
    await boot();
    let t = 0;
    for (let i = 0; i < 6; i++) { t += 50; flushRAF(t); }  // exceed CROSSFADE_MS (220)
    expect(h.render.getViewport).toHaveBeenCalled();
  });

  it('handles a null drawing context during a frame (crossfade + debug HUD)', async () => {
    const main = await boot();   // localhost → _dbg true → drawDebugHud runs
    h.render.ctxRef.mockReturnValue(null);
    expect(() => flushRAF(16)).not.toThrow();
  });

  it('skips the splash fade when there is no boot-splash element', async () => {
    await boot();
    document.getElementById('boot-splash').remove();
    expect(() => flushRAF(16)).not.toThrow();
  });
});

describe('service worker update flow', () => {
  function stubSW({ controller } = {}) {
    const listeners = {};
    const reg = { update: vi.fn(() => Promise.resolve()) };
    const sw = {
      controller: controller ?? null,
      register: vi.fn(() => Promise.resolve(reg)),
      addEventListener: vi.fn((type, cb) => { listeners[type] = cb; }),
    };
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    return { sw, reg, listeners };
  }

  afterEach(() => {
    // remove the stub so other suites see no serviceWorker
    try { delete navigator.serviceWorker; } catch { /* ignore */ }
  });

  it('registers on load and reloads when an update takes over a controlled page on a safe scene', async () => {
    const { sw, reg, listeners } = stubSW({ controller: {} });   // hadController = true
    const reload = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', search: '', hash: '#title', reload });
    await boot();
    window.dispatchEvent(new Event('load'));
    await Promise.resolve(); await Promise.resolve();   // let register().then run
    expect(sw.register).toHaveBeenCalledWith('/sw.js', { updateViaCache: 'none' });
    // controllerchange => update ready => reload (current scene 'title' is safe)
    listeners.controllerchange();
    expect(reload).toHaveBeenCalled();
    expect(window.__game.isSwUpdateReady()).toBe(true);
    // a second controllerchange is a no-op (already refreshing)
    reload.mockClear();
    listeners.controllerchange();
    expect(reload).not.toHaveBeenCalled();
    // focus re-checks for updates
    window.dispatchEvent(new Event('focus'));
    expect(reg.update).toHaveBeenCalled();
    // a focus-time update() failure is swallowed
    reg.update.mockReturnValueOnce(Promise.reject(new Error('net')));
    window.dispatchEvent(new Event('focus'));
    await Promise.resolve(); await Promise.resolve();
  });

  it('ignores controllerchange for a first-ever (uncontrolled) install', async () => {
    const { listeners } = stubSW({ controller: null });    // hadController = false
    const reload = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', search: '', hash: '#title', reload });
    await boot();
    window.dispatchEvent(new Event('load'));
    await Promise.resolve(); await Promise.resolve();
    listeners.controllerchange();
    expect(reload).not.toHaveBeenCalled();
  });

  it('defers reload while on an unsafe (in-game) scene', async () => {
    const { listeners } = stubSW({ controller: {} });
    const reload = vi.fn();
    vi.stubGlobal('location', { hostname: 'localhost', search: '', hash: '#g', reload });
    const main = await boot();
    main.setScene('gameZen');     // unsafe scene
    window.dispatchEvent(new Event('load'));
    await Promise.resolve(); await Promise.resolve();
    listeners.controllerchange();
    expect(reload).not.toHaveBeenCalled();
  });

  it('warns when registration fails', async () => {
    const sw = {
      controller: null,
      register: vi.fn(() => Promise.reject(new Error('boom'))),
      addEventListener: vi.fn(),
    };
    Object.defineProperty(navigator, 'serviceWorker', { value: sw, configurable: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await boot();
    window.dispatchEvent(new Event('load'));
    await Promise.resolve(); await Promise.resolve();
    expect(warn).toHaveBeenCalledWith('SW register failed:', expect.any(Error));
  });
});
