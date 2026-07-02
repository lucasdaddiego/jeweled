import { describe, it, expect, afterEach, vi } from 'vitest';
import { makeStubCtx } from './helpers.js';

// painting.js holds module-level `canvas` / `ctx` / `enabled`. Each scenario
// re-imports it fresh (resetModules) so we can drive the `!canvas` / `!ctx`
// first-use guards deterministically.
async function fresh() {
  vi.resetModules();
  return await import('../src/painting.js');
}

// A recording OffscreenCanvas whose 2D context captures method calls AND
// gradient color stops (so hexToRgba output is assertable). `made` collects
// every instance constructed during init(), which lets us prove the
// reuse-vs-reallocate branch in init().
function installOffscreen() {
  const made = [];
  function recordingCtx() {
    const calls = [];
    const stops = [];
    const props = {};
    return new Proxy({}, {
      get(_t, p) {
        if (p === '__calls') return calls;
        if (p === '__stops') return stops;
        if (p === 'then' || typeof p === 'symbol') return undefined;
        if (p === 'createRadialGradient') {
          return (...a) => { calls.push([p, a]); return { addColorStop: (o, c) => stops.push([o, c]) }; };
        }
        if (p in props) return props[p];
        return (...a) => { calls.push([p, a]); };
      },
      set(_t, p, v) { props[p] = v; return true; },
    });
  }
  class O {
    constructor(w, h) { this.width = w; this.height = h; this._ctx = recordingCtx(); made.push(this); }
    getContext() { return this._ctx; }
    convertToBlob() { return Promise.resolve(new Blob()); }
    transferToImageBitmap() { return { width: this.width, height: this.height, close() {} }; }
  }
  vi.stubGlobal('OffscreenCanvas', O);
  return made;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('init', () => {
  it('allocates on first use, reuses for same dims, reallocates when w or h changes', async () => {
    const made = installOffscreen();
    const painting = await fresh();

    painting.init(100, 100);          // !canvas -> allocate
    expect(made).toHaveLength(1);

    painting.init(100, 100);          // same dims -> all three OR operands false -> reuse
    expect(made).toHaveLength(1);

    painting.init(200, 100);          // width !== -> reallocate
    expect(made).toHaveLength(2);
    expect(made[1].width).toBe(200);

    painting.init(200, 200);          // height !== -> reallocate
    expect(made).toHaveLength(3);
    expect(made[2].height).toBe(200);
  });

  it('defaults to a 1080x1080 layer', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init();
    expect(made[0].width).toBe(1080);
    expect(made[0].height).toBe(1080);
  });
});

describe('clear', () => {
  it('is a no-op before init (ctx null guard)', async () => {
    const painting = await fresh();
    expect(() => painting.clear()).not.toThrow();
  });

  it('clears the full layer via clearRect once a ctx exists', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init(100, 100);              // init() calls clear() internally
    const calls = made[0]._ctx.__calls;
    expect(calls).toContainEqual(['clearRect', [0, 0, 100, 100]]);
    calls.length = 0;
    painting.clear();
    expect(calls).toEqual([['clearRect', [0, 0, 100, 100]]]);
  });
});

describe('setEnabled / isEnabled', () => {
  it('reflects the toggled flag', async () => {
    const painting = await fresh();
    expect(painting.isEnabled()).toBe(false);
    painting.setEnabled(true);
    expect(painting.isEnabled()).toBe(true);
    painting.setEnabled(false);
    expect(painting.isEnabled()).toBe(false);
  });
});

describe('brushAt', () => {
  it('does nothing while disabled (!enabled guard)', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    made[0]._ctx.__calls.length = 0; // drop init's clearRect
    painting.brushAt(540, 540, 1080, '#abc'); // enabled defaults false
    expect(made[0]._ctx.__calls).toHaveLength(0);
  });

  it('does nothing when enabled but not yet initialised (!ctx guard)', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.setEnabled(true);
    expect(() => painting.brushAt(540, 540, 1080, '#abc')).not.toThrow();
    expect(made).toHaveLength(0); // never allocated a layer
  });

  it('paints a radial gradient blob mapped into the layer (3-char # color)', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    vi.spyOn(Math, 'random').mockReturnValue(0.5); // jitter 0, radius factor 70
    painting.init(1080, 1080);
    painting.setEnabled(true);
    made[0]._ctx.__calls.length = 0;

    painting.brushAt(540, 540, 1080, '#abc');
    const ctx = made[0]._ctx;
    // sx = sy = (540/1080)*1080 = 540; radius = (40 + 0.5*60) * (1080/1080) = 70.
    expect(ctx.__calls).toContainEqual(['createRadialGradient', [540, 540, 0, 540, 540, 70]]);
    expect(ctx.__calls).toContainEqual(['arc', [540, 540, 70, 0, Math.PI * 2]]);
    expect(ctx.__calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['createRadialGradient', 'beginPath', 'arc', 'fill']),
    );
    // #abc -> aabbcc -> aa/bb/cc = 170/187/204, with stops at full and zero alpha.
    expect(ctx.__stops).toEqual([
      [0, 'rgba(170, 187, 204, 0.55)'],
      [1, 'rgba(170, 187, 204, 0)'],
    ]);
  });

  it('accepts a bare 6-char hex color (no #, no shorthand expansion)', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    vi.spyOn(Math, 'random').mockReturnValue(0.5);
    painting.init(1080, 1080);
    painting.setEnabled(true);
    made[0]._ctx.__calls.length = 0;

    painting.brushAt(540, 540, 1080, 'abcdef'); // ab=171, cd=205, ef=239
    expect(made[0]._ctx.__stops).toEqual([
      [0, 'rgba(171, 205, 239, 0.55)'],
      [1, 'rgba(171, 205, 239, 0)'],
    ]);
  });
});

