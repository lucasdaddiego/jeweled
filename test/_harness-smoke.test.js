import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport, makeStubCtx } from './helpers.js';

// Break the render.js -> main.js import cycle (and main.js's import-time init()).
vi.mock('../src/main.js', () => ({ clockMs: () => 1000, setScene: vi.fn() }));

import * as render from '../src/render.js';

describe('harness: stub 2D context', () => {
  it('records draw calls and returns values for measureText/gradients', () => {
    const ctx = makeStubCtx();
    ctx.fillStyle = '#abc';
    expect(ctx.fillStyle).toBe('#abc');
    ctx.fillRect(0, 0, 10, 10);
    const grad = ctx.createLinearGradient(0, 0, 1, 1);
    grad.addColorStop(0, '#000');
    expect(ctx.measureText('hello').width).toBe(30);
    expect(ctx.__calls.map(c => c[0])).toContain('fillRect');
  });
});

describe('harness: render boots under jsdom', () => {
  beforeEach(() => {
    setViewport(800, 600, 2);
    installCanvas();
  });

  it('setupCanvas + buildAtlas + getViewport work against the stub', () => {
    render.setupCanvas();
    render.buildAtlas();
    const vp = render.getViewport();
    expect(vp.w).toBe(800);
    expect(vp.h).toBe(600);
    expect(render.ctxRef()).toBeTruthy();
  });
});
