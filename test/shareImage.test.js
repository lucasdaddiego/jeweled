import { describe, it, expect, afterEach, vi } from 'vitest';
import { shareCard } from '../src/shareImage.js';

// jsdom ships File, but guard anyway (the module's `typeof File` precondition
// must see something real here). Plain assignment, not stubGlobal, so the
// polyfill survives afterEach's unstubAllGlobals.
if (typeof globalThis.File === 'undefined') {
  globalThis.File = class File extends Blob {
    constructor(bits, name, opts = {}) { super(bits, opts); this.name = name; }
  };
}

// navigator.share / canShare / clipboard don't exist under jsdom; install and
// tear them down per test (same defineProperty idiom as result.test.js).
const setNav = (prop, value) =>
  Object.defineProperty(navigator, prop, { value, configurable: true, writable: true });

afterEach(() => {
  for (const prop of ['share', 'canShare', 'clipboard']) setNav(prop, undefined);
  vi.unstubAllGlobals();
});

// Recording 2D context that captures method calls AND property writes — the
// helpers.js stub records methods only, but asserting font sizes / fill colors
// needs the writes too. Gradients log their color stops into the same stream.
function recordingCtx(canvas) {
  const calls = [];
  const props = { canvas };
  return new Proxy({}, {
    get(_t, p) {
      if (p === '__calls') return calls;
      if (p === 'then' || typeof p === 'symbol') return undefined;
      if (p === 'createLinearGradient') {
        return (...a) => {
          calls.push([p, a]);
          return { addColorStop: (o, c) => calls.push(['addColorStop', [o, c]]) };
        };
      }
      if (p in props) return props[p];
      return (...a) => { calls.push([p, a]); };
    },
    set(_t, p, v) { props[p] = v; calls.push(['set:' + p, [v]]); return true; },
  });
}

// Recording OffscreenCanvas. `made` collects every constructed instance so
// tests can prove the card was (or was not) rendered; convertToBlob behavior
// is injectable to drive the encode-failure branch.
function installOffscreen(convertToBlob) {
  const made = [];
  class RecordingOffscreenCanvas {
    constructor(w, h) { this.width = w; this.height = h; this._ctx = recordingCtx(this); made.push(this); }
    getContext() { return this._ctx; }
    convertToBlob(opts) {
      this._blobOpts = opts;
      return convertToBlob ? convertToBlob(opts) : Promise.resolve(new Blob(['png'], { type: 'image/png' }));
    }
  }
  vi.stubGlobal('OffscreenCanvas', RecordingOffscreenCanvas);
  return made;
}

// Replay a ctx call log into "which text was drawn where, with what style".
function textDraws(ctx) {
  let font = '', fill = '';
  const out = [];
  for (const [name, args] of ctx.__calls) {
    if (name === 'set:font') font = args[0];
    else if (name === 'set:fillStyle') fill = args[0];
    else if (name === 'fillText') out.push({ text: args[0], x: args[1], y: args[2], font, fill });
  }
  return out;
}

const abortErr = () => new DOMException('the user dismissed the sheet', 'AbortError');
const CARD = { title: 'Daily — Jun 26', lines: ['1,234 pts', 'New best!'], footer: 'jeweled.daddiego.com.ar' };
const TEXT = 'I scored 1,234 in the Jeweled daily!';