describe('drawInto', () => {
  it('is a no-op before init (ctx null guard)', async () => {
    const painting = await fresh();
    const target = makeStubCtx();
    painting.drawInto(target, 0, 0, 10, 10);
    expect(target.__calls).toHaveLength(0);
  });

  it('blits the layer at the given rect and alpha', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    const target = makeStubCtx();
    painting.drawInto(target, 5, 6, 100, 120, 0.3);
    const di = target.__calls.find((c) => c[0] === 'drawImage');
    expect(di[1]).toEqual([made[0], 5, 6, 100, 120]);
    expect(target.globalAlpha).toBe(0.3);
    expect(target.__calls.map((c) => c[0])).toEqual(
      expect.arrayContaining(['save', 'drawImage', 'restore']),
    );
  });

  it('defaults alpha to 0.55', async () => {
    installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    const target = makeStubCtx();
    painting.drawInto(target, 0, 0, 10, 10);
    expect(target.globalAlpha).toBe(0.55);
  });
});

describe('toBlob', () => {
  it('returns null before init (canvas null guard)', async () => {
    const painting = await fresh();
    await expect(painting.toBlob()).resolves.toBeNull();
  });

  it('exports the layer as a PNG blob once initialised', async () => {
    installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    const blob = await painting.toBlob();
    expect(blob).toBeInstanceOf(Blob);
  });
});

describe('thumbnailDataURL', () => {
  it('returns null before init (canvas null guard)', async () => {
    const painting = await fresh();
    await expect(painting.thumbnailDataURL()).resolves.toBeNull();
  });

  it('bakes the painting onto a dark 256px thumb and returns a data URL', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    const url = await painting.thumbnailDataURL();   // default size = 256
    // jsdom's FileReader encodes the stub Blob from convertToBlob().
    expect(typeof url).toBe('string');
    expect(url).toMatch(/^data:/);
    // made[0] = the painting layer, made[1] = the thumb constructed inside.
    expect(made).toHaveLength(2);
    expect(made[1].width).toBe(256);
    expect(made[1].height).toBe(256);
    const calls = made[1]._ctx.__calls;
    expect(calls).toContainEqual(['fillRect', [0, 0, 256, 256]]);      // dark backing
    expect(calls).toContainEqual(['drawImage', [made[0], 0, 0, 256, 256]]); // painting on top
  });

  it('honors an explicit thumbnail size', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    await painting.thumbnailDataURL(128);
    expect(made[1].width).toBe(128);
  });

  it('returns null when convertToBlob rejects (catch branch)', async () => {
    const made = installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    // Swap the global so only the thumb constructed inside thumbnailDataURL
    // fails to encode; the painting layer itself stays valid.
    class Failing {
      constructor(w, h) { this.width = w; this.height = h; }
      getContext() { return makeStubCtx(this); }
      convertToBlob() { return Promise.reject(new Error('encode failed')); }
    }
    vi.stubGlobal('OffscreenCanvas', Failing);
    await expect(painting.thumbnailDataURL()).resolves.toBeNull();
    expect(made).toHaveLength(1);   // no recording thumb was built
  });

  it('resolves null when the FileReader errors instead of loading', async () => {
    installOffscreen();
    const painting = await fresh();
    painting.init(1080, 1080);
    class ErroringFileReader {
      readAsDataURL() { setTimeout(() => this.onerror(new Error('read failed')), 0); }
    }
    vi.stubGlobal('FileReader', ErroringFileReader);
    await expect(painting.thumbnailDataURL()).resolves.toBeNull();
  });
});
