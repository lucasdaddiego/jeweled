// Achievements: small, local-only progression milestones.
// Definitions live here; storage tracks which are unlocked + numeric progress
// against each one. Unlock detection is called from cascade callbacks via
// notifyMatch / notifyCascade / notifyLevelWin / notifyDailyDone / notifyRunEnd.
// Toast notifications are emitted via an in-memory queue; the active game
// scene polls and renders them.

import * as storage from './storage.js';

// Display strings live in i18n under achievement.<id>.name / .desc. Storage
// only persists the achievement ID + unlock timestamp, so the IDs below are
// fixed and language-neutral.
export const ACHIEVEMENTS = [
  // === Engagement ===
  { id: 'first_match',    nameKey: 'achievement.first_match.name',    descKey: 'achievement.first_match.desc',    icon: '🎯' },
  { id: 'matches_100',    nameKey: 'achievement.matches_100.name',    descKey: 'achievement.matches_100.desc',    icon: '💯' },
  { id: 'matches_1000',   nameKey: 'achievement.matches_1000.name',   descKey: 'achievement.matches_1000.desc',   icon: '🎖️' },
  { id: 'matches_10000',  nameKey: 'achievement.matches_10000.name',  descKey: 'achievement.matches_10000.desc',  icon: '👑' },

  // === Cascade depth ===
  { id: 'cascade_3',      nameKey: 'achievement.cascade_3.name',      descKey: 'achievement.cascade_3.desc',      icon: '🔥' },
  { id: 'cascade_5',      nameKey: 'achievement.cascade_5.name',      descKey: 'achievement.cascade_5.desc',      icon: '⭐' },
  { id: 'cascade_8',      nameKey: 'achievement.cascade_8.name',      descKey: 'achievement.cascade_8.desc',      icon: '🌪️' },

  // === Specials ===
  { id: 'special_color',  nameKey: 'achievement.special_color.name',  descKey: 'achievement.special_color.desc',  icon: '🪩' },
  { id: 'special_area',   nameKey: 'achievement.special_area.name',   descKey: 'achievement.special_area.desc',   icon: '💥' },
  { id: 'special_star',   nameKey: 'achievement.special_star.name',   descKey: 'achievement.special_star.desc',   icon: '🌟' },

  // === Classic progress ===
  { id: 'classic_l10',    nameKey: 'achievement.classic_l10.name',    descKey: 'achievement.classic_l10.desc',    icon: '🥉' },
  { id: 'classic_l50',    nameKey: 'achievement.classic_l50.name',    descKey: 'achievement.classic_l50.desc',    icon: '🥈' },
  { id: 'classic_l100',   nameKey: 'achievement.classic_l100.name',   descKey: 'achievement.classic_l100.desc',   icon: '🥇' },
  { id: 'classic_l200',   nameKey: 'achievement.classic_l200.name',   descKey: 'achievement.classic_l200.desc',   icon: '🏆' },

  // === Mode breadth ===
  { id: 'first_zen',      nameKey: 'achievement.first_zen.name',      descKey: 'achievement.first_zen.desc',      icon: '🧘' },
  { id: 'first_daily',    nameKey: 'achievement.first_daily.name',    descKey: 'achievement.first_daily.desc',    icon: '📅' },
  { id: 'first_blitz',    nameKey: 'achievement.first_blitz.name',    descKey: 'achievement.first_blitz.desc',    icon: '⚡' },
  { id: 'first_puzzle',   nameKey: 'achievement.first_puzzle.name',   descKey: 'achievement.first_puzzle.desc',   icon: '🧩' },

  // === Big scores ===
  { id: 'score_zen_10k',  nameKey: 'achievement.score_zen_10k.name',  descKey: 'achievement.score_zen_10k.desc',  icon: '🥄' },
  { id: 'score_zen_100k', nameKey: 'achievement.score_zen_100k.name', descKey: 'achievement.score_zen_100k.desc', icon: '💎' },
];

// In-memory toast queue. UI polls + drains.
//
// Unlocked-but-unshown achievements get re-queued from storage on the first
// state access (see hydrateUnshownToasts). This means closing the tab in the
// window between unlock() persisting and the toast being consumed doesn't
// rob the player of their celebration — they'll see it next session.
const toastQueue = [];
let _hydrated = false;

