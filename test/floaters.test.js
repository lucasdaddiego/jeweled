import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleMatchCleared, handleSpecialActivated, spawnText, spawnScore, update, draw, clear,
} from '../src/floaters.js';
import { SPECIAL, FLOATER_POOL } from '../src/config.js';
import * as i18n from '../src/i18n.js';
import { makeStubCtx } from './helpers.js';

// floaters.js owns a fixed module-level pool + aliveCount. clear() empties it.
// i18n.init() is called so combo labels resolve (en under jsdom) and
// formatNumber() produces grouped output for spawnScore.
beforeEach(() => {
  clear();
  i18n.init();
});

// draw() emits, per alive floater, a shadow fillText then a main fillText; the
// main pass leaves ctx.fillStyle === floater color. Decode that back out.
function drawState() {
  const ctx = makeStubCtx();
  draw(ctx);
  const ft = ctx.__calls.filter((c) => c[0] === 'fillText');
  return {
    ctx,
    count: ft.length / 2,
    text: ft.length ? ft[0][1][0] : undefined,
    mainX: ft.length ? ft[1][1][1] : undefined,
    mainY: ft.length ? ft[1][1][2] : undefined,
    color: ctx.fillStyle,
    allTexts: ft.map((c) => c[1][0]),
  };
}

function makeDeps(over = {}) {
  return {
    render: { getCellSize: () => 40, layout: { boardX: 10, boardY: 20, boardSize: 320 } },
    particles: { spawnBurst: vi.fn() },
    palettes: [
      ['#r0', '#r1'], ['#b0', '#b1'], ['#g0', '#g1'], ['#y0', '#y1'],
      ['#p0', '#p1'], ['#w0', '#w1'], ['#k0', '#k1'],
    ],
    waves: { spawn: vi.fn() },
    painting: null,
    haptic: false,
    ...over,
  };
}

describe('handleMatchCleared orchestration', () => {
  it('emits a burst per cell, one centroid wave, and returns the centroid', () => {
    const deps = makeDeps();
    const cells = [{ r: 0, c: 0, type: 0 }, { r: 1, c: 1, type: 1 }];
    const center = handleMatchCleared(cells, 3, deps);

    // cs=40, boardX=10, boardY=20 -> cell centers (30,40) and (70,80).
    expect(deps.particles.spawnBurst).toHaveBeenCalledTimes(2);
    expect(deps.particles.spawnBurst).toHaveBeenNthCalledWith(1, 30, 40, deps.palettes[0], 12);
    expect(deps.particles.spawnBurst).toHaveBeenNthCalledWith(2, 70, 80, deps.palettes[1], 12);
    // centroid (50,60); radius clamps to the 60 floor (40*sqrt(2)*0.75 ~= 42.4).
    expect(deps.waves.spawn).toHaveBeenCalledTimes(1);
    expect(deps.waves.spawn).toHaveBeenCalledWith(50, 60, 'rgba(255,255,255,0.55)', 60, 450);
    expect(center).toEqual({ x: 50, y: 60 });
  });

  it('paints a brushstroke per cell when painting is enabled', () => {
    const painting = { isEnabled: () => true, brushAt: vi.fn() };
    const deps = makeDeps({ painting });
    handleMatchCleared([{ r: 0, c: 0, type: 0 }, { r: 1, c: 1, type: 1 }], 2, deps);
    expect(painting.brushAt).toHaveBeenCalledTimes(2);
    expect(painting.brushAt).toHaveBeenNthCalledWith(1, 20, 20, 320, deps.palettes[0][0]);
    expect(painting.brushAt).toHaveBeenNthCalledWith(2, 60, 60, 320, deps.palettes[1][0]);
  });

  it('skips brushstrokes when painting exists but is disabled', () => {
    const painting = { isEnabled: () => false, brushAt: vi.fn() };
    handleMatchCleared([{ r: 0, c: 0, type: 0 }], 2, makeDeps({ painting }));
    expect(painting.brushAt).not.toHaveBeenCalled();
  });

  it('fires a single 15ms haptic buzz when haptic is enabled', () => {
    const vib = vi.spyOn(navigator, 'vibrate');
    handleMatchCleared([{ r: 0, c: 0, type: 0 }], 2, makeDeps({ haptic: true }));
    expect(vib).toHaveBeenCalledWith(15);
  });

  it('does not buzz when haptic is off', () => {
    const vib = vi.spyOn(navigator, 'vibrate');
    handleMatchCleared([{ r: 0, c: 0, type: 0 }], 2, makeDeps({ haptic: false }));
    expect(vib).not.toHaveBeenCalled();
  });

  it('spawns no combo floater for depth < 2 (but still spawns the wave)', () => {
    const deps = makeDeps();
    handleMatchCleared([{ r: 0, c: 0, type: 0 }], 1, deps);
    expect(deps.waves.spawn).toHaveBeenCalledTimes(1);
    expect(drawState().count).toBe(0); // no cascade label
  });
});

