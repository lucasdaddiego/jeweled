// Cloudflare Pages Function — daily leaderboard at /api/leaderboard/<date>.
//
// Storage is a Workers KV namespace bound as LEADERBOARD:
//   day:<date>       JSON array of {name, score}, sorted desc, top 100 kept,
//                    expires after 90 days (nobody scrolls back that far).
//   rl:<date>:<ip>   submission counter for the rate limit, expires after
//                    2 days (outlives the ±36h submission window).
//
// Honesty note: scores arrive from the client and are trivially spoofable —
// anyone with curl can post any number. This is a friendly hobby leaderboard,
// not an anti-cheat system; the validation below keeps the board tidy
// (shapes, ranges, a per-IP rate limit), it does not guarantee legitimacy.
//
// Deliberately dependency-free and defensive: any unexpected throw becomes a
// 500 JSON body, a missing binding becomes a 503, and the client treats every
// non-200 as "feature absent" (see src/leaderboard.js).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 16;
const SCORE_MAX = 1_000_000;
const TOP_STORED = 100;                        // entries kept per day
const TOP_RETURNED = 50;                       // entries returned per request
const DATE_WINDOW_MS = 36 * 60 * 60 * 1000;    // ±36h: local dates straddle UTC
const DAY_TTL_S = 90 * 24 * 60 * 60;           // day boards expire after 90 days
const RL_MAX = 3;                              // submissions per day per IP
const RL_TTL_S = 2 * 24 * 60 * 60;             // rate-limit counters: 2 days

// Every response is JSON and uncacheable — the board changes constantly and
// a stale cached copy is worse than a quick refetch.
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Parse a stored day blob into a clean, sorted array of {name, score}.
// Defensive against hand-edited or corrupted KV values: bad JSON or a
// non-array collapses to an empty board, entries are re-shaped to exactly
// {name, score}, and the sort is stable so equal scores keep their stored
// (i.e. submission) order — first submitter wins ties.
function parseEntries(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.score))
      .map((e) => ({ name: e.name, score: e.score }))
      .sort((a, b) => b.score - a.score);
  } catch {
    return [];
  }
}

// GET /api/leaderboard/<date> → { date, entries: [{name, score}] } (top 50)
export async function onRequestGet(context) {
  try {
    const date = String(context.params?.date ?? '');
    if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);
    const kv = context.env?.LEADERBOARD;
    if (!kv) return json({ error: 'leaderboard not configured' }, 503);

    const entries = parseEntries(await kv.get(`day:${date}`));
    return json({ date, entries: entries.slice(0, TOP_RETURNED) });
  } catch {
    return json({ error: 'internal error' }, 500);
  }
}

// POST /api/leaderboard/<date> with body { name, score }
//   → { date, entries: [{name, score}], rank } (top 50 + the submitter's
//     1-based rank among everything known for that day — rank can exceed
//     TOP_STORED, in which case the entry itself wasn't kept).
export async function onRequestPost(context) {
  try {
    const date = String(context.params?.date ?? '');
    if (!DATE_RE.test(date)) return json({ error: 'bad date' }, 400);
    const kv = context.env?.LEADERBOARD;
    if (!kv) return json({ error: 'leaderboard not configured' }, 503);

    // Only accept submissions for "today", with a ±36h window because the
    // client uses the player's LOCAL date (src/rng.js todayISO): a player at
    // UTC+14 or UTC-12 can legitimately sit a calendar day away from server
    // UTC. Date.parse also rejects impossible dates (2026-02-31 → NaN).
    const dayStart = Date.parse(`${date}T00:00:00Z`);
    if (!Number.isFinite(dayStart) || Math.abs(Date.now() - dayStart) > DATE_WINDOW_MS) {
      return json({ error: 'date out of range' }, 400);
    }

    let body;
    try { body = await context.request.json(); } catch { return json({ error: 'bad body' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: 'bad body' }, 400);

    // Name: strip control characters (C0, DEL, C1), then trim, then 1..16.
    if (typeof body.name !== 'string') return json({ error: 'bad name' }, 400);
    const name = body.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
    if (name.length < 1 || name.length > NAME_MAX) return json({ error: 'bad name' }, 400);

    const score = body.score;
    if (!Number.isInteger(score) || score < 0 || score > SCORE_MAX) {
      return json({ error: 'bad score' }, 400);
    }

    // Best-effort rate limit: max 3 accepted submissions per day per IP.
    // KV is eventually consistent, so two racing requests can both slip
    // through — acceptable for a hobby board, and the top-100 cap bounds the
    // damage. Checked after validation so rejects don't burn quota.
    const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    const rlKey = `rl:${date}:${ip}`;
    const used = parseInt(await kv.get(rlKey), 10) || 0;
    if (used >= RL_MAX) return json({ error: 'rate limited' }, 429);

    // Read-modify-write of the day board. Same eventual-consistency caveat
    // as above: two simultaneous submissions can drop one of them. Fine here;
    // anything stronger needs Durable Objects, which this game doesn't.
    const dayKey = `day:${date}`;
    const entries = parseEntries(await kv.get(dayKey));
    const entry = { name, score };
    entries.push(entry);
    // Stable sort: the new entry was pushed last, so it ranks after existing
    // equal scores — first submitter wins ties.
    entries.sort((a, b) => b.score - a.score);
    const rank = entries.indexOf(entry) + 1;
    await kv.put(dayKey, JSON.stringify(entries.slice(0, TOP_STORED)), { expirationTtl: DAY_TTL_S });
    await kv.put(rlKey, String(used + 1), { expirationTtl: RL_TTL_S });

    return json({ date, entries: entries.slice(0, TOP_RETURNED), rank });
  } catch {
    return json({ error: 'internal error' }, 500);
  }
}
