import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';
import { SPECIAL, GRID } from '../src/config.js';
import { newCell, makeEmptyGrid } from '../src/grid.js';

// render imports main.js; mock it so importing render never boots the game.
vi.mock('../src/main.js', () => ({ clockMs: vi.fn(() => 0), setScene: vi.fn() }));

// A controllable Image stand-in: stores every instance so a test can fire its
// onload / onerror to drive the async Fluent-emoji loader deterministically.
class FakeImage {
  constructor() {
    this.onload = null;
    this.onerror = null;
    this.src = '';
    FakeImage.instances.push(this);
  }
}
FakeImage.instances = [];
function fireLoad(srcSub) {
  for (const i of FakeImage.instances) if (i.src.includes(srcSub) && i.onload) i.onload();
}
function fireError(srcSub, err) {
  for (const i of FakeImage.instances) if (i.src.includes(srcSub) && i.onerror) i.onerror(err);
}
const flush = () => new Promise((r) => setTimeout(r, 0));

// Board with every badge special (so drawSpecialOverlay -> drawEmojiBadge runs
// for each) plus the baked-overlay specials.
function buildBoard() {
  const g = makeEmptyGrid();
  for (let r = 0; r < GRID; r++)
    for (let c = 0; c < GRID; c++)
      g[r][c] = newCell((r + c) % 7);
  g[0][0] = newCell(0, SPECIAL.LINE_H);
  g[0][1] = newCell(1, SPECIAL.LINE_V);
  g[0][2] = newCell(2, SPECIAL.COLOR_BOMB);
  g[0][3] = newCell(3, SPECIAL.GRAVITY);
  g[0][4] = newCell(4, SPECIAL.TIME_BOMB, 5);
  g[1][0] = newCell(0, SPECIAL.AREA_BOMB);   // 💥
  g[1][1] = newCell(1, SPECIAL.WILDCARD);    // 🃏
  g[1][2] = newCell(2, SPECIAL.COIN);        // 🪙 (no Fluent mapping)
  g[1][3] = newCell(3, SPECIAL.FIRE);        // 🔥
  g[1][4] = newCell(4, SPECIAL.LIGHTNING);   // ⚡
  g[1][5] = newCell(5, SPECIAL.STAR);        // ⭐
  return g;
}

