import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// sound.js holds module state (the lazily-created AudioContext, the enabled
// flag, the shared noise buffer, the live pad graph), so every test
// re-imports a fresh copy via vi.resetModules() + dynamic import — the same
// pattern the wakeLock import-guard tests use. jsdom ships no AudioContext
// at all, which conveniently IS the unsupported environment; the supported
// paths stub a recording fake onto globalThis before calling unlock().

// ---------------------------------------------------------------------------
// Recording fake Web Audio. Every node is a plain object whose methods are
// vi.fn()s, and the context keeps typed lists of what it created, so tests
// can assert on the scheduled graph — not merely that nothing threw.

class FakeParam {
  constructor(value = 0) {
    this.value = value;
    this.setValueAtTime = vi.fn();
    this.linearRampToValueAtTime = vi.fn();
    this.exponentialRampToValueAtTime = vi.fn();
    this.cancelScheduledValues = vi.fn();
  }
}

function baseNode(kind) {
  return { kind, connect: vi.fn(), disconnect: vi.fn() };
}

class FakeAudioContext {
  static instances = [];

  constructor() {
    FakeAudioContext.instances.push(this);
    this.state = 'suspended';        // pre-gesture state — unlock() must resume
    this.currentTime = 0;
    this.sampleRate = 8000;          // small so the noise-fill loop stays cheap
    this.destination = baseNode('destination');
    this.oscillators = [];
    this.gains = [];
    this.filters = [];
    this.sources = [];
    this.buffersCreated = 0;
    this.resume = vi.fn(() => { this.state = 'running'; return Promise.resolve(); });
  }

  createGain() {
    const n = { ...baseNode('gain'), gain: new FakeParam(1) };
    this.gains.push(n);
    return n;
  }

  createOscillator() {
    const n = {
      ...baseNode('oscillator'),
      type: 'sine',
      frequency: new FakeParam(440),
      detune: new FakeParam(0),
      start: vi.fn(),
      stop: vi.fn(),
      onended: null,
    };
    this.oscillators.push(n);
    return n;
  }

  createBiquadFilter() {
    const n = {
      ...baseNode('filter'),
      type: 'lowpass',
      frequency: new FakeParam(350),
      Q: new FakeParam(1),
    };
    this.filters.push(n);
    return n;
  }

  createBufferSource() {
    const n = { ...baseNode('source'), buffer: null, start: vi.fn(), stop: vi.fn() };
    this.sources.push(n);
    return n;
  }

  createBuffer(channels, length) {
    this.buffersCreated++;
    const data = new Float32Array(length);
    return { numberOfChannels: channels, length, getChannelData: () => data };
  }
}

let sound;

