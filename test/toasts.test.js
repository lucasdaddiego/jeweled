import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// toasts.js -> render.js -> main.js: break the cycle / import-time init.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));
// toasts pulls its toasts from achievements.consumeToast(). Mock just that one
// function so we can feed an exact, deterministic stream of toasts.
vi.mock('../src/achievements.js', () => ({ consumeToast: vi.fn() }));

import * as render from '../src/render.js';
import * as achievements from '../src/achievements.js';
import * as toasts from '../src/toasts.js';

const LIFE_MS = 3800;            // mirror of the module constant
const SLOTS = 4;
const CARD_W = 280;
const BASE_X = 800 - CARD_W - 16; // anchored x of a card on an 800px viewport

let queue;

function toast(id = 'first_match') {
  return { id, icon: '🎯', nameKey: 'achievement.first_match.name' };
}

// Count the cards a single draw() paints by spying roundRect (one call/card).
function drawnCardCount() {
  const rr = vi.spyOn(render, 'roundRect');
  toasts.draw();
  const n = rr.mock.calls.length;
  rr.mockRestore();
  return n;
}

beforeEach(() => {
  queue = [];
  achievements.consumeToast.mockImplementation(() => queue.shift() || null);
  toasts.update(1e9);            // flush any toasts left active by a prior test
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
});

describe('update / pump', () => {
  it('does nothing when there is nothing to show', () => {
    const ctx = render.ctxRef();
    const before = ctx.__calls.length;
    toasts.update(16);          // empty queue -> pump pulls null and breaks
    toasts.draw();              // active is empty -> early return
    expect(ctx.__calls.length).toBe(before);
  });

  it('pumps a queued toast into the active pool', () => {
    queue.push(toast());
    toasts.update(16);
    expect(drawnCardCount()).toBe(1);
  });

  it('keeps a young toast and removes it once it outlives LIFE_MS', () => {
    queue.push(toast());
    toasts.update(100);                 // age 100 -> alive
    expect(drawnCardCount()).toBe(1);
    toasts.update(LIFE_MS);             // age 4100 >= LIFE_MS -> spliced out
    expect(drawnCardCount()).toBe(0);
  });

  it('caps the active pool at SLOTS and refills from the queue as toasts expire', () => {
    for (let i = 0; i < SLOTS + 2; i++) queue.push(toast('a' + i));
    toasts.update(10);                  // pump fills to the cap, queue keeps the rest
    expect(drawnCardCount()).toBe(SLOTS);
    expect(queue.length).toBe(2);
    toasts.update(LIFE_MS + 100);       // the on-screen four expire this frame
    expect(drawnCardCount()).toBe(0);
    toasts.update(10);                  // next frame pump pulls the two that waited
    expect(drawnCardCount()).toBe(2);
    expect(queue.length).toBe(0);
  });
});

describe('draw animation phases', () => {
  it('enter phase: the card slides in from the right (x offset > anchor)', () => {
    const rr = vi.spyOn(render, 'roundRect');
    queue.push(toast());
    toasts.update(100);                 // age 100 < 280 -> entering
    toasts.draw();
    expect(rr.mock.calls[0][1]).toBeGreaterThan(BASE_X);
  });

  it('hold phase: the card rests at its anchored x', () => {
    const rr = vi.spyOn(render, 'roundRect');
    queue.push(toast());
    toasts.update(2000);               // 280 <= age, k <= 0.85 -> holding
    toasts.draw();
    expect(rr.mock.calls[0][1]).toBe(BASE_X);
  });

  it('exit phase: the card slides back out before it is removed', () => {
    const rr = vi.spyOn(render, 'roundRect');
    queue.push(toast());
    toasts.update(3500);              // k = 3500/3800 = 0.92 > 0.85, still < LIFE_MS
    toasts.draw();
    expect(rr.mock.calls[0][1]).toBeGreaterThan(BASE_X);
  });

  it('draws the icon and localized text, re-localized at draw time', () => {
    queue.push({ id: 'first_zen', icon: '🧘', nameKey: 'achievement.first_zen.name' });
    toasts.update(100);
    toasts.draw();
    const texts = render.ctxRef().__calls
      .filter(c => c[0] === 'fillText')
      .map(c => c[1][0]);
    expect(texts).toContain('🧘');                   // the icon
    expect(texts).toContain('ACHIEVEMENT UNLOCKED'); // i18n.t('achievement.unlocked')
    expect(texts).toContain('Inner Peace');          // i18n.t(nameKey)
  });

  it('stacks multiple cards vertically (distinct y per slot)', () => {
    const rr = vi.spyOn(render, 'roundRect');
    queue.push(toast('a'), toast('b'));
    toasts.update(100);
    toasts.draw();
    const ys = rr.mock.calls.map(c => c[2]);
    expect(ys).toHaveLength(2);
    expect(ys[0]).not.toBe(ys[1]);     // second card sits below the first
  });
});