describe('combo label localization (depth -> i18n key)', () => {
  const cases = [
    { depth: 2, text: 'NICE!', color: '#ffffff' },
    { depth: 3, text: 'GREAT!', color: '#88ddff' },
    { depth: 4, text: 'AMAZING!', color: '#ff88dd' },
    { depth: 5, text: 'MEGA x5!', color: '#ffd700' },   // combo.mega tier
    { depth: 13, text: 'MEGA x13!', color: '#ffd700' }, // mega font clamps at depth-5=8
  ];
  for (const tc of cases) {
    it(`depth ${tc.depth} -> "${tc.text}"`, () => {
      handleMatchCleared([{ r: 0, c: 0, type: 0 }], tc.depth, makeDeps());
      const s = drawState();
      expect(s.count).toBe(1);
      expect(s.text).toBe(tc.text);
      expect(s.color).toBe(tc.color);
    });
  }

  it('localizes combo labels to the active locale', () => {
    i18n.setLanguage('es');
    try {
      clear();
      handleMatchCleared([{ r: 0, c: 0, type: 0 }], 2, makeDeps());
      expect(drawState().text).toBe('¡BIEN!');
    } finally {
      i18n.setLanguage('en');
    }
  });
});

describe('spawnScore', () => {
  const tiers = [
    { amount: 50, text: '+50', color: '#ffffff' },
    { amount: 200, text: '+200', color: '#a4ffa4' },
    { amount: 600, text: '+600', color: '#ffd166' },
    { amount: 12345, text: '+12,345', color: '#ffd166' }, // formatNumber grouping
  ];
  for (const t of tiers) {
    it(`+${t.amount} renders "${t.text}" with its tier color`, () => {
      spawnScore(0, 0, t.amount);
      const s = drawState();
      expect(s.count).toBe(1);
      expect(s.text).toBe(t.text);
      expect(s.color).toBe(t.color);
    });
  }

  it('ignores non-positive amounts', () => {
    spawnScore(0, 0, 0);
    spawnScore(0, 0, -5);
    expect(drawState().count).toBe(0);
  });
});

describe('spawnText', () => {
  it('spawns a one-off floater with the given text, color and size', () => {
    spawnText(50, 100, 'SPEED x3', '#8fd1ff', 26);
    update(200);                 // popK 200/750 > 0.2 → scale settles to 1
    const s = drawState();
    expect(s.count).toBe(1);
    expect(s.text).toBe('SPEED x3');
    expect(s.color).toBe('#8fd1ff');
    expect(s.ctx.font).toBe('bold 26px -apple-system, system-ui, sans-serif');
  });

  it('rises like a combo floater (rise = 40, not the score 56)', () => {
    spawnText(50, 100, '+2s');
    expect(drawState().mainY).toBe(100);
    update(150);                 // y -= (40/750)*150 = 8 → combo-kind trajectory
    expect(drawState().mainY).toBeCloseTo(92, 3);
    expect(drawState().mainX).toBe(50);   // no fly-to target → x stays put
  });

  it('defaults to white 20px when color/size are omitted', () => {
    spawnText(0, 0, 'plain');
    update(200);
    const s = drawState();
    expect(s.color).toBe('#ffffff');
    expect(s.ctx.font).toBe('bold 20px -apple-system, system-ui, sans-serif');
  });

  it('reuses an evicted slot when the pool is exhausted', () => {
    for (let i = 0; i < FLOATER_POOL; i++) spawnText(0, 0, `t${i}`);
    expect(drawState().count).toBe(FLOATER_POOL);   // full
    spawnText(0, 0, 'LAST');                        // saturated → eviction path
    const s = drawState();
    expect(s.count).toBe(FLOATER_POOL);             // capped, never grows
    expect(s.allTexts).toContain('LAST');           // newest survived the cap
  });
});