beforeEach(async () => {
  FakeAudioContext.instances.length = 0;
  vi.resetModules();
  sound = await import('../src/sound.js');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// Stub the given constructor as the global AudioContext, unlock, and hand
// back the created context so tests can inspect its node lists.
function unlocked(Ctor = FakeAudioContext) {
  vi.stubGlobal('AudioContext', Ctor);
  sound.unlock();
  return FakeAudioContext.instances[0];
}

// Every one-shot play function with representative args for sweep tests.
const ONE_SHOTS = {
  matchPop: [2],
  swapClick: [],
  invalidBuzz: [],
  specialWhoosh: ['color'],
  bombTick: [],
  bombBoom: [],
  powerupZap: [],
  milestoneDing: [],
  achievementChime: [],
  uiTap: [],
  winFanfare: [],
  loseThud: [],
  timeUpHorn: [],
  blitzTick: [],
};
const callAllOneShots = () => {
  for (const [name, args] of Object.entries(ONE_SHOTS)) sound[name](...args);
};

function nodeCount(c) {
  return c.oscillators.length + c.gains.length + c.filters.length + c.sources.length;
}

describe('api surface', () => {
  it('exports exactly the documented API', () => {
    expect(Object.keys(sound).sort()).toEqual([
      ...Object.keys(ONE_SHOTS),
      'unlock', 'setEnabled', 'isEnabled', 'startZenPad', 'stopZenPad',
    ].sort());
  });
});

describe('without Web Audio (jsdom default)', () => {
  it('unlock and every play call are permanent no-ops that never throw', () => {
    expect(() => {
      sound.unlock();
      sound.unlock();          // still nothing — the guard is permanent
      callAllOneShots();
      sound.startZenPad();
      sound.stopZenPad();
    }).not.toThrow();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });

  it('defaults to enabled and setEnabled still tracks the flag', () => {
    expect(sound.isEnabled()).toBe(true);
    sound.setEnabled(false);
    expect(sound.isEnabled()).toBe(false);
    sound.setEnabled('yes');   // coerced to a boolean
    expect(sound.isEnabled()).toBe(true);
  });
});

describe('unlock()', () => {
  it('creates the context + 0.5 master bus and resumes the suspended context', () => {
    const c = unlocked();
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(c.gains).toHaveLength(1);                       // just the master bus
    expect(c.gains[0].gain.value).toBe(0.5);
    expect(c.gains[0].connect).toHaveBeenCalledWith(c.destination);
    expect(c.resume).toHaveBeenCalledTimes(1);
    expect(c.state).toBe('running');
  });

  it('is idempotent — repeat calls neither recreate nor re-resume', () => {
    const c = unlocked();
    sound.unlock();                                        // ctx exists, state running
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(c.resume).toHaveBeenCalledTimes(1);
    expect(c.gains).toHaveLength(1);
  });

  it('falls back to webkitAudioContext when AudioContext is absent', () => {
    vi.stubGlobal('webkitAudioContext', FakeAudioContext);
    sound.unlock();
    expect(FakeAudioContext.instances).toHaveLength(1);
  });

  it('swallows a throwing constructor and stays a no-op afterward', () => {
    class BoomCtx { constructor() { throw new Error('no audio for you'); } }
    vi.stubGlobal('AudioContext', BoomCtx);
    expect(() => sound.unlock()).not.toThrow();
    expect(() => sound.swapClick()).not.toThrow();         // ctx stayed null
  });

  it('swallows a rejected resume()', async () => {
    class RejectingCtx extends FakeAudioContext {
      constructor() {
        super();
        this.resume = vi.fn(() => Promise.reject(new Error('denied')));
      }
    }
    expect(() => unlocked(RejectingCtx)).not.toThrow();
    await new Promise((r) => setTimeout(r, 0));            // rejection handled, not unhandled
  });

  it('does not create a context from play calls — only unlock() may', () => {
    vi.stubGlobal('AudioContext', FakeAudioContext);
    callAllOneShots();
    sound.startZenPad();
    expect(FakeAudioContext.instances).toHaveLength(0);
  });
});

describe('setEnabled gating', () => {
  it('disabled → every play call is a no-op; re-enabled → sounds flow again', () => {
    const c = unlocked();
    sound.setEnabled(false);
    const before = nodeCount(c);
    callAllOneShots();
    sound.startZenPad();
    expect(nodeCount(c)).toBe(before);                     // nothing was built
    sound.setEnabled(true);
    sound.swapClick();
    expect(c.oscillators).toHaveLength(1);
  });

  it('disabling mid-run silences a playing zen pad', () => {
    const c = unlocked();
    sound.startZenPad();
    sound.setEnabled(false);
    for (const o of c.oscillators) expect(o.stop).toHaveBeenCalledTimes(1);
    sound.stopZenPad();                                    // already stopped — no-op
    for (const o of c.oscillators) expect(o.stop).toHaveBeenCalledTimes(1);
  });
});

describe('one-shot SFX', () => {
  it('every one-shot creates nodes and schedules a self-terminating start/stop', () => {
    const c = unlocked();
    for (const [name, args] of Object.entries(ONE_SHOTS)) {
      const before = nodeCount(c);
      sound[name](...args);
      expect(nodeCount(c), `${name} should create nodes`).toBeGreaterThan(before);
    }
    const scheduled = [...c.oscillators, ...c.sources];
    expect(scheduled.length).toBeGreaterThan(0);
    for (const n of scheduled) {
      expect(n.start).toHaveBeenCalledTimes(1);
      expect(n.stop).toHaveBeenCalledTimes(1);
      expect(n.stop.mock.calls[0][0]).toBeGreaterThan(n.start.mock.calls[0][0]);
    }
  });

  it('matchPop pitch rises with cascade depth and caps at depth 8', () => {
    const c = unlocked();
    const mainFreq = (i) => c.oscillators[i * 2].frequency.setValueAtTime.mock.calls[0][0];
    sound.matchPop();          // default depth = 1
    sound.matchPop(5);
    sound.matchPop(8);
    sound.matchPop(99);        // clamped to 8
    expect(mainFreq(0)).toBeCloseTo(330);
    expect(mainFreq(1)).toBeCloseTo(330 * 2 ** (4 / 6));
    expect(mainFreq(1)).toBeGreaterThan(mainFreq(0));
    expect(mainFreq(2)).toBeGreaterThan(mainFreq(1));
    expect(mainFreq(3)).toBe(mainFreq(2));
    // the sparkle layer sits an octave above the pluck
    const sparkle = c.oscillators[1].frequency.setValueAtTime.mock.calls[0][0];
    expect(sparkle).toBeCloseTo(mainFreq(0) * 2);
  });

  it('swapClick runs the full pluck envelope: attack → decay → scheduled stop', () => {
    const c = unlocked();
    sound.swapClick();
    const osc = c.oscillators[0];
    const g = c.gains[1];                                  // gains[0] is the master bus
    expect(osc.type).toBe('sine');
    expect(osc.frequency.setValueAtTime).toHaveBeenCalledWith(1900, 0);
    expect(g.gain.setValueAtTime).toHaveBeenCalledWith(0, 0);
    expect(g.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.12, 0.004);
    const [expTarget, expTime] = g.gain.exponentialRampToValueAtTime.mock.calls[0];
    expect(expTarget).toBeCloseTo(0.001);
    expect(expTime).toBeCloseTo(0.035);
    expect(osc.connect).toHaveBeenCalledWith(g);
    expect(g.connect).toHaveBeenCalledWith(c.gains[0]);
    expect(osc.start).toHaveBeenCalledWith(0);
    expect(osc.stop.mock.calls[0][0]).toBeCloseTo(0.085);
  });

  it('each whoosh kind sweeps its own filter variant', () => {
    const c = unlocked();
    const expected = {
      line:      ['bandpass', 300, 2800],
      area:      ['lowpass', 2200, 150],
      color:     ['bandpass', 150, 3800],
      fire:      ['bandpass', 500, 1400],
      lightning: ['highpass', 2500, 9000],
      star:      ['bandpass', 400, 2400],
    };
    const kinds = Object.keys(expected);
    for (const kind of kinds) sound.specialWhoosh(kind);
    kinds.forEach((kind, i) => {
      const f = c.filters[i];
      const [type, from, to] = expected[kind];
      expect(f.type, kind).toBe(type);
      expect(f.frequency.setValueAtTime).toHaveBeenCalledWith(from, 0);
      expect(f.frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(to);
    });
    // lightning is the fast one, color the long one
    const dur = (i) => c.filters[i].frequency.exponentialRampToValueAtTime.mock.calls[0][1];
    expect(dur(kinds.indexOf('lightning'))).toBeLessThan(dur(kinds.indexOf('color')));
    // only star layers a sparkle ping on top of its noise sweep
    expect(c.oscillators).toHaveLength(1);
    expect(c.oscillators[0].frequency.setValueAtTime).toHaveBeenCalledWith(1568, 0);
    // every sweep reused the one pooled noise buffer
    expect(c.buffersCreated).toBe(1);
    expect(c.sources.every((s) => s.buffer !== null)).toBe(true);
  });

  it('an unknown whoosh kind falls back to the generic line sweep', () => {
    const c = unlocked();
    sound.specialWhoosh('gravity');
    expect(c.filters[0].type).toBe('bandpass');
    expect(c.filters[0].frequency.setValueAtTime).toHaveBeenCalledWith(300, 0);
  });

  it('bombTick knocks (pitch drop) and bombBoom layers thump + noise burst', () => {
    const c = unlocked();
    sound.bombTick();
    expect(c.oscillators[0].frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(700);
    sound.bombBoom();
    expect(c.oscillators[1].frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(45);
    expect(c.sources).toHaveLength(1);                     // the debris noise
    expect(c.filters[0].type).toBe('lowpass');
  });

  it('achievementChime plays two notes, the second delayed', () => {
    const c = unlocked();
    sound.achievementChime();
    expect(c.oscillators).toHaveLength(2);
    expect(c.oscillators[0].start).toHaveBeenCalledWith(0);
    expect(c.oscillators[1].start.mock.calls[0][0]).toBeCloseTo(0.1);
  });

  it('winFanfare schedules three ascending notes and lets the last ring out', () => {
    const c = unlocked();
    sound.winFanfare();
    expect(c.oscillators).toHaveLength(3);
    const freqs = c.oscillators.map((o) => o.frequency.setValueAtTime.mock.calls[0][0]);
    expect(freqs[0]).toBeLessThan(freqs[1]);
    expect(freqs[1]).toBeLessThan(freqs[2]);
    const starts = c.oscillators.map((o) => o.start.mock.calls[0][0]);
    expect(starts[0]).toBeCloseTo(0);
    expect(starts[1]).toBeCloseTo(0.13);
    expect(starts[2]).toBeCloseTo(0.26);
    const ring = (o) => o.stop.mock.calls[0][0] - o.start.mock.calls[0][0];
    expect(ring(c.oscillators[2])).toBeGreaterThan(ring(c.oscillators[0]));
  });

  it('timeUpHorn detunes its two sawtooths against each other', () => {
    const c = unlocked();
    sound.timeUpHorn();
    expect(c.oscillators.map((o) => o.type)).toEqual(['sawtooth', 'sawtooth']);
    expect(c.oscillators.map((o) => o.detune.value).sort((a, b) => a - b)).toEqual([-8, 8]);
  });

  it('uiTap is much quieter than gameplay ticks', () => {
    const c = unlocked();
    sound.uiTap();
    sound.swapClick();
    const peak = (i) => c.gains[i + 1].gain.linearRampToValueAtTime.mock.calls[0][0];
    expect(peak(0)).toBeLessThan(peak(1));
    expect(peak(0)).toBeLessThanOrEqual(0.05);
  });

  it('gives the remaining cues distinct voices', () => {
    const c = unlocked();
    sound.invalidBuzz();
    sound.powerupZap();
    sound.blitzTick();
    sound.loseThud();
    expect(c.oscillators.map((o) => o.type)).toEqual(['square', 'sawtooth', 'square', 'sine']);
    // zap glides up, thud glides down
    expect(c.oscillators[1].frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(950);
    expect(c.oscillators[3].frequency.exponentialRampToValueAtTime.mock.calls[0][0]).toBe(55);
  });
});

describe('zen pad', () => {
  it('builds two detuned voices + LFO through a lowpass at very low gain', () => {
    const c = unlocked();
    sound.startZenPad();
    expect(c.oscillators).toHaveLength(3);                 // voice a, voice b, LFO
    const [a, b, lfo] = c.oscillators;
    expect(a.type).toBe('sine');
    expect(b.type).toBe('triangle');
    expect(a.frequency.value).toBe(110);
    expect(b.frequency.value).toBe(110);
    expect(a.detune.value).toBe(-6);
    expect(b.detune.value).toBe(7);
    expect(lfo.frequency.value).toBeCloseTo(0.07);
    const filter = c.filters[0];
    expect(filter.type).toBe('lowpass');
    expect(filter.frequency.value).toBe(320);
    const padGain = c.gains[1];
    const lfoAmp = c.gains[2];
    expect(padGain.gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.05, 2.5);
    expect(lfoAmp.gain.value).toBe(130);
    expect(lfoAmp.connect).toHaveBeenCalledWith(filter.frequency);   // LFO → cutoff
    expect(padGain.connect).toHaveBeenCalledWith(c.gains[0]);        // → master bus
    for (const o of c.oscillators) expect(o.start).toHaveBeenCalledTimes(1);
  });

  it('start is idempotent while the pad is already humming', () => {
    const c = unlocked();
    sound.startZenPad();
    const before = nodeCount(c);
    sound.startZenPad();
    expect(nodeCount(c)).toBe(before);
  });

  it('stop releases the gain, stops the oscillators, and frees nodes onended', () => {
    const c = unlocked();
    sound.startZenPad();
    const padGain = c.gains[1];
    sound.stopZenPad();
    expect(padGain.gain.cancelScheduledValues).toHaveBeenCalled();
    expect(padGain.gain.linearRampToValueAtTime).toHaveBeenLastCalledWith(0, 0.6);
    for (const o of c.oscillators) expect(o.stop).toHaveBeenCalledWith(0.7);
    // the graph is only disconnected once the release tail has played out
    expect(c.oscillators[0].disconnect).not.toHaveBeenCalled();
    expect(typeof c.oscillators[0].onended).toBe('function');
    c.oscillators[0].onended();
    for (const o of c.oscillators) expect(o.disconnect).toHaveBeenCalledTimes(1);
    expect(c.filters[0].disconnect).toHaveBeenCalledTimes(1);
    expect(c.gains[1].disconnect).toHaveBeenCalledTimes(1);
    expect(c.gains[2].disconnect).toHaveBeenCalledTimes(1);
  });

  it('stop is idempotent (and a no-op before any start)', () => {
    const c = unlocked();
    sound.stopZenPad();                                    // never started — nothing to do
    expect(nodeCount(c)).toBe(1);                          // still just the master bus
    sound.startZenPad();
    sound.stopZenPad();
    sound.stopZenPad();                                    // second stop must not re-schedule
    for (const o of c.oscillators) expect(o.stop).toHaveBeenCalledTimes(1);
  });

  it('can start a fresh pad after stopping the previous one', () => {
    const c = unlocked();
    sound.startZenPad();
    sound.stopZenPad();
    sound.startZenPad();
    expect(c.oscillators).toHaveLength(6);                 // a brand-new graph
  });
});

describe('exception safety', () => {
  it('a context that dies mid-play never lets an exception reach the caller', () => {
    class DyingCtx extends FakeAudioContext {
      createOscillator() { throw new Error('audio backend died'); }
      createBufferSource() { throw new Error('audio backend died'); }
    }
    unlocked(DyingCtx);                                    // createGain still works for the bus
    expect(() => {
      callAllOneShots();
      sound.startZenPad();                                 // dies at its first oscillator
      sound.stopZenPad();                                  // pad never latched — no-op
    }).not.toThrow();
  });

  it('a throwing teardown still clears the pad so a new one can start', () => {
    const c = unlocked();
    sound.startZenPad();
    for (const o of c.oscillators) o.stop = vi.fn(() => { throw new Error('dead'); });
    expect(() => sound.stopZenPad()).not.toThrow();
    sound.startZenPad();                                   // pad was not wedged
    expect(c.oscillators).toHaveLength(6);
  });

  it('a throwing disconnect inside the onended cleanup is swallowed', () => {
    const c = unlocked();
    sound.startZenPad();
    sound.stopZenPad();
    c.oscillators[0].disconnect = vi.fn(() => { throw new Error('gone'); });
    expect(() => c.oscillators[0].onended()).not.toThrow();
  });
});
