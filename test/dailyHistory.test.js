import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installCanvas, setViewport } from './helpers.js';

// dailyHistory imports render (-> main) and main directly.
vi.mock('../src/main.js', () => ({ clockMs: () => 0, setScene: vi.fn() }));

import * as render from '../src/render.js';
import * as storage from '../src/storage.js';
import * as i18n from '../src/i18n.js';
import { setScene } from '../src/main.js';
import { todayISO } from '../src/rng.js';
import * as dailyHistory from '../src/scenes/dailyHistory.js';

beforeEach(() => {
  installCanvas();
  setViewport(800, 600, 1);
  render.setupCanvas();
  render.buildAtlas();
  storage.reset();
  i18n.init();
});

// Same local-safe date math dailyMeta uses: roll a local Date via setDate and
// format with todayISO. Never `new Date('YYYY-MM-DD')` (that parses as UTC
// midnight and lands on the wrong calendar day west of Greenwich).
function isoDaysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return todayISO(d);
}
// The 28-day window the scene renders (WEEKS(4) × DAYS(7)), oldest → today.
function last28Isos() {
  const out = [];
  for (let i = 27; i >= 0; i--) out.push(isoDaysAgo(i));
  return out;
}
// Cells label themselves with the day-of-month, no leading zero. Within any
// 28-consecutive-day window every label is unique (months have ≥28 days).
const dayLabel = (iso) => String(Number(iso.slice(8, 10)));

function back() {
  const col = render.menuColumn();
  const backW = render.layout.isNarrow ? 56 : 76;
  const backY = 24 + render.layout.safeTop;
  return { x: col.right - backW + backW / 2, y: backY + 16 };
}
const down = (x, y) => dailyHistory.onPointer({ type: 'down', x, y });
// draw() and return only the ctx calls recorded during THIS frame.
function drawFrame() {
  const calls = render.ctxRef().__calls;
  const start = calls.length;
  dailyHistory.draw();
  return calls.slice(start);
}
const drew = (calls, s) => calls.some((c) => c[0] === 'fillText' && c[1][0] === s);
// Whether the calendar cell that drew `label` got a highlight stroke: scan
// back from its fillText to the cell's own save() and look for a stroke().
function cellStroked(calls, label) {
  const idx = calls.findIndex((c) => c[0] === 'fillText' && c[1][0] === label);
  expect(idx).toBeGreaterThan(-1);
  let start = idx;
  while (start > 0 && calls[start][0] !== 'save') start--;
  return calls.slice(start, idx).some((c) => c[0] === 'stroke');
}

describe('dailyHistory: enter/exit', () => {
  it('enter() sets the daily body background; exit() clears it', () => {
    dailyHistory.enter();
    expect(document.body.className).toBe('daily-bg');
    dailyHistory.exit();
    expect(document.body.className).toBe('');
  });

  it('update() is a no-op', () => {
    expect(() => dailyHistory.update(16)).not.toThrow();
  });
});

describe('dailyHistory: rendering', () => {
  it('empty history: title, empty message, "0 played", and a 28-cell calendar', () => {
    dailyHistory.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('dailyHistory.title'))).toBe(true);
    expect(drew(calls, i18n.t('dailyHistory.empty'))).toBe(true);
    // Summary collapses to just the total: streak 0 (< 2) and bestEver 0 drop out.
    expect(drew(calls, i18n.t('dailyHistory.totalPlayed', { n: 0 }))).toBe(true);
    // All 28 day-of-month labels, drawn in window order (oldest → today).
    const dayTexts = calls
      .filter((c) => c[0] === 'fillText' && /^\d{1,2}$/.test(c[1][0]))
      .map((c) => c[1][0]);
    expect(dayTexts).toEqual(last28Isos().map(dayLabel));
    // 28 cell roundRects + the Back button = 29 paths this frame.
    expect(calls.filter((c) => c[0] === 'beginPath').length).toBe(29);
  });

  it("today's cell (and only today's) gets the highlight stroke", () => {
    dailyHistory.enter();
    const calls = drawFrame();
    expect(cellStroked(calls, dayLabel(todayISO()))).toBe(true);
    expect(cellStroked(calls, dayLabel(isoDaysAgo(1)))).toBe(false);
    // Exactly two strokes per frame: today's highlight + the Back button border.
    expect(calls.filter((c) => c[0] === 'stroke').length).toBe(2);
  });

  it('seeded history: day numbers, per-day scores, and the streak/totals summary', () => {
    const today = todayISO();
    const yesterday = isoDaysAgo(1);
    storage.saveKey('daily', {
      history: {
        [today]: { score: 1234, movesUsed: 20 },
        [yesterday]: { score: 567, movesUsed: 25 },
      },
      totalDaysPlayed: 2,
      bestEver: 1234,
    });
    dailyHistory.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('dailyHistory.empty'))).toBe(false);
    // Played cells: day number on top, score below.
    expect(drew(calls, dayLabel(today))).toBe(true);
    expect(drew(calls, dayLabel(yesterday))).toBe(true);
    expect(drew(calls, i18n.formatNumber(1234))).toBe(true);
    expect(drew(calls, i18n.formatNumber(567))).toBe(true);
    expect(cellStroked(calls, dayLabel(today))).toBe(true);
    // Summary line: 2-day streak · 2 played · best ever, dot-joined.
    const summary = [
      i18n.t('daily.streak', { n: 2 }),
      i18n.t('dailyHistory.totalPlayed', { n: 2 }),
      i18n.t('result.bestEver', { score: i18n.formatNumber(1234) }),
    ].join('   ·   ');
    expect(drew(calls, summary)).toBe(true);
  });

  it('missing history blob (pre-daily save shape) falls back to the empty calendar', () => {
    storage.saveKey('daily', { history: null });
    dailyHistory.enter();
    const calls = drawFrame();
    expect(drew(calls, i18n.t('dailyHistory.empty'))).toBe(true);
  });

  it('renders on a narrow viewport (small cells, short back label) and Back works', () => {
    setViewport(400, 700, 1);
    render.setupCanvas();
    render.buildAtlas();
    dailyHistory.enter();
    const calls = drawFrame();
    expect(render.layout.isNarrow).toBe(true);
    expect(drew(calls, i18n.t('common.backShort'))).toBe(true);
    // Still a full 28-cell grid + Back at the smaller cell size.
    expect(calls.filter((c) => c[0] === 'beginPath').length).toBe(29);
    const b = back();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });
});

describe('dailyHistory: input', () => {
  it('tapping Back returns to title (with hover tracked via onMove)', () => {
    dailyHistory.enter();
    dailyHistory.draw();
    const b = back();
    dailyHistory.onMove(b.x, b.y); // hover the button, then redraw + tap
    dailyHistory.draw();
    down(b.x, b.y);
    expect(setScene).toHaveBeenCalledWith('title');
  });

  it('taps that miss on every side do nothing; non-down events are ignored', () => {
    dailyHistory.enter();
    dailyHistory.draw();
    const b = back();
    down(b.x - 200, b.y);  // left of the button
    down(b.x + 200, b.y);  // right of the button
    down(b.x, 2);          // above
    down(b.x, 300);        // below
    dailyHistory.onPointer({ type: 'up', x: b.x, y: b.y });
    dailyHistory.onPointer({ type: 'cancel' });
    expect(setScene).not.toHaveBeenCalled();
  });
});