describe('shareCard: image share (rung a)', () => {
  it('renders the card, probes canShare with the File, shares it, and reports "shared-image"', async () => {
    const made = installOffscreen();
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', canShare);
    setNav('share', share);

    await expect(shareCard(CARD, TEXT)).resolves.toBe('shared-image');

    // One 640×400 canvas, exported as PNG.
    expect(made).toHaveLength(1);
    expect(made[0].width).toBe(640);
    expect(made[0].height).toBe(400);
    expect(made[0]._blobOpts).toEqual({ type: 'image/png' });

    const payload = share.mock.calls[0][0];
    expect(payload.title).toBe('Jeweled');
    expect(payload.text).toBe(TEXT);
    expect(payload.files).toHaveLength(1);
    const file = payload.files[0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('jeweled.png');
    expect(file.type).toBe('image/png');
    // The capability probe used the same file and ran before the sheet opened.
    expect(canShare).toHaveBeenCalledWith({ files: [file] });
    expect(canShare.mock.invocationCallOrder[0]).toBeLessThan(share.mock.invocationCallOrder[0]);
  });

  it('paints title, descending-size lines, dim footer, and the brand gradient bar', async () => {
    const made = installOffscreen();
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('share', vi.fn().mockResolvedValue(undefined));

    await shareCard(
      { title: 'Jeweled Daily', lines: ['12,340 pts', 'Best ever: 15,000', 'Streak: 4'], footer: 'jeweled.daddiego.com.ar' },
      'txt',
    );

    const ctx = made[0].getContext();
    const draws = textDraws(ctx);
    expect(draws.map((d) => d.text)).toEqual(
      ['Jeweled Daily', '12,340 pts', 'Best ever: 15,000', 'Streak: 4', 'jeweled.daddiego.com.ar'],
    );
    // Everything centered on the card's vertical axis, laid out top to bottom.
    for (const d of draws) expect(d.x).toBe(320);
    const ys = draws.map((d) => d.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    // Title biggest and bold; body sizes descend; lead line bold + brightest.
    const px = draws.map((d) => Number(/(\d+)px/.exec(d.font)[1]));
    expect(px[0]).toBe(44);
    expect(px[1]).toBeGreaterThan(px[2]);
    expect(px[2]).toBeGreaterThan(px[3]);
    expect(draws[0].font).toContain('bold');
    expect(draws[1].font).toContain('bold');
    expect(draws[2].font).not.toContain('bold');
    expect(draws[1].fill).toBe('#ffffff');
    expect(draws[2].fill).not.toBe('#ffffff');
    // Footer: small, dim, pinned near the bottom.
    expect(px[4]).toBe(15);
    expect(draws[4].y).toBe(400 - 34);
    expect(draws[4].fill).toContain('0.45');
    // Dark rounded panel + pink → purple → blue accent gradient.
    expect(ctx.__calls).toContainEqual(['set:fillStyle', ['#1a1530']]);
    expect(ctx.__calls.some((c) => c[0] === 'quadraticCurveTo')).toBe(true);
    expect(ctx.__calls).toContainEqual(['addColorStop', [0, '#ff9ec0']]);
    expect(ctx.__calls).toContainEqual(['addColorStop', [0.5, '#d59bff']]);
    expect(ctx.__calls).toContainEqual(['addColorStop', [1, '#8fd1ff']]);
  });

  it('clamps deep line stacks to a 16px floor instead of shrinking into nothing', async () => {
    const made = installOffscreen();
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('share', vi.fn().mockResolvedValue(undefined));

    await shareCard({ title: 't', lines: ['a', 'b', 'c', 'd', 'e'], footer: 'f' }, 'txt');

    const sizes = textDraws(made[0].getContext())
      .slice(1, 6) // the five body lines
      .map((d) => Number(/(\d+)px/.exec(d.font)[1]));
    expect(sizes).toEqual([34, 28, 22, 16, 16]);
  });

  it('tolerates an empty card object — every field defaults', async () => {
    installOffscreen();
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('share', vi.fn().mockResolvedValue(undefined));
    await expect(shareCard({}, 'txt')).resolves.toBe('shared-image');
  });

  it('returns "canceled" when the user dismisses the image sheet — clipboard untouched', async () => {
    installOffscreen();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('share', vi.fn().mockRejectedValue(abortErr()));
    setNav('clipboard', { writeText });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('canceled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls through to the clipboard (not a second sheet) when the image share errors', async () => {
    installOffscreen();
    const share = vi.fn().mockRejectedValue(new Error('NotAllowedError: lost activation'));
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('share', share);
    setNav('clipboard', { writeText });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('copied');
    expect(share).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith(TEXT);
  });

  it('falls back to a text-only share when convertToBlob rejects', async () => {
    installOffscreen(() => Promise.reject(new Error('encode failed')));
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', canShare);
    setNav('share', share);

    await expect(shareCard(CARD, TEXT)).resolves.toBe('shared-text');
    expect(canShare).not.toHaveBeenCalled(); // never got as far as the probe
    expect(share).toHaveBeenCalledWith({ title: 'Jeweled', text: TEXT }); // no files
  });

  it('falls back to a text-only share when canShare rejects file payloads', async () => {
    const made = installOffscreen();
    const canShare = vi.fn().mockReturnValue(false);
    const share = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', canShare);
    setNav('share', share);

    await expect(shareCard(CARD, TEXT)).resolves.toBe('shared-text');
    expect(made).toHaveLength(1); // card was rendered — needed for the probe
    expect(canShare).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ title: 'Jeweled', text: TEXT });
  });
});

describe('shareCard: image-path preconditions', () => {
  it('skips straight to text share when OffscreenCanvas is missing', async () => {
    vi.stubGlobal('OffscreenCanvas', undefined);
    const canShare = vi.fn().mockReturnValue(true);
    const share = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', canShare);
    setNav('share', share);

    await expect(shareCard(CARD, TEXT)).resolves.toBe('shared-text');
    expect(canShare).not.toHaveBeenCalled();
    expect(share).toHaveBeenCalledWith({ title: 'Jeweled', text: TEXT });
  });

  it('skips the image path when the File constructor is missing', async () => {
    const made = installOffscreen();
    vi.stubGlobal('File', undefined);
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('share', vi.fn().mockResolvedValue(undefined));

    await expect(shareCard(CARD, TEXT)).resolves.toBe('shared-text');
    expect(made).toHaveLength(0); // never rendered
  });

  it('goes straight to text share when navigator.canShare is absent', async () => {
    const made = installOffscreen();
    const share = vi.fn().mockResolvedValue(undefined);
    setNav('share', share);

    await expect(shareCard(CARD, TEXT)).resolves.toBe('shared-text');
    expect(made).toHaveLength(0); // no point rendering with nothing to attach to
  });

  it('lands on the clipboard when canShare exists but share does not', async () => {
    const made = installOffscreen();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('canShare', vi.fn().mockReturnValue(true));
    setNav('clipboard', { writeText });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('copied');
    expect(made).toHaveLength(0);
    expect(writeText).toHaveBeenCalledWith(TEXT);
  });
});

describe('shareCard: text share (rung b)', () => {
  it('returns "canceled" when the user dismisses the text sheet — clipboard untouched', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('share', vi.fn().mockRejectedValue(abortErr()));
    setNav('clipboard', { writeText });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('canceled');
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls through to the clipboard when text share fails for a real reason', async () => {
    setNav('share', vi.fn().mockRejectedValue(new Error('boom')));
    setNav('clipboard', { writeText: vi.fn().mockResolvedValue(undefined) });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('copied');
  });

  it('treats a reason-less rejection as a real failure, not a cancel', async () => {
    setNav('share', vi.fn().mockRejectedValue(undefined));
    setNav('clipboard', { writeText: vi.fn().mockResolvedValue(undefined) });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('copied');
  });
});

describe('shareCard: clipboard + unavailable (rungs c/d)', () => {
  it('copies the text when no share sheet exists at all', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setNav('clipboard', { writeText });

    await expect(shareCard(CARD, TEXT)).resolves.toBe('copied');
    expect(writeText).toHaveBeenCalledWith(TEXT);
  });

  it('returns "unavailable" when the clipboard object has no writeText', async () => {
    setNav('clipboard', {});
    await expect(shareCard(CARD, TEXT)).resolves.toBe('unavailable');
  });

  it('returns "unavailable" (not a rejection) when writeText itself rejects', async () => {
    setNav('clipboard', { writeText: vi.fn().mockRejectedValue(new Error('denied')) });
    await expect(shareCard(CARD, TEXT)).resolves.toBe('unavailable');
  });

  it('never throws: null card + no share surface at all resolves "unavailable"', async () => {
    await expect(shareCard(null, TEXT)).resolves.toBe('unavailable');
  });
});