describe('update', () => {
  it('is a no-op when nothing is alive', () => {
    update(16); // aliveCount === 0 -> early return
    expect(drawState().count).toBe(0);
  });

  it('rises combo floaters and settles the pop scale', () => {
    handleMatchCleared([{ r: 0, c: 0, type: 0 }], 2, makeDeps()); // combo at (30, 0)
    expect(drawState().mainY).toBe(0);
    update(200); // combo rise = 40/maxLife; popK = 200/700 > 0.2 -> scale settles to 1
    // y -= (40/700)*200 = 11.4286
    expect(drawState().mainY).toBeCloseTo(-11.4286, 3);
  });

  it('rises a score floater that has no fly-to target (rise = 56)', () => {
    spawnScore(0, 100, 50); // no targetX/Y -> default null -> else branch
    expect(drawState().mainY).toBe(100);
    update(100); // y -= (56/850)*100 = 6.588
    expect(drawState().mainY).toBeCloseTo(93.4118, 3);
  });

  it('flies a targeted score floater toward its destination (easeInOutQuad)', () => {
    spawnScore(0, 0, 600, 100, 100); // targetX/Y set -> fly-to branch
    update(100); // k = 100/850 = 0.1176 < 0.5 -> ease = 2k^2
    const x1 = drawState().mainX;
    expect(x1).toBeCloseTo(100 * (2 * (100 / 850) ** 2), 3); // ~2.768
    update(400); // total k = 500/850 = 0.588 >= 0.5 -> other ease half
    const x2 = drawState().mainX;
    expect(x2).toBeGreaterThan(x1);
    expect(x2).toBeLessThan(100);
    expect(x2).toBeCloseTo(66.0902, 3);
  });

  it('kills a floater once its life is spent', () => {
    spawnScore(0, 0, 50);     // maxLife 850
    update(900);              // life <= 0 -> dead
    expect(drawState().count).toBe(0);
  });
});

describe('draw scale curves', () => {
  it('pops a freshly spawned score floater below full size then settles', () => {
    spawnScore(0, 0, 50);
    // fresh: popK 0 < 0.15 -> scale 0.6 path (covered just by drawing here)
    expect(drawState().count).toBe(1);
    update(200);              // popK 200/850 = 0.235 >= 0.15 -> scale 1 path
    expect(drawState().count).toBe(1);
  });
});

describe('pool cap (eviction)', () => {
  it('evicts the closest-to-dying floater instead of growing past the pool', () => {
    // index 0 = a score floater (maxLife 850); indices 1..31 = combo floaters
    // (maxLife 700). After one tick the combos have the lower life ratio, so the
    // eviction scan must walk past index 0 (false) and pick a combo (true).
    spawnScore(0, 0, 50);
    for (let i = 0; i < FLOATER_POOL - 1; i++) {
      handleMatchCleared([{ r: 0, c: 0, type: 0 }], 2, makeDeps());
    }
    expect(drawState().count).toBe(FLOATER_POOL); // full

    update(100); // score ratio 750/850 > combo ratio 600/700
    spawnScore(0, 0, 777); // pool saturated -> eviction, not growth

    const s = drawState();
    expect(s.count).toBe(FLOATER_POOL);         // capped, never exceeds the pool
    expect(s.allTexts).toContain('+777');       // new floater took an evicted slot
  });
});

