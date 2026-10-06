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
      gallery: [],        // painting-mode keepsakes: [{ dataUrl, at }], newest first, capped
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
      // Day whose counted run made its first move (gameDaily): a re-entry on
      // that day is a replay, so a reload cannot restart the seeded board.
      startedDate: null,
      // Day whose score this device already POSTed to the leaderboard
      // (result): browser history can re-enter the result scene with the
      // original args, and the date must survive a reload to block a 2nd POST.
      leaderboardSubmittedDate: null,
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
      sound: true,         // procedural SFX + zen pad — see src/sound.js
      gemStyle: 'color',   // 'color' (colored squares) | 'shapes' (colorblind-friendly distinct silhouettes)
      language: 'auto',   // 'auto' | 'en' | 'es' — see src/i18n.js
    },
    playHistory: {},
    powerups: {
      charges: { shuffle: 0, colorBlast: 0, bombDrop: 0, recolor: 0, undo: 0 },
    },
    // Owned by src/achievements.js; listed here so deepMerge's type guards
    // cover it like every other subtree. Without a default, an import code or
    // hand-edited blob with achievements: {} (or unlocked: "x") passed straight
    // through and the next unlock()/bumpCounter() threw a TypeError.
    achievements: {
      unlocked: {},                       // { [id]: { at, shownAt } }
      counters: { totalMatches: 0 },
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

// migrate() with load()'s safety net: a missing step is a build-time mistake,
// not a reason to destroy the player's data. Fall back to the unmigrated blob
// for a best-effort deepMerge: safe for additive changes (the common case);
// only a genuine rename/restructure would have needed the missing step.
function migrateOrKeep(blob, fromVersion) {
  try {
    return migrate(blob, fromVersion);
  } catch (err) {
    console.warn('storage.migrate incomplete, preserving data via deepMerge:', err);
    return blob;
  }
}

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
// Set when load() sees a future-version blob (cached tab after a deploy that
// bumped STORAGE_VERSION). Suppresses ALL writes for the rest of the session
// so the newer blob in localStorage survives untouched for the next reload.
// Without this guard, saveAll() would clobber the newer blob with defaults.
let _readOnly = false;
// Write gate for the one-active-tab lock (src/tabLock.js). 'open' writes as
// usual. 'held' keeps changes in memory until this tab knows that it owns the
// save (at boot, before the lock answers). 'closed' drops them: another tab
// owns the save, and the copy in this tab is stale.
let _gate = 'open';
// The save text this tab last read from or wrote to localStorage. When this
// tab takes over the save and the disk text differs, another tab wrote since.
let _diskRaw = null;

// With site data blocked (a browser setting), reading window.localStorage
// itself throws a SecurityError, and `typeof` does not catch a throwing getter.
function storageAvailable() {
  try { return typeof localStorage !== 'undefined'; } catch { return false; }
}
export { storageAvailable as isAvailable };

export function load() {
  if (cache) return cache;
  if (!storageAvailable()) {
    cache = defaultState();
    return cache;
  }
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    _diskRaw = raw;
    if (!raw) {
      cache = defaultState();
      return cache;
    }
    const parsed = JSON.parse(raw);
    const rawVersion = Number(parsed.version);
    // A positive integer version means the blob came from a versioned build.
    // Anything else (missing / 0 / NaN) is a *pre-versioning* save: treat it as
    // already current-shape and let deepMerge backfill new keys, rather than
    // routing it through migrate() — which would find no MIGRATIONS[0] step,
    // throw, and wipe the player's entire progress.
    const versioned = Number.isInteger(rawVersion) && rawVersion > 0;
    const fromVersion = versioned ? rawVersion : STORAGE_VERSION;

    if (versioned && fromVersion > STORAGE_VERSION) {
      // Stale client meeting a newer save (e.g. user opened a cached tab
      // after a deploy that bumped the version). Don't migrate backwards
      // and don't overwrite — run on in-memory defaults this session so
      // the newer blob survives untouched for the next reload.
      cache = defaultState();
      _readOnly = true;
      return cache;
    }
    let blob = parsed;
    if (fromVersion < STORAGE_VERSION) {
      try { localStorage.setItem(`${STORAGE_KEY}:v${fromVersion}:archive`, raw); }
      catch { /* quota — fine, we tried */ }
      // The archive backup above preserves the exact pre-merge blob either way.
      blob = migrateOrKeep(parsed, fromVersion);
    }
    // deepMerge fills any leaf keys that were added since the blob was
    // written. Additive changes don't need a version bump — bump only for
    // renames/removals/restructures handled by MIGRATIONS.
    cache = deepMerge(defaultState(), blob);
    cache.version = STORAGE_VERSION;   // stamp forward (covers pre-versioned / 0 blobs)
    if (!versioned || fromVersion < STORAGE_VERSION) saveAll();
    return cache;
  } catch (err) {
    console.warn('storage.load failed, resetting:', err);
    cache = defaultState();
    return cache;
  }
}

