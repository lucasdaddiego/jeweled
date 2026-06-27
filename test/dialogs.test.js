import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// dialogs.js -> render.js -> main.js: break the cycle (and main's import-time
// init) so importing the module under jsdom doesn't boot the whole game.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as dialogs from '../src/dialogs.js';

// drawHitButton(x, y, w, h, label, onClick, buttons, cursorX, cursorY, opts)
const X = 0, Y = 1, W = 2, H = 3, LABEL = 4, ONCLICK = 5, CURX = 7, CURY = 8;

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  dialogs.onMove(0, 0);           // deterministic hover cursor
});

afterEach(() => {
  // active is module-level state: settle any leftover dialog so it can't leak
  // into the next case (and so its promise resolves rather than dangling).
  while (dialogs.isOpen()) dialogs.consumeBack();
  vi.unstubAllGlobals();
});

describe('isOpen / consumeBack', () => {
  it('reports closed before anything opens and open after', () => {
    expect(dialogs.isOpen()).toBe(false);
    dialogs.confirm('hi');
    expect(dialogs.isOpen()).toBe(true);
  });

  it('consumeBack returns false when no dialog is open', () => {
    expect(dialogs.consumeBack()).toBe(false);
  });

  it('consumeBack cancels an open dialog and resolves it to false', async () => {
    const p = dialogs.confirm('Are you sure?');
    expect(dialogs.consumeBack()).toBe(true);
    expect(dialogs.isOpen()).toBe(false);
    await expect(p).resolves.toBe(false);
  });
});

describe('confirm() / alert() labels', () => {
  it('confirm uses i18n default labels (OK / Cancel) when no opts given', () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    dialogs.confirm('Proceed?');
    dialogs.draw();
    expect(spy.mock.calls[0][LABEL]).toBe('Cancel'); // drawn first
    expect(spy.mock.calls[1][LABEL]).toBe('OK');      // drawn second
  });

  it('confirm honors custom confirm/cancel labels from opts', () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    dialogs.confirm('Proceed?', { confirmLabel: 'Yes', cancelLabel: 'No' });
    dialogs.draw();
    expect(spy.mock.calls[0][LABEL]).toBe('No');
    expect(spy.mock.calls[1][LABEL]).toBe('Yes');
  });

  it('alert renders a single button with the default Close label', () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    dialogs.alert('Heads up');
    dialogs.draw();
    expect(spy.mock.calls).toHaveLength(1);
    expect(spy.mock.calls[0][LABEL]).toBe('Close');
  });

  it('alert honors a custom okLabel from opts', () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    dialogs.alert('Heads up', { okLabel: 'Got it' });
    dialogs.draw();
    expect(spy.mock.calls[0][LABEL]).toBe('Got it');
  });
});

describe('open() lifecycle', () => {
  it('opening a second dialog auto-cancels the first (resolves it false)', async () => {
    const p1 = dialogs.confirm('first');
    const p2 = dialogs.confirm('second');
    await expect(p1).resolves.toBe(false);   // first settled by the reopen
    expect(dialogs.isOpen()).toBe(true);      // second is now active
    expect(dialogs.consumeBack()).toBe(true);
    await expect(p2).resolves.toBe(false);
  });

  it('skips window listener wiring when window is undefined (SSR guard)', async () => {
    // Exercises the `typeof window !== "undefined"` false branch in both open()
    // and settle(). Render is not touched here, so no real DOM is needed.
    expect(dialogs.isOpen()).toBe(false);
    vi.stubGlobal('window', undefined);
    const p = dialogs.confirm('ssr');
    expect(dialogs.isOpen()).toBe(true);       // open() ran, just skipped addEventListener
    expect(dialogs.consumeBack()).toBe(true);  // settle() ran, skipped removeEventListener
    await expect(p).resolves.toBe(false);
    vi.unstubAllGlobals();
  });
});

describe('draw()', () => {
  it('is a no-op when no dialog is open', () => {
    const ctx = render.ctxRef();
    const before = ctx.__calls.length;
    dialogs.draw();
    expect(ctx.__calls.length).toBe(before);
  });

  it('draws a dim backdrop and a panel for a confirm dialog', () => {
    dialogs.confirm('Proceed?');
    dialogs.draw();
    const names = render.ctxRef().__calls.map(c => c[0]);
    expect(names).toContain('fillRect');           // backdrop
    expect(names).toContain('quadraticCurveTo');   // roundRect panel
    expect(names).toContain('fillText');           // message text
  });

  it('renders one button for alert and two for confirm', () => {
    const spyA = vi.spyOn(render, 'drawHitButton');
    dialogs.alert('only one');
    dialogs.draw();
    expect(spyA.mock.calls).toHaveLength(1);   // alert branch (kind !== confirm)
    dialogs.consumeBack();
    spyA.mockClear();
    dialogs.confirm('two of them');
    dialogs.draw();
    expect(spyA.mock.calls).toHaveLength(2);   // confirm branch
  });
});