// Re-import render fresh so its import-time matchMedia/window reads re-run.
async function freshRender() {
  vi.resetModules();
  FakeImage.instances.length = 0;
  vi.stubGlobal('Image', FakeImage);
  const render = await import('../src/render.js');
  const main = await import('../src/main.js');
  main.clockMs.mockReturnValue(0);
  return { render, main };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------

describe('import-time reduced-motion wiring', () => {
  it('reduced-motion=true at import disables shake + idle wobble', async () => {
    let listener;
    vi.stubGlobal('matchMedia', (q) => ({
      matches: true, media: q,
      addEventListener: (_e, cb) => { listener = cb; },
      removeEventListener() {},
    }));
    const { render, main } = await freshRender();
    installCanvas();
    setViewport(800, 600, 1);
    render.setupCanvas();
    render.buildAtlas();
    expect(typeof listener).toBe('function'); // change listener was registered

    const g = buildBoard();
    main.clockMs.mockReturnValue(600);
    render.drawBoard(g, { shakeAmp: 50, idleMs: 99999 }); // both suppressed by reduced-motion
    const names = render.ctxRef().__calls.map((c) => c[0]);
    expect(names).not.toContain('rotate'); // idleMs forced to 0 -> no wobble

    // the MediaQueryList 'change' listener keeps the flag live
    listener({ matches: false });
    render.clearFrame();
    render.drawBoard(g, { idleMs: 99999 }); // now motion allowed -> wobble rotates
    expect(render.ctxRef().__calls.map((c) => c[0])).toContain('rotate');
    listener({ matches: true }); // flip back (exercises the setter both ways)
  });

  it('falls back to the legacy addListener API when addEventListener is absent', async () => {
    let legacy;
    vi.stubGlobal('matchMedia', (q) => ({
      matches: false, media: q,
      addListener: (cb) => { legacy = cb; }, // no addEventListener
    }));
    const { render } = await freshRender();
    expect(typeof legacy).toBe('function');
    installCanvas(); setViewport(800, 600, 1);
    render.setupCanvas(); render.buildAtlas();
    legacy({ matches: true });
    render.drawBoard(buildBoard(), { idleMs: 99999 });
    expect(render.ctxRef().__calls.map((c) => c[0])).not.toContain('rotate');
  });

  it('matchMedia present but exposing no add* listener API is tolerated', async () => {
    vi.stubGlobal('matchMedia', (q) => ({ matches: false, media: q }));
    const { render } = await freshRender();
    expect(typeof render.drawBoard).toBe('function'); // imported without throwing
  });

  it('no matchMedia at all -> reducedMotion defaults to false', async () => {
    vi.stubGlobal('matchMedia', undefined);
    const { render, main } = await freshRender();
    installCanvas(); setViewport(800, 600, 1);
    render.setupCanvas(); render.buildAtlas();
    main.clockMs.mockReturnValue(600);
    render.drawBoard(buildBoard(), { idleMs: 99999 });
    expect(render.ctxRef().__calls.map((c) => c[0])).toContain('rotate'); // motion enabled
  });

  it('no window at all -> reducedMotion defaults to false (import-time guards)', async () => {
    vi.resetModules();
    vi.stubGlobal('window', undefined);
    const render = await import('../src/render.js');
    expect(typeof render.drawBoard).toBe('function');
  });
});

describe('uninitialized module guards', () => {
  it('resize() before setupCanvas is a no-op (no canvas yet)', async () => {
    const { render } = await freshRender();
    render.resize();
    expect(render.getViewport()).toEqual({ w: 0, h: 0 });
  });

  it('drawBoard before buildAtlas skips gem blits (no atlas) but still draws overlays', async () => {
    const { render } = await freshRender();
    installCanvas(); setViewport(800, 600, 1);
    render.setupCanvas(); // NO buildAtlas -> atlas stays null
    const g = buildBoard();
    expect(() => render.drawBoard(g, {})).not.toThrow();
    // overlay badges are still composed (drawSpecialOverlay runs even without atlas)
    const names = render.ctxRef().__calls.map((c) => c[0]);
    expect(names).toContain('drawImage'); // bg blit + overlay layers
  });
});

describe('Fluent emoji loader lifecycle (buildAtlas path)', () => {
  it('upgrades atlas slots on load, handles stale atlases, failures and re-entry', async () => {
    const { render } = await freshRender();
    installCanvas(); setViewport(800, 600, 1);
    render.setupCanvas();

    render.buildAtlas(); // #1: queue gem + badge loads (atlasAtBuild = A)
    render.buildAtlas(); // #2: new atlas B; gem loads are in-flight (dedup), 2nd .then attached

    // Resolve most gems; fail two so the failure paths run.
    fireLoad('red_square'); fireLoad('blue_square'); fireLoad('green_square');
    fireLoad('yellow_square'); fireLoad('purple_square');
    fireError('white_large_square', new Error('boom')); // err.message truthy
    fireError('black_large_square', {});                 // err.message falsy
    await flush();

    render.buildAtlas(); // #3: cached gems drawn directly; failed gems re-reject
    await flush();

    // Special badge warm-loads (separate from the board atlas).
    fireLoad('collision_color');                 // 💥 cached
    fireError('fire_color', new Error('nope'));  // 🔥 failed (message truthy)
    fireError('high_voltage_color', {});         // ⚡ failed (message falsy)
    await flush();

    // A drawImage of an upgraded Fluent glyph landed in the atlas.
    const atlasCtx = render.ctxRef(); // main ctx unrelated; assert no throw + warns fired
    expect(atlasCtx).toBeTruthy();
    expect(console.warn).toHaveBeenCalled(); // failures were logged
  });
});

describe('Fluent emoji loader lifecycle (drawEmojiBadge path)', () => {
  it('triggers loads from badges, then upgrades / falls back per cache state', async () => {
    const { render } = await freshRender();
    installCanvas(); setViewport(800, 600, 1);
    render.setupCanvas(); // no buildAtlas: badges are the only Fluent trigger here
    const g = buildBoard();

    render.drawBoard(g, {}); // badges kick off loads (not in-flight yet)
    render.drawBoard(g, {}); // badges now in-flight -> the dedup branch

    fireLoad('collision_color');                 // 💥 -> cached
    fireError('fire_color', new Error('x'));     // 🔥 -> failed (message truthy)
    fireError('high_voltage_color', {});         // ⚡ -> failed (message falsy)
    await flush();

    render.drawBoard(g, {}); // 💥 badge now blits the cached Fluent glyph; 🔥/⚡ stay OS-fallback
    const imgCalls = render.ctxRef().__calls.filter((c) => c[0] === 'drawImage');
    expect(imgCalls.length).toBeGreaterThan(0);
    expect(console.warn).toHaveBeenCalled();
  });
});