function deepMerge(base, overlay) {
  // Missing overlay (null or undefined) → keep base.
  if (overlay == null) return base;
  // `null` is also the schema's sentinel for optional values such as
  // zen/classic saveState. A populated optional value can legitimately be an
  // object, so it must replace the sentinel instead of being rejected as a
  // type mismatch. Structured defaults still retain the corruption guard
  // below (for example settings=null or settings="broken").
  if (base === null) return overlay;
  // Type mismatch (base is a plain object but overlay is a scalar/array/null, or
  // vice versa): keep base. This prevents a corrupted localStorage value (e.g.
  // settings=null) from replacing a structured default and crashing callers.
  const baseIsPlainObj = typeof base === 'object' && !Array.isArray(base);
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
  if (!storageAvailable()) return;
  // Owner not known yet: keep the change until setWriteGate('open').
  if (_gate === 'held') {
    _saveDirty = true;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    return;
  }
  // Refuse to persist over a future-version blob — see _readOnly comment —
  // or over the save of the tab that owns it (gate closed).
  if (_readOnly || _gate === 'closed') {
    _saveDirty = false;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    return;
  }
  try {
    const json = JSON.stringify(cache);
    localStorage.setItem(STORAGE_KEY, json);
    _diskRaw = json;
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
    // No dirty-check needed: the only writers of _saveDirty=false (saveAll,
    // reset) both cancel this timer, so it can only fire with a pending write.
    saveAll();
  }, 250);
}

// Force any pending writes through synchronously. Call this on pagehide /
// beforeunload so a tab-close doesn't drop the last ~250ms of changes.
export function flush() {
  if (_saveDirty) saveAll();
}

// Patch a single sub-key (e.g. saveKey('settings', {haptic: false}))
export function saveKey(topKey, patch) {
  const state = load();
  state[topKey] = { ...state[topKey], ...patch };
  scheduleSave();
}

export function reset() {
  cache = defaultState();
  // The user explicitly wiped localStorage, so there's no newer/future-version
  // blob left to protect — clear the read-only guard (set by load() on a stale
  // tab after a version bump). Without this, every post-reset write would
  // early-return and the fresh session would silently persist nothing. Also
  // drop any pending debounced write aimed at the now-deleted data.
  _readOnly = false;
  _saveDirty = false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  if (!storageAvailable()) return;
  // Not the owner (yet): never delete the shared save from here. A held gate
  // writes the fresh defaults once this tab owns the save.
  if (_gate !== 'open') {
    _saveDirty = _gate === 'held';
    return;
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
    _diskRaw = null;
  } catch (err) {
    console.warn('storage.reset failed:', err);
  }
}

// === One active tab (src/tabLock.js) ===

// Open, hold or close writes. See the _gate comment at the top.
export function setWriteGate(gate) {
  _gate = gate;
  if (gate === 'open') {
    if (_saveDirty) saveAll();
  } else if (gate === 'closed') {
    _saveDirty = false;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  }
}

// True when the save on disk is not the text this tab last read or wrote,
// so another tab wrote it since.
export function diskChanged() {
  if (!storageAvailable()) return false;
  try {
    return localStorage.getItem(STORAGE_KEY) !== _diskRaw;
  } catch {
    return false;   // unreadable store: keep the copy in memory
  }
}

// Drop the copy in this tab and read the save again, for a tab that takes
// over the save from another tab.
export function reloadFromDisk() {
  cache = null;
  _readOnly = false;
  _saveDirty = false;
  if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
  return load();
}

// === Save export / import ===
// Portable save code: 'JWLD1.' + base64(utf8(JSON)). Lets players move
// progress between devices without any backend. TextEncoder/TextDecoder keep
// it unicode-safe (player names can contain anything).
const EXPORT_PREFIX = 'JWLD1.';

export function exportString() {
  const bytes = new TextEncoder().encode(JSON.stringify(load()));
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return EXPORT_PREFIX + btoa(bin);
}

export function importString(code) {
  try {
    const trimmed = String(code || '').trim();
    if (!trimmed.startsWith(EXPORT_PREFIX)) return { ok: false, reason: 'format' };
    const bin = atob(trimmed.slice(EXPORT_PREFIX.length));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    if (!parsed || typeof parsed !== 'object' || !parsed.profile || !parsed.settings) {
      return { ok: false, reason: 'shape' };
    }
    // An older code runs its migrations first, like an older stored blob in
    // load(). Any other version (missing, current, or a claimed newer one)
    // is not trusted: the deepMerge below stamps it to the current version.
    const rawVersion = Number(parsed.version);
    const older = Number.isInteger(rawVersion) && rawVersion > 0 && rawVersion < STORAGE_VERSION;
    const blob = older ? migrateOrKeep(parsed, rawVersion) : parsed;
    // Same defensive path as load(): defaults + deepMerge so a crafted code
    // can't drop required keys or pollute prototypes.
    cache = deepMerge(defaultState(), blob);
    cache.version = STORAGE_VERSION;
    _readOnly = false;
    saveAll();
    return { ok: true };
  } catch {
    return { ok: false, reason: 'parse' };
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
