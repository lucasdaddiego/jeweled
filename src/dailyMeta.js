// Pure helpers for Daily-mode meta UI: streak length, next-daily countdown,
// a trailing calendar window, and the share blurb. No DOM, no storage —
// callers hand in the daily.history blob ({ "YYYY-MM-DD": { score, movesUsed } })
// and get plain data back.

import { todayISO } from './rng.js';

// "YYYY-MM-DD" → local-midnight Date. Never `new Date('YYYY-MM-DD')`: the
// string form parses as UTC midnight, which lands on the WRONG calendar day
// for anyone west of Greenwich. Building from parts stays in local time,
// matching how todayISO() stamped the history keys in the first place.
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

// Consecutive days played, counting back from todayIso. Today gets a grace
// period: an unbroken run ending yesterday still shows its full length (the
// streak isn't LOST until today passes unplayed), so when today has no entry
// yet the walk starts at yesterday instead. setDate(-1) rolls back through
// month/year boundaries in local time.
export function dailyStreak(history, todayIso) {
  if (!history) return 0;
  const cursor = parseISO(todayIso);
  if (!history[todayIso]) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (history[todayISO(cursor)]) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

// Ms until the next LOCAL midnight — the moment a fresh board unlocks
// (dateHash seeds off the local date). Rolling the day through the Date
// constructor keeps this DST-proof: the subtraction spans real elapsed ms,
// so a 23h/25h changeover day yields the true wait, never a hardcoded 24h.
export function msUntilNextDaily(now = new Date()) {
  const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return nextMidnight - now;
}

// Split a countdown into { hours, minutes } for a "next daily in 3h 12m"
// label. The last partial minute rounds UP: with 30s left the label reads
// "0h 1m", never a premature "0h 0m" while the current board is still live.
// Negative input (clock skew, a tick landing past midnight) clamps to zero.
export function countdownParts(ms) {
  const totalMinutes = Math.max(0, Math.ceil(ms / 60000));
  return {
    hours: Math.floor(totalMinutes / 60),
    minutes: totalMinutes % 60,
  };
}

// The trailing n-day window ending at todayIso, oldest → newest, one slot per
// calendar day: { iso, entry } with entry = the history record or null. Days
// the player skipped come back as explicit nulls, so a calendar view renders
// empty cells without re-deriving the date walk.
export function lastNDays(history, n, todayIso) {
  const cursor = parseISO(todayIso);
  cursor.setDate(cursor.getDate() - (n - 1)); // rewind to the window start
  const out = [];
  for (let i = 0; i < n; i++) {
    const iso = todayISO(cursor);
    out.push({ iso, entry: history?.[iso] ?? null });
    cursor.setDate(cursor.getDate() + 1);
  }
  return out;
}

// Assemble the share blurb. Numbers arrive PRE-FORMATTED (strings from
// i18n.formatNumber) — this only lays out lines, it never formats. Kept
// language-light on purpose: the emoji carry the meaning, so one string
// works across locales without a full i18n pass.
export function buildShareText({ dateLabel, score, movesUsed, streak, url }) {
  const lines = [`💎 Jeweled Daily — ${dateLabel}`];
  // movesUsed may legitimately be absent (entries predating the field) —
  // drop just the moves clause, keep the score.
  lines.push(movesUsed != null
    ? `🏆 ${score} pts in ${movesUsed} moves`
    : `🏆 ${score} pts`);
  // A 1-day "streak" is just having played — only brag from 2 up. `>= 2`
  // coerces numeric strings too, so a pre-formatted streak still gates right.
  if (streak >= 2) lines.push(`🔥 ${streak}-day streak`);
  if (url) lines.push(url);
  return lines.join('\n');
}
