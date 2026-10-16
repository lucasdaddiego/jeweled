// Cloudflare Pages Function — daily leaderboard at /api/leaderboard/<date>.
//
// Storage is a Workers KV namespace bound as LEADERBOARD:
//   day:<date>       JSON array of {name, score}, sorted desc, top 100 kept,
//                    one row per name (the best score), expires after 90
//                    days (nobody scrolls back that far).
//   rl:<utc-day>:<client>
//                    submission counter for the rate limit, keyed by the
//                    server's UTC day (not the posted date) and by the client
//                    address (IPv4 as is, IPv6 by its /64 prefix). Expires
//                    after 2 days.
//
// Both shapes read the data an older version wrote: a day board with
// duplicate names collapses to one row per name on the next read, and an
// old per-posted-date counter is simply never read again and expires.
//
// Honesty note: scores arrive from the client and are trivially spoofable —
// anyone with curl can post any number. This is a friendly hobby leaderboard,
// not an anti-cheat system; the validation below keeps the board tidy
// (shapes, ranges, one row per name, a per-client daily limit), it does not
// guarantee legitimacy.
//
// Why a daily per-client limit and not Cloudflare Turnstile: a Turnstile
// token proves that a browser solved a challenge, not that the score is real,
// so it cannot stop a spoofed score either. It would add a third-party script
// and iframe (CSP changes) to a canvas-only, offline-first game, a widget the
// player must see on the result screen, and a siteverify subrequest per POST.
// The abuse it would block (a flood of rows from one source) is what the
// limit below already caps.
//
// Deliberately dependency-free and defensive: any unexpected throw becomes a
// 500 JSON body, a missing binding becomes a 503, and the client treats every
// non-200 as "feature absent" (see src/leaderboard.js).

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NAME_MAX = 16;
// Removed from names: control characters (C0, DEL, C1); bidi controls (ALM,
// LRM, RLM, LRE..RLO, LRI..PDI), because an RLO flips the rest of its row;
// characters that render nothing (soft hyphen, combining grapheme joiner,
// Hangul fillers, Khmer inherent vowels, Mongolian vowel separator, zero-width
// space, word joiner, invisible operators, deprecated format controls, BOM,
// interlinear annotation marks); and the line/paragraph separators. ZWJ, ZWNJ,
// variation selectors and tag characters stay: emoji sequences and scripts
// such as Persian need them.
const NAME_STRIP_RE = /[\u0000-\u001f\u007f-\u009f\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u2064\u2066-\u206f\u3164\ufeff\uffa0\ufff9-\ufffb]/g;
// A name needs one character that is not space, a format character (the kept
// joiners) or a combining mark (variation selectors): a name of joiners alone
// shows nothing.
const NAME_VISIBLE_RE = /[^\p{White_Space}\p{Cf}\p{M}]/u;
const SCORE_MAX = 1_000_000;
const TOP_STORED = 100;                        // entries kept per day
const TOP_RETURNED = 50;                       // entries returned per request
const DATE_WINDOW_MS = 36 * 60 * 60 * 1000;    // ±36h: local dates straddle UTC
const DAY_TTL_S = 90 * 24 * 60 * 60;           // day boards expire after 90 days
const RL_MAX = 3;                              // submissions per UTC day per client
const RL_TTL_S = 2 * 24 * 60 * 60;             // rate-limit counters: 2 days

// Every response is JSON and uncacheable — the board changes constantly and
// a stale cached copy is worse than a quick refetch.
function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// Strict calendar parser. Date.parse/Date.UTC normalize overflow dates
// (2026-02-29 → 2026-03-01), so round-trip the components before accepting
// the value as a leaderboard key.
function dayStartUtc(date) {
  if (!DATE_RE.test(date)) return NaN;
  const [year, month, day] = date.split('-').map(Number);
  const value = Date.UTC(year, month - 1, day);
  const parsed = new Date(value);
  if (parsed.getUTCFullYear() !== year
      || parsed.getUTCMonth() !== month - 1
      || parsed.getUTCDate() !== day) return NaN;
  return value;
}

function logFailure(operation, error, context) {
  console.error(JSON.stringify({
    message: 'leaderboard request failed',
    operation,
    error: error instanceof Error ? error.message : String(error),
    date: String(context?.params?.date ?? ''),
  }));
}

// Identity of a row: the name compared without case, compatibility forms
// or repeated spaces, so "Ana", "ANA" and "Ａｎａ" share one row.
function nameKey(name) {
  return name.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ');
}

// Rate-limit bucket for a client address. An IPv6 client usually owns a whole
// /64 and can rotate through it at will, so the bucket is the /64 prefix; an
// IPv4 address (also one mapped into IPv6) is its own bucket.
function clientKey(ip) {
  if (!ip.includes(':')) return ip;
  const lower = ip.toLowerCase();
  const tail = lower.slice(lower.lastIndexOf(':') + 1);
  if (tail.includes('.')) return tail;                 // ::ffff:203.0.113.5
  const [head, rest] = lower.split('::');
  const left = head ? head.split(':') : [];
  const right = rest ? rest.split(':') : [];
  const groups = rest === undefined
    ? left
    : [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right];
  return `${groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, '')).join(':')}::/64`;
}