describe('wrapText (via draw)', () => {
  // Mock drawHitButton to a no-op so the only fillText calls on the main ctx are
  // the wrapped message lines — we can then read the lines back exactly.
  function linesFor(message, kind = 'alert') {
    vi.spyOn(render, 'drawHitButton').mockImplementation(() => {});
    if (kind === 'alert') dialogs.alert(message);
    else dialogs.confirm(message);
    dialogs.draw();
    const ctx = render.ctxRef();
    return ctx.__calls.filter(c => c[0] === 'fillText').map(c => c[1][0]);
  }

  it('keeps a short message on a single line', () => {
    expect(linesFor('Hello there')).toEqual(['Hello there']);
  });

  it('wraps a long message across multiple lines, preserving the words', () => {
    const msg = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen';
    const lines = linesFor(msg);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(' ')).toBe(msg);    // every word kept, in order
  });

  it('keeps a single over-long word on its own line (no infinite split)', () => {
    const word = 'x'.repeat(80);          // wider than the panel
    expect(linesFor(word)).toEqual([word]);
  });

  it('renders a single empty line for an empty message', () => {
    expect(linesFor('')).toEqual(['']);
  });
});

describe('handlePointer', () => {
  it('returns false and does nothing when no dialog is open', () => {
    expect(dialogs.handlePointer({ type: 'down', x: 5, y: 5 })).toBe(false);
  });

  it('swallows non-down events while open without settling', async () => {
    const p = dialogs.confirm('x');
    expect(dialogs.handlePointer({ type: 'up', x: 0, y: 0 })).toBe(true);
    expect(dialogs.handlePointer({ type: 'move', x: 0, y: 0 })).toBe(true);
    expect(dialogs.isOpen()).toBe(true);
    dialogs.consumeBack();
    await expect(p).resolves.toBe(false);
  });

  it('clicking the confirm button resolves the promise to true', async () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    const p = dialogs.confirm('Proceed?');
    dialogs.draw();
    const b = spy.mock.calls[1]; // confirm button -> settle(true)
    const hit = dialogs.handlePointer({ type: 'down', x: b[X] + b[W] / 2, y: b[Y] + b[H] / 2 });
    expect(hit).toBe(true);
    await expect(p).resolves.toBe(true);
    expect(dialogs.isOpen()).toBe(false);
  });

  it('clicking the cancel button resolves the promise to false', async () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    const p = dialogs.confirm('Proceed?');
    dialogs.draw();
    const b = spy.mock.calls[0]; // cancel button -> settle(false)
    dialogs.handlePointer({ type: 'down', x: b[X] + b[W] / 2, y: b[Y] + b[H] / 2 });
    await expect(p).resolves.toBe(false);
  });

  it('misses outside the button rect keep the dialog open, a hit closes it', async () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    const p = dialogs.alert('hi');
    dialogs.draw();
    const b = spy.mock.calls[0];
    const bx = b[X], by = b[Y], bw = b[W], bh = b[H];
    // One miss on each side of the hit rect — covers each && short-circuit.
    expect(dialogs.handlePointer({ type: 'down', x: bx - 10,      y: by + bh / 2 })).toBe(true);
    expect(dialogs.handlePointer({ type: 'down', x: bx + bw + 10, y: by + bh / 2 })).toBe(true);
    expect(dialogs.handlePointer({ type: 'down', x: bx + bw / 2,  y: by - 10 })).toBe(true);
    expect(dialogs.handlePointer({ type: 'down', x: bx + bw / 2,  y: by + bh + 10 })).toBe(true);
    expect(dialogs.isOpen()).toBe(true);  // all missed
    // Now hit it.
    dialogs.handlePointer({ type: 'down', x: bx + bw / 2, y: by + bh / 2 });
    await expect(p).resolves.toBe(true);
  });
});

describe('onMove', () => {
  it('feeds the hover cursor through to drawHitButton', () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    dialogs.alert('hi');
    dialogs.draw();
    const b = spy.mock.calls[0];
    const cx = b[X] + b[W] / 2, cy = b[Y] + b[H] / 2;
    dialogs.onMove(cx, cy);
    dialogs.draw();
    const last = spy.mock.calls[spy.mock.calls.length - 1];
    expect(last[CURX]).toBe(cx);
    expect(last[CURY]).toBe(cy);
  });
});

describe('keyboard handling', () => {
  it('Escape cancels the dialog (resolves false)', async () => {
    const p = dialogs.confirm('x');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
    await expect(p).resolves.toBe(false);
    expect(dialogs.isOpen()).toBe(false);
  });

  it('Enter accepts the dialog (resolves true)', async () => {
    const p = dialogs.confirm('x');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    await expect(p).resolves.toBe(true);
  });

  it('ignores other keys', () => {
    dialogs.confirm('x');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', cancelable: true }));
    expect(dialogs.isOpen()).toBe(true);   // neither Escape nor Enter
  });

  it('the keydown handler is inert once the dialog is closed', () => {
    const spy = vi.spyOn(window, 'addEventListener');
    dialogs.confirm('x');
    const handler = spy.mock.calls.find(c => c[0] === 'keydown')[1];
    dialogs.consumeBack();  // removes the listener; active = null
    // Calling the stale handler directly hits the `!active` early return.
    expect(() => handler(new KeyboardEvent('keydown', { key: 'Escape' }))).not.toThrow();
    expect(dialogs.isOpen()).toBe(false);
  });
});

describe('settle() guard', () => {
  it('a stale button handler is a no-op after the dialog closed', async () => {
    const spy = vi.spyOn(render, 'drawHitButton');
    const p = dialogs.confirm('x');
    dialogs.draw();
    const staleOnClick = spy.mock.calls[1][ONCLICK]; // confirm button's () => settle(true)
    dialogs.consumeBack();                            // active = null, resolves p=false
    await expect(p).resolves.toBe(false);
    // Re-invoking the captured handler now hits settle()'s `!active` guard.
    expect(() => staleOnClick()).not.toThrow();
    expect(dialogs.isOpen()).toBe(false);
  });
});