export function pendingToasts() {
  getState();   // ensures hydration so callers don't see an empty queue pre-warm
  return toastQueue;
}
export function consumeToast() {
  getState();   // hydrate before draining
  const t = toastQueue.shift() || null;
  if (t) {
    // Persist that the user has now seen this achievement so we don't
    // re-queue it on next session.
    const state = getState();
    const rec = state.unlocked[t.id];
    if (rec) {
      rec.shownAt = new Date().toISOString();
      storage.saveKey('achievements', state);
    }
  }
  return t;
}

function getState() {
  const s = storage.load();
  if (!s.achievements) {
    s.achievements = { unlocked: {}, counters: { totalMatches: 0 } };
    storage.saveKey('achievements', s.achievements);
  }
  if (!_hydrated) {
    _hydrated = true;
    hydrateUnshownToasts(s.achievements);
  }
  return s.achievements;
}

// Scan persisted unlocks for any whose celebration toast was never shown
// (shownAt == null) and queue them. Idempotent and one-shot per module load.
// Pre-existing legacy unlocks (which lack the shownAt field entirely) are
// treated as "already shown" — we don't want to spam first-load with toasts
// for achievements the player saw in earlier sessions.
function hydrateUnshownToasts(state) {
  for (const id of Object.keys(state.unlocked)) {
    const rec = state.unlocked[id];
    // Strict null check: missing shownAt (legacy) → skip; explicit null → queue.
    if (!rec || !('shownAt' in rec) || rec.shownAt !== null) continue;
    const def = ACHIEVEMENTS.find(a => a.id === id);
    if (!def) continue;
    if (toastQueue.some(t => t.id === id)) continue;
    toastQueue.push({ id, nameKey: def.nameKey, icon: def.icon });
  }
}

function isUnlocked(id) { return !!getState().unlocked[id]; }

function unlock(id) {
  if (isUnlocked(id)) return;
  const def = ACHIEVEMENTS.find(a => a.id === id);
  if (!def) return;
  const state = getState();
  // shownAt: null marks this unlock as "owed a toast". consumeToast() will
  // set the timestamp when the player actually sees the celebration. If the
  // tab closes in between, hydrateUnshownToasts re-queues on next load.
  state.unlocked[id] = { at: new Date().toISOString(), shownAt: null };
  storage.saveKey('achievements', state);
  // Push the nameKey (not the translated string) so the toast renderer can
  // localize at draw time and pick up language changes that happen between
  // the unlock and the toast actually displaying.
  toastQueue.push({ id, nameKey: def.nameKey, icon: def.icon });
}

function bumpCounter(key, delta) {
  const state = getState();
  state.counters[key] = (state.counters[key] || 0) + delta;
  storage.saveKey('achievements', state);
  return state.counters[key];
}

// === Notification hooks (called from cascade / scene callbacks) ===

export function notifyMatchCleared(cellCount, depth, specialsCleared = []) {
  const total = bumpCounter('totalMatches', cellCount);
  unlock('first_match');
  if (total >= 100)    unlock('matches_100');
  if (total >= 1000)   unlock('matches_1000');
  if (total >= 10000)  unlock('matches_10000');
  if (depth >= 3)      unlock('cascade_3');
  if (depth >= 5)      unlock('cascade_5');
  if (depth >= 8)      unlock('cascade_8');
}

export function notifySpecialSpawned(special) {
  if (special === 'COLOR_BOMB') unlock('special_color');
  if (special === 'AREA_BOMB')  unlock('special_area');
  if (special === 'STAR')       unlock('special_star');
}

export function notifyLevelWin(level) {
  if (level >= 10)  unlock('classic_l10');
  if (level >= 50)  unlock('classic_l50');
  if (level >= 100) unlock('classic_l100');
  if (level >= 200) unlock('classic_l200');
}

export function notifyMode(mode) {
  if (mode === 'zen')    unlock('first_zen');
  if (mode === 'daily')  unlock('first_daily');
  if (mode === 'blitz')  unlock('first_blitz');
  if (mode === 'puzzle') unlock('first_puzzle');
}

export function notifyZenScore(score) {
  if (score >= 10000)  unlock('score_zen_10k');
  if (score >= 100000) unlock('score_zen_100k');
}

// === Stats summary (for the stats scene) ===
export function summary() {
  const state = getState();
  const unlocked = Object.keys(state.unlocked).length;
  return {
    unlocked, total: ACHIEVEMENTS.length,
    counters: state.counters,
    unlockedSet: state.unlocked,
  };
}