describe('handleSpecialActivated', () => {
  function makeSpecialDeps(over = {}) {
    return {
      render: { getCellSize: () => 40, layout: { boardX: 10, boardY: 20, boardSize: 320 } },
      waves: { spawn: vi.fn() },
      bolts: { spawnLightning: vi.fn(), spawnStarTrail: vi.fn() },
      particles: { spawnBurst: vi.fn() },
      palettes: [['#r0', '#r1']],
      SPECIAL,
      haptic: false,
      ...over,
    };
  }
  // from = (30, 40); a target at {r:1,c:1} maps to (70, 80).

  it('COLOR_BOMB fires two stacked shockwaves and a double-buzz haptic', () => {
    const vib = vi.spyOn(navigator, 'vibrate');
    const deps = makeSpecialDeps({ haptic: true });
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.COLOR_BOMB }, deps); // no targets -> [] default
    expect(deps.waves.spawn).toHaveBeenCalledTimes(2);
    expect(deps.waves.spawn).toHaveBeenNthCalledWith(1, 30, 40, 'rgba(255,255,255,0.9)', 200, 600);
    expect(deps.waves.spawn).toHaveBeenNthCalledWith(2, 30, 40, 'rgba(180,210,255,0.7)', 140, 500);
    expect(vib).toHaveBeenCalledWith([0, 30, 20, 30]);
  });

  it('LIGHTNING arcs from source to every target', () => {
    const deps = makeSpecialDeps();
    handleSpecialActivated(
      { r: 0, c: 0, special: SPECIAL.LIGHTNING, targets: [{ r: 1, c: 1 }, { r: 2, c: 0 }] },
      deps,
    );
    expect(deps.bolts.spawnLightning).toHaveBeenCalledTimes(2);
    expect(deps.bolts.spawnLightning).toHaveBeenNthCalledWith(1, 30, 40, 70, 80);
    expect(deps.bolts.spawnLightning).toHaveBeenNthCalledWith(2, 30, 40, 30, 120);
  });

  it('FIRE rings out and sparks toward each neighbour when palettes exist', () => {
    const deps = makeSpecialDeps();
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.FIRE, targets: [{ r: 1, c: 1 }] }, deps);
    expect(deps.waves.spawn).toHaveBeenCalledWith(30, 40, 'rgba(255,140,40,0.7)', 72, 360);
    // spark spawns at the midpoint (50, 60).
    expect(deps.particles.spawnBurst).toHaveBeenCalledWith(50, 60, ['#ff5722', '#ff8a3d', '#ffd166'], 8);
  });

  it('FIRE skips sparks when palettes are absent', () => {
    const deps = makeSpecialDeps({ palettes: null });
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.FIRE, targets: [{ r: 1, c: 1 }] }, deps);
    expect(deps.waves.spawn).toHaveBeenCalledTimes(1);
    expect(deps.particles.spawnBurst).not.toHaveBeenCalled();
  });

  it('STAR trails from source to every target', () => {
    const deps = makeSpecialDeps();
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.STAR, targets: [{ r: 1, c: 1 }] }, deps);
    expect(deps.bolts.spawnStarTrail).toHaveBeenCalledWith(30, 40, 70, 80);
  });

  it('AREA_BOMB fires one orange wave', () => {
    const deps = makeSpecialDeps();
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.AREA_BOMB }, deps);
    expect(deps.waves.spawn).toHaveBeenCalledWith(30, 40, 'rgba(255,138,61,0.85)', 104, 420);
  });

  it('LINE_H and LINE_V share one directional wave', () => {
    const h = makeSpecialDeps();
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.LINE_H }, h);
    expect(h.waves.spawn).toHaveBeenCalledWith(30, 40, 'rgba(200,220,255,0.6)', 80, 320);

    const v = makeSpecialDeps();
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.LINE_V }, v);
    expect(v.waves.spawn).toHaveBeenCalledWith(30, 40, 'rgba(200,220,255,0.6)', 80, 320);
  });

  it('does nothing visual for a special with no FX case', () => {
    const deps = makeSpecialDeps();
    handleSpecialActivated({ r: 0, c: 0, special: SPECIAL.COIN }, deps);
    expect(deps.waves.spawn).not.toHaveBeenCalled();
    expect(deps.bolts.spawnLightning).not.toHaveBeenCalled();
    expect(deps.bolts.spawnStarTrail).not.toHaveBeenCalled();
    expect(deps.particles.spawnBurst).not.toHaveBeenCalled();
  });
});