// Parse a stored day blob into a clean, sorted array of {name, score}.
// Defensive against hand-edited or corrupted KV values: bad JSON or a
// non-array collapses to an empty board, entries are re-shaped to exactly
// {name, score}, and the sort is stable so equal scores keep their stored
// (i.e. submission) order — first submitter wins ties. A name that appears
// twice (a board written before one-row-per-name) keeps only its best row.
function parseEntries(raw) {
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const seen = new Set();
    return arr
      .filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.score))
      .map((e) => ({ name: e.name, score: e.score }))
      .sort((a, b) => b.score - a.score)
      .filter((e) => {
        const key = nameKey(e.name);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  } catch {
    return [];
  }
}

// GET /api/leaderboard/<date> → { date, entries: [{name, score}] } (top 50)
export async function onRequestGet(context) {
  try {
    const date = String(context.params?.date ?? '');
    if (!Number.isFinite(dayStartUtc(date))) return json({ error: 'bad date' }, 400);
    const kv = context.env?.LEADERBOARD;
    if (!kv) return json({ error: 'leaderboard not configured' }, 503);

    const entries = parseEntries(await kv.get(`day:${date}`));
    return json({ date, entries: entries.slice(0, TOP_RETURNED) });
  } catch (error) {
    logFailure('get', error, context);
    return json({ error: 'internal error' }, 500);
  }
}

// POST /api/leaderboard/<date> with body { name, score }
//   → { date, entries: [{name, score}], rank } (top 50 + the 1-based rank of
//     the submitter's row among everything known for that day — rank can
//     exceed TOP_STORED, in which case the entry itself wasn't kept).
//     One row per name: a better score replaces the name's row, a score that
//     is not better leaves the board as it is and reports the existing row.
export async function onRequestPost(context) {
  try {
    const date = String(context.params?.date ?? '');
    const dayStart = dayStartUtc(date);
    if (!Number.isFinite(dayStart)) return json({ error: 'bad date' }, 400);
    const kv = context.env?.LEADERBOARD;
    if (!kv) return json({ error: 'leaderboard not configured' }, 503);

    // Only accept submissions for "today", with a ±36h window because the
    // client uses the player's LOCAL date (src/rng.js todayISO): a player at
    // UTC+14 or UTC-12 can legitimately sit a calendar day away from server
    // UTC.
    if (Math.abs(Date.now() - dayStart) > DATE_WINDOW_MS) {
      return json({ error: 'date out of range' }, 400);
    }

    let body;
    try { body = await context.request.json(); } catch { return json({ error: 'bad body' }, 400); }
    if (!body || typeof body !== 'object') return json({ error: 'bad body' }, 400);

    // Name: strip control, bidi and invisible characters (NAME_STRIP_RE), then
    // trim, then 1..16 and at least one visible character.
    if (typeof body.name !== 'string') return json({ error: 'bad name' }, 400);
    const name = body.name.replace(NAME_STRIP_RE, '').trim();
    if (name.length < 1 || name.length > NAME_MAX || !NAME_VISIBLE_RE.test(name)) {
      return json({ error: 'bad name' }, 400);
    }

    const score = body.score;
    if (!Number.isInteger(score) || score < 0 || score > SCORE_MAX) {
      return json({ error: 'bad score' }, 400);
    }

    // Best-effort rate limit: max 3 accepted submissions per client per UTC
    // day. The key is the server's day, not the posted date: the ±36h window
    // accepts three date keys, and a per-date counter allowed 9 rows a day.
    // KV is eventually consistent, so two racing requests can both slip
    // through — acceptable for a hobby board, and the top-100 cap bounds the
    // damage. Checked after validation so rejects don't burn quota.
    const ip = context.request.headers.get('CF-Connecting-IP') || 'unknown';
    const utcDay = new Date().toISOString().slice(0, 10);
    const rlKey = `rl:${utcDay}:${clientKey(ip)}`;
    const used = parseInt(await kv.get(rlKey), 10) || 0;
    if (used >= RL_MAX) return json({ error: 'rate limited' }, 429);

    // Read-modify-write of the day board. Same eventual-consistency caveat
    // as above: two simultaneous submissions can drop one of them. Fine here;
    // anything stronger needs Durable Objects, which this game doesn't.
    const dayKey = `day:${date}`;
    const entries = parseEntries(await kv.get(dayKey));
    const key = nameKey(name);
    const existing = entries.find((e) => nameKey(e.name) === key);
    let entry = existing;
    if (!existing || score > existing.score) {
      if (existing) entries.splice(entries.indexOf(existing), 1);
      entry = { name, score };
      entries.push(entry);
      // Stable sort: the new entry was pushed last, so it ranks after
      // existing equal scores — first submitter wins ties.
      entries.sort((a, b) => b.score - a.score);
      await kv.put(dayKey, JSON.stringify(entries.slice(0, TOP_STORED)), { expirationTtl: DAY_TTL_S });
    }
    const rank = entries.indexOf(entry) + 1;
    await kv.put(rlKey, String(used + 1), { expirationTtl: RL_TTL_S });

    return json({ date, entries: entries.slice(0, TOP_RETURNED), rank });
  } catch (error) {
    logFailure('post', error, context);
    return json({ error: 'internal error' }, 500);
  }
}
