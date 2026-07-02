// Procedural WebAudio SFX — every sound is synthesized on the fly from
// oscillators, gain envelopes, and filtered white noise. No audio assets and
// no imports: scenes read the persisted setting and push it in through
// setEnabled(), keeping this module dependency-free. The AudioContext is
// created lazily by unlock(), which input code calls on the first pointer
// gesture — browser autoplay policy rejects contexts created any earlier.
// Every play call degrades to a cheap no-op while audio is unsupported,
// still locked, or disabled.

const MASTER_LEVEL = 0.5;    // headroom so overlapping SFX don't clip
const PAD_LEVEL    = 0.05;   // zen pad hums far below the one-shots

let ctx = null;        // AudioContext — created once, in unlock()
let master = null;     // master bus; every sound routes through it
let enabled = true;    // module-level mute; scenes own the persisted setting
let noiseBuf = null;   // 1s of white noise, generated once and reused (pooled)
let pad = null;        // live zen-pad node graph, or null when silent

// Create (once) and resume the shared AudioContext. Must be called from a
// user gesture; safe to call on every gesture — creation and resume are both
// guarded, so repeat calls are nearly free.
export function unlock() {
  // No Web Audio at all (ancient browser, exotic webview, jsdom) → permanent
  // no-op: ctx stays null and every play function bails out early.
  if (typeof AudioContext === 'undefined' && typeof webkitAudioContext === 'undefined') return;
  try {
    if (!ctx) {
      const AC = typeof AudioContext !== 'undefined' ? AudioContext : webkitAudioContext;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = MASTER_LEVEL;
      master.connect(ctx.destination);
    }
    // A context created outside a gesture starts 'suspended'; resume() here
    // runs inside the gesture handler, where autoplay policy allows it. It
    // returns a promise — swallow a rejection (e.g. iOS mid-interruption).
    if (ctx.state === 'suspended') Promise.resolve(ctx.resume()).catch(() => {});
  } catch {
    ctx = null;      // constructor failed (too many contexts?) — retry next gesture
    master = null;
  }
}

export function setEnabled(v) {
  enabled = !!v;
  // One-shots gate themselves, but the pad is continuous — turning sound off
  // must silence it now, not merely block future plays.
  if (!enabled) stopZenPad();
}

export function isEnabled() { return enabled; }

// --- synthesis primitives ------------------------------------------------

// Wrap a play function so it is a cheap no-op while disabled/locked and can
// never throw — a dying AudioContext (device sleep, tab discard, hardware
// loss) must never crash the game loop over a decorative sound.
function guarded(fn) {
  return (...args) => {
    if (!enabled || !ctx) return;
    try { fn(...args); } catch { /* decorative — swallow */ }
  };
}

// One oscillator through its own attack/decay gain envelope into the master
// bus. The envelope is what turns a raw beep into a pluck or tick: a fast
// linear attack avoids clicks, an exponential decay gives a natural tail.
// opts: type, freq (Hz), dur (s), peak, and optionally when (s offset),
// endFreq (pitch glide), attack (s), detune (cents).
function tone(o) {
  const t0 = ctx.currentTime + (o.when || 0);
  const osc = ctx.createOscillator();
  osc.type = o.type;
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.endFreq) osc.frequency.exponentialRampToValueAtTime(o.endFreq, t0 + o.dur);
  if (o.detune) osc.detune.value = o.detune;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.peak, t0 + (o.attack || 0.004));
  g.gain.exponentialRampToValueAtTime(0.001, t0 + o.dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.05);   // self-terminating — no node leaks
}

