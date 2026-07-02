// Daily-leaderboard client (fetch-only).
//
// Talks to the same-origin Pages Function at /api/leaderboard/<date> (see
// functions/api/leaderboard/[date].js). There is deliberately no
// isConfigured() export: the client has no way to know whether the backend
// (a KV binding on the Pages project) exists, so availability is expressed
// purely through results — offline, timeout, 4xx/5xx, malformed body, or no
// backend at all each collapse to {ok:false}, and callers simply hide the
// leaderboard UI. The game must be fully playable with no backend.
//
// No storage import on purpose: this module only speaks HTTP; who submits,
// what name to use, and when, is the caller's business.

const TIMEOUT_MS = 3000;   // a leaderboard is not worth a long spinner

// Shared request path. Resolves to {ok:true, entries, rank?} on a 200 with a
// well-formed body, {ok:false} on anything else. Never rejects.
async function call(path, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path, { ...init, signal: ctrl.signal });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    // Shape-check the payload so a misrouted 200 (captive portal, SPA
    // fallback HTML parsed as JSON null, etc.) can't leak junk to the UI.
    if (!data || !Array.isArray(data.entries)) return { ok: false };
    const out = { ok: true, entries: data.entries };
    if (Number.isInteger(data.rank)) out.rank = data.rank;
    return out;
  } catch {
    // Network failure, abort (timeout), or a body that isn't JSON.
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

// GET the top scores for a day. dateISO is a YYYY-MM-DD string (the player's
// local date, from src/rng.js todayISO — the server window is UTC-lenient).
export async function fetchDaily(dateISO) {
  return call(`/api/leaderboard/${encodeURIComponent(dateISO)}`);
}

// Submit a score for a day. Resolves to {ok:true, entries, rank} where rank
// is the submitter's 1-based position, or {ok:false} (already submitted /
// rate-limited / offline / no backend — the caller doesn't need to know why).
export async function submitDaily(dateISO, name, score) {
  return call(`/api/leaderboard/${encodeURIComponent(dateISO)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, score }),
  });
}
