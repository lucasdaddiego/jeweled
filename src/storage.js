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
    if (!parsed.version || parsed.version !== STORAGE_VERSION) {
      // Schema mismatch — archive the old payload so a future migration can
      // recover from it, then reset to defaults.
      try { localStorage.setItem(`${STORAGE_KEY}:v${parsed.version || 0}:archive`, raw); }
      catch { /* quota — fine, we tried */ }
      cache = defaultState();
      saveAll();
      return cache;
    }
    // Merge with defaults so newly-added keys are present
    cache = deepMerge(defaultState(), parsed);
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