// White noise generated once into a shared 1-second buffer — same pooling
// philosophy as the particle/wave pools: allocate once, reuse forever.
function getNoiseBuffer() {
  if (!noiseBuf) {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

// A noise burst through a swept biquad filter — the basis of every whoosh,
// crackle, and explosion. The filter sweep (from→to Hz over dur) is what
// reads as motion; q controls how "focused" the sweep sounds.
// opts: filter (biquad type), from, to, q, dur, peak, optionally attack (s).
function noise(o) {
  const t0 = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = getNoiseBuffer();
  const f = ctx.createBiquadFilter();
  f.type = o.filter;
  f.frequency.setValueAtTime(o.from, t0);
  f.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
  f.Q.value = o.q;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(o.peak, t0 + (o.attack || 0.01));
  g.gain.exponentialRampToValueAtTime(0.001, t0 + o.dur);
  src.connect(f);
  f.connect(g);
  g.connect(master);
  src.start(t0);
  src.stop(t0 + o.dur + 0.05);
}

// --- one-shot SFX ----------------------------------------------------------

// Match clear: short triangle pluck plus a quiet octave-up sine for sparkle.
// Pitch climbs two semitones per cascade level so chains "sing" upward,
// capped at depth 8 before it turns shrill.
export const matchPop = guarded((depth = 1) => {
  const d = Math.min(Math.max(depth, 1), 8);
  const freq = 330 * Math.pow(2, (d - 1) / 6);
  tone({ type: 'triangle', freq, dur: 0.14, peak: 0.28 });
  tone({ type: 'sine', freq: freq * 2, dur: 0.09, peak: 0.08 });
});

// Gem swap: a tiny high sine tick — audible feedback that stays unobtrusive
// at swap rates.
export const swapClick = guarded(() => {
  tone({ type: 'sine', freq: 1900, dur: 0.035, peak: 0.12 });
});

// Rejected swap: short low square buzz — the square's odd harmonics read
// as "nope" where a sine would just sound like a hum.
export const invalidBuzz = guarded(() => {
  tone({ type: 'square', freq: 95, dur: 0.18, peak: 0.11 });
});

// Special-gem whooshes — one shared synthesis (noise through a swept filter),
// six personalities via sweep direction/speed/width: line = quick rising
// pass-by, area = downward lowpass (weight), color = the long big one,
// fire = narrow resonant band (crackly roar), lightning = fast bright
// highpass snap, star = medium sweep plus a sine "sparkle" ping on top.
const WHOOSH = {
  line:      { filter: 'bandpass', from: 300,  to: 2800, q: 1.2, dur: 0.3,  peak: 0.5 },
  area:      { filter: 'lowpass',  from: 2200, to: 150,  q: 0.8, dur: 0.4,  peak: 0.6 },
  color:     { filter: 'bandpass', from: 150,  to: 3800, q: 1.0, dur: 0.6,  peak: 0.65 },
  fire:      { filter: 'bandpass', from: 500,  to: 1400, q: 2.5, dur: 0.45, peak: 0.5 },
  lightning: { filter: 'highpass', from: 2500, to: 9000, q: 1.0, dur: 0.16, peak: 0.55 },
  star:      { filter: 'bandpass', from: 400,  to: 2400, q: 1.5, dur: 0.5,  peak: 0.5, ping: 1568 },
};

export const specialWhoosh = guarded((kind) => {
  const p = WHOOSH[kind] || WHOOSH.line;   // unknown specials get the generic sweep
  noise(p);
  if (p.ping) tone({ type: 'sine', freq: p.ping, dur: 0.4, peak: 0.12 });
});

// Time-bomb countdown: woodblock-ish — a sine with an instant attack and a
// fast pitch drop; the bend is what makes a "knock" instead of a beep.
export const bombTick = guarded(() => {
  tone({ type: 'sine', freq: 1050, endFreq: 700, dur: 0.055, peak: 0.3, attack: 0.001 });
});

// Bomb explosion: low sine thump gliding into the floor + a dark filtered
// noise burst for the debris.
export const bombBoom = guarded(() => {
  tone({ type: 'sine', freq: 130, endFreq: 45, dur: 0.5, peak: 0.85, attack: 0.002 });
  noise({ filter: 'lowpass', from: 900, to: 80, q: 0.7, dur: 0.45, peak: 0.7, attack: 0.002 });
});

// Power-up use: rising sawtooth zap — the glide + buzzy harmonics read "energy".
export const powerupZap = guarded(() => {
  tone({ type: 'sawtooth', freq: 220, endFreq: 950, dur: 0.14, peak: 0.18 });
});

// Power-up milestone earned: single bright ding — C6 fundamental with a faint
// octave partial, which is what separates a "bell" from a plain note.
export const milestoneDing = guarded(() => {
  tone({ type: 'triangle', freq: 1046.5, dur: 0.35, peak: 0.22 });
  tone({ type: 'sine', freq: 2093, dur: 0.25, peak: 0.07 });
});

// Achievement unlocked: two-note chime, E5 → B5 — a rising fifth reads "earned".
export const achievementChime = guarded(() => {
  tone({ type: 'triangle', freq: 659.3, dur: 0.18, peak: 0.2 });
  tone({ type: 'triangle', freq: 987.8, dur: 0.32, peak: 0.2, when: 0.1 });
});

// Menu/button tap: nearly subliminal — quieter and duller than swapClick so
// UI navigation never competes with gameplay SFX.
export const uiTap = guarded(() => {
  tone({ type: 'sine', freq: 1300, dur: 0.025, peak: 0.05 });
});

// Level won: three ascending triangle notes (C5-E5-G5, a major arpeggio);
// the last one rings longer to land the resolution.
export const winFanfare = guarded(() => {
  [523.25, 659.25, 783.99].forEach((freq, i) => {
    tone({ type: 'triangle', freq, dur: i === 2 ? 0.5 : 0.16, peak: 0.24, when: i * 0.13 });
  });
});

// Level lost: a long sine slide down into the floor — sad but not punishing.
export const loseThud = guarded(() => {
  tone({ type: 'sine', freq: 220, endFreq: 55, dur: 0.6, peak: 0.5, attack: 0.01 });
});

// Blitz time-up: two sawtooths detuned ±8 cents sagging a half step — the
// detune fattens the tone the way real horn sections do, and the downward
// sag is the universal "time's up" gesture.
export const timeUpHorn = guarded(() => {
  tone({ type: 'sawtooth', freq: 349, endFreq: 311, dur: 0.7, peak: 0.16, attack: 0.03, detune: -8 });
  tone({ type: 'sawtooth', freq: 349, endFreq: 311, dur: 0.7, peak: 0.16, attack: 0.03, detune: 8 });
});

// Blitz last-10-seconds tick: sharper and lower than swapClick so it cuts
// through gameplay SFX without being loud.
export const blitzTick = guarded(() => {
  tone({ type: 'square', freq: 1150, dur: 0.045, peak: 0.14, attack: 0.001 });
});

// --- zen ambient pad ---------------------------------------------------------
// Two slightly-detuned low oscillators (sine + triangle on A2) into a lowpass
// whose cutoff a sub-Hz LFO wobbles ±130 Hz — the classic "breathing" pad.
// The 13-cent detune makes the voices beat gently (~0.8 Hz shimmer) and the
// moving filter keeps the drone from reading as flat. Runs until stopped.

export const startZenPad = guarded(() => {
  if (pad) return;   // already humming — start is idempotent
  const t0 = ctx.currentTime;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(PAD_LEVEL, t0 + 2.5);   // slow fade-in, no click
  const f = ctx.createBiquadFilter();
  f.type = 'lowpass';
  f.frequency.value = 320;
  f.Q.value = 0.9;
  const a = ctx.createOscillator();
  a.type = 'sine';
  a.frequency.value = 110;      // A2
  a.detune.value = -6;
  const b = ctx.createOscillator();
  b.type = 'triangle';
  b.frequency.value = 110;
  b.detune.value = 7;
  const lfo = ctx.createOscillator();   // one full filter sweep every ~14s
  lfo.type = 'sine';
  lfo.frequency.value = 0.07;
  const lfoAmp = ctx.createGain();
  lfoAmp.gain.value = 130;              // cutoff breathes 320 ± 130 Hz
  lfo.connect(lfoAmp);
  lfoAmp.connect(f.frequency);
  a.connect(f);
  b.connect(f);
  f.connect(g);
  g.connect(master);
  a.start(t0);
  b.start(t0);
  lfo.start(t0);
  pad = { oscs: [a, b, lfo], filter: f, lfoAmp, gain: g };
});

// Stop the pad with a short release envelope, then free the nodes. Not
// routed through guarded(): it must still work while disabled (setEnabled
// relies on it) and it is idempotent when nothing is playing.
export function stopZenPad() {
  if (!pad) return;
  const p = pad;
  pad = null;   // clear first — even a throwing teardown must not wedge the pad
  try {
    const t0 = ctx.currentTime;
    p.gain.gain.cancelScheduledValues(t0);              // cut any in-flight fade-in
    p.gain.gain.setValueAtTime(p.gain.gain.value, t0);
    p.gain.gain.linearRampToValueAtTime(0, t0 + 0.6);   // release — no click on stop
    for (const o of p.oscs) o.stop(t0 + 0.7);
    // Disconnect the graph only once the release tail has actually played out.
    p.oscs[0].onended = () => {
      try {
        for (const o of p.oscs) o.disconnect();
        p.lfoAmp.disconnect();
        p.filter.disconnect();
        p.gain.disconnect();
      } catch { /* context died first — nothing left to free */ }
    };
  } catch { /* dying context — its nodes are already gone */ }
}
