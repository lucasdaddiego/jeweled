// localStorage wrapper with versioned schema.

import { STORAGE_KEY, STORAGE_VERSION } from './config.js';
import { todayISO } from './rng.js';

function defaultState() {
  return {
    version: STORAGE_VERSION,
    profile: {
      playerName: '',
      createdAt: new Date().toISOString(),
      lastPlayedMode: null,
    },
    zen: {
      bestScore: 0,
      totalRunsPlayed: 0,
      lastPlayedAt: null,
      saveState: null,
    },
    classic: {
      highestUnlocked: 1,
      levels: {},
      saveState: null,
    },
    daily: {
      bestEver: 0,
      totalDaysPlayed: 0,
      history: {},
      todaySubmittedDate: null,
    },
    blitz: {
      bestScore: 0,
      totalRunsPlayed: 0,
      lastPlayedAt: null,
    },
    puzzle: {
      completed: {},     // sparse: { "1": {bestScore, completedAt}, ... }
    },
    settings: {
      particleDensity: 'high',
      haptic: true,
      eyes: true,
      paintingMode: false,
      language: 'auto',   // 'auto' | 'en' | 'es' — see src/i18n.js
    },
    playHistory: {},
    powerups: {
      charges: { shuffle: 0, colorBlast: 0, bombDrop: 0, recolor: 0 },
      lastMilestoneScore: 0,  // tracks score floor at which the last charge was awarded
    },
  };
}

// Forward migrations. Each entry transforms a blob written at version N
// into the shape expected at version N+1. Keep them pure (no Date.now, no
// RNG) so they replay deterministically from the :v{N}:archive backup.
// Additive changes — new leaf keys with defaults — don't need an entry;
// deepMerge handles those without a version bump.
const MIGRATIONS = {
  // 1: (v1) => ({ ...v1, /* v2 shape */ }),
};

function migrate(blob, fromVersion) {
  let v = fromVersion;
  let out = blob;
  while (v < STORAGE_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) throw new Error(`no migration from v${v} to v${v + 1}`);
    out = step(out);
    v++;
    out.version = v;
  }
  return out;
}

let cache = null;

export function load() {
  if (cache) return cache;
  if (typeof localStorage === 'undefined') {
    cache = defaultState();
    return cache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      cache = defaultState();
      return cache;
    }
    const parsed = JSON.parse(raw);
    const fromVersion = Number(parsed.version) || 0;
    if (fromVersion > STORAGE_VERSION) {
      // Stale client meeting a newer save (e.g. user opened a cached tab
      // after a deploy that bumped the version). Don't migrate backwards
      // and don't overwrite — run on in-memory defaults this session so
      // the newer blob survives untouched for the next reload.
      cache = defaultState();
      return cache;
    }
    let blob = parsed;
    if (fromVersion < STORAGE_VERSION) {
      try { localStorage.setItem(`${STORAGE_KEY}:v${fromVersion}:archive`, raw); }
      catch { /* quota — fine, we tried */ }
      try {
        blob = migrate(parsed, fromVersion);
      } catch (err) {
        console.warn('storage.migrate failed, resetting:', err);
        cache = defaultState();
        saveAll();
        return cache;
      }
    }
    // deepMerge fills any leaf keys that were added since the blob was
    // written. Additive changes don't need a version bump — bump only for
    // renames/removals/restructures handled by MIGRATIONS.
    cache = deepMerge(defaultState(), blob);
    if (fromVersion < STORAGE_VERSION) saveAll();
    return cache;
  } catch (err) {
    console.warn('storage.load failed, resetting:', err);
    cache = defaultState();
    return cache;
  }
}

function deepMerge(base, overlay) {
  // Missing overlay → keep base.
  if (overlay === null || overlay === undefined) return base;
  // Type mismatch (base is a plain object but overlay is a scalar/array/null, or
  // vice versa): keep base. This prevents a corrupted localStorage value (e.g.
  // settings=null) from replacing a structured default and crashing callers.
  const baseIsPlainObj = base !== null && typeof base === 'object' && !Array.isArray(base);
  const overlayIsPlainObj = typeof overlay === 'object' && !Array.isArray(overlay);
  if (baseIsPlainObj !== overlayIsPlainObj) return base;
  if (!baseIsPlainObj) return overlay; // both scalars or both arrays — overlay wins
  const out = { ...base };
  for (const k of Object.keys(overlay)) {
    if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue;
    if (k in base) out[k] = deepMerge(base[k], overlay[k]);
    else out[k] = overlay[k];
  }
  return out;
}

// Debounced writes. Achievements/powerups call saveKey on every match clear
// (potentially several times per frame on big cascades). Coalescing into one
// localStorage.setItem per ~250ms removes the synchronous JSON.stringify
// from the hot path. main.js calls flush() on pagehide so tab-close still
// persists everything.
let _saveTimer = null;
let _saveDirty = false;

export function saveAll() {
  if (!cache) cache = defaultState();
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch (err) {
    console.warn('storage.saveAll failed (quota?):', err);
  }
  _saveDirty = false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
}

function scheduleSave() {
  _saveDirty = true;
  if (_saveTimer) return;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    if (_saveDirty) saveAll();
  }, 250);
}

// Force any pending writes through synchronously. Call this on pagehide /
// beforeunload so a tab-close doesn't drop the last ~250ms of changes.
export function flush() {
  if (_saveDirty) saveAll();
}

// Shallow-merge a patch into top-level keys, then persist (debounced).
export function save(patch) {
  const state = load();
  for (const k of Object.keys(patch)) {
    state[k] = patch[k];
  }
  scheduleSave();
}

// Patch a single sub-key (e.g. saveKey('settings', {haptic: false}))
export function saveKey(topKey, patch) {
  const state = load();
  state[topKey] = { ...state[topKey], ...patch };
  scheduleSave();
}

export function reset() {
  cache = defaultState();
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (err) {
    console.warn('storage.reset failed:', err);
  }
}

// Convenience getters used widely
export function getSettings() { return load().settings; }
export function getProfile()  { return load().profile; }

// Bump the streak heatmap entry for today by one run + score delta.
// Called by every game-mode scene when a run/level ends. Goes through the
// debounced path — pagehide flushes if the tab is closed before the timer.
export function recordPlayDay(scoreDelta = 0) {
  const today = todayISO();
  const state = load();
  const cur = state.playHistory[today] || { runs: 0, totalScore: 0 };
  state.playHistory[today] = {
    runs: cur.runs + 1,
    totalScore: cur.totalScore + (scoreDelta || 0),
  };
  scheduleSave();
}
