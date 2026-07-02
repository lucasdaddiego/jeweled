// Game constants and tunables.

export const GRID = 8;          // 8x8 board
export const TYPES = 7;         // 7 gem colors

// Gem emoji set — squares (Bejeweled style), 7 distinct colors.
export const DEFAULT_EMOJI = ['🟥', '🟦', '🟩', '🟨', '🟪', '⬜', '⬛'];

// Colorblind-friendly alternative (settings.gemStyle = 'shapes'): same hue per
// type as DEFAULT_EMOJI (so particle palettes still match) but with 7 distinct
// SILHOUETTES — circle, diamond, clover, star, heart, square, crescent — so
// types read by shape alone. The crescent is hand-painted (render.js
// CUSTOM_GLYPHS): the OS glyph is dark-on-dark and an X/cross token read as a
// "locked piece". Others use the OS emoji fallback.
export const SHAPES_EMOJI = ['🔴', '🔷', '🍀', '⭐', '💜', '⬜', '🌙'];

// Special-gem type identifiers
export const SPECIAL = {
  NONE:        null,
  LINE_H:      'LINE_H',
  LINE_V:      'LINE_V',
  COLOR_BOMB:  'COLOR_BOMB',
  AREA_BOMB:   'AREA_BOMB',
  GRAVITY:     'GRAVITY',
  TIME_BOMB:   'TIME_BOMB',
  // Round 2: emoji-themed specials
  WILDCARD:    'WILDCARD',    // 🃏 — matches as any color
  COIN:        'COIN',        // 🪙 — 5× score on clear
  FIRE:        'FIRE',        // 🔥 — clears 4 neighbors on match (chain)
  LIGHTNING:   'LIGHTNING',   // ⚡ — clears 3 random same-color gems on match
  STAR:        'STAR',        // ⭐ — clusterbuster (top 2 colors); spawned from a 5-chain
  TIME_PLUS:   'TIME_PLUS',   // ⏱ — Blitz only: +2s on clear (passive; scene handles it)
};

// Special spawn probabilities (1-in-N when a new gem drops from top)
export const SPAWN_RATES = {
  GRAVITY:    200,
  TIME_BOMB:  300,
  WILDCARD:   220,
  COIN:       400,
  FIRE:       280,
  LIGHTNING:  350,
  AREA_BOMB:  500,    // rare random top-spawn so casual players see one occasionally
  COLOR_BOMB: 600,
  STAR:       700,
};

// Big-wave bonus thresholds: clearing N cells in a single wave spawns an
// extra special (regardless of match shape). Stacks with the existing
// 4-in-row / 5-in-row / T/L spawns.
export const BIG_WAVE_AREA_BOMB = 6;     // 6+ cells in one wave → AREA_BOMB
export const BIG_WAVE_COLOR_BOMB = 7;    // 7+ cells in one wave → COLOR_BOMB

export const COIN_MULTIPLIER = 5;
export const STAR_CASCADE_TRIGGER = 3;       // 5→3 so players see STARs naturally (~every 10 moves)
export const LIGHTNING_TARGETS = 3;          // how many same-color gems lightning hits

// === Power-ups ===
export const POWERUP_MILESTONE = 1500;       // score points per +1 charge
export const POWERUP_MAX_CHARGES = 3;        // stack cap per slot
export const POWERUP_SLOTS = ['shuffle', 'colorBlast', 'bombDrop', 'recolor', 'undo'];
// Labels are localized via i18n (key: `powerup.${slot}.label`); see src/i18n.js.
export const POWERUP_META = {
  shuffle:    { emoji: '🔀', ring: '#7c3aed' },
  colorBlast: { emoji: '💥', ring: '#ff5722' },
  bombDrop:   { emoji: '🧨', ring: '#ff8a3d' },
  recolor:    { emoji: '🎯', ring: '#26c6da' },
  undo:       { emoji: '↩️', ring: '#8bc34a' },   // rewinds to the board before your last move
};

export const TIME_BOMB_START = 7;

// Animation timings (ms)
export const TIMING = {
  SWAP:        180,
  REVERT:      180,
  CLEAR:       220,
  FALL:        280,
  SPAWN_POP:   240,
  FLIP:        200,    // gravity-flip board rotate
  SLOWMO_MS:   300,    // duration of slowmo at cascadeDepth >= 5
  HINT_AFTER:  30000,  // ms idle before hint pulse — player has plenty of think time
};

export const SLOWMO_FACTOR = 0.4;        // dt scale during slowmo

// Scoring
export const SCORE = {
  PER_GEM_CLEARED: 10,
  CASCADE_MULTIPLIER: (depth) => 1 + (depth - 1) * 0.5, // 1x, 1.5x, 2x, 2.5x, ...
  BOMB_DEFUSE_BONUS: 500,
  SPECIAL_SPAWN_BONUS: 50,
};

// Particles / floaters
export const PARTICLE_POOL = 512;
export const FLOATER_POOL  = 32;

// Storage
export const STORAGE_KEY     = 'gem-match:v1';
export const STORAGE_VERSION = 1;

// Player name max length
export const NAME_MAX_LEN = 16;

// Cascade-depth thresholds. The combo floater labels (NICE!/GREAT!/AMAZING!
// and MEGA x{n}!) are localized via i18n keys combo.2/combo.3/combo.4 and
// combo.mega — see src/floaters.js and src/i18n.js.
export const SHAKE_MIN_DEPTH  = 3;
export const SLOWMO_MIN_DEPTH = 5;

// Daily challenge
export const DAILY_MOVES = 30;

// Blitz mode
export const BLITZ_DURATION_MS = 60_000;
// TIME_PLUS gems: 1-in-N top-spawn rate (blitz only, via cascade spawnOpts)
// and the clock bonus each one grants when cleared.
export const BLITZ_TIME_PLUS_RATE = 80;
export const BLITZ_TIME_PLUS_BONUS_MS = 2_000;
// Speed streak: chaining moves within the window builds the streak (capped);
// each level past 1 grants a flat score bonus per move.
export const BLITZ_STREAK_WINDOW_MS = 3_000;
export const BLITZ_STREAK_MAX = 5;
export const BLITZ_STREAK_BONUS = 25;
