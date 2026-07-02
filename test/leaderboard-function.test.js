import { describe, it, expect } from 'vitest';
import { onRequestGet, onRequestPost } from '../functions/api/leaderboard/[date].js';

// Unit tests for the Cloudflare Pages Function behind /api/leaderboard/<date>.
// The function is invoked directly with a stubbed context — {env, params,
// request} is all it reads — and an in-memory fake KV that records every
// put (value + expirationTtl) so storage behaviour is assertable.
//
// functions/ sits outside the coverage include (src/**), so this file only
// has to pass, not clear the coverage gate.

// Node 24 / vitest's jsdom environment expose the fetch API classes
// (Request/Response/Headers). If a future environment drops them, fall back
// to minimal stand-ins that cover exactly what the function touches.
class MiniHeaders {
  constructor(init = {}) {
    this._m = new Map(Object.entries(init).map(([k, v]) => [k.toLowerCase(), String(v)]));
  }
  get(name) { return this._m.get(String(name).toLowerCase()) ?? null; }
}
class MiniRequest {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method || 'GET';
    this.headers = new MiniHeaders(init.headers);
    this._body = init.body;
  }
  async json() { return JSON.parse(this._body); }
}
class MiniResponse {
  constructor(body, init = {}) {
    this._body = body;
    this.status = init.status ?? 200;
    this.ok = this.status >= 200 && this.status < 300;
    this.headers = new MiniHeaders(init.headers);
  }
  async json() { return JSON.parse(this._body); }
}
globalThis.Request ??= MiniRequest;
globalThis.Response ??= MiniResponse;

// The function's POST accepts dates within ±36h of "now"; UTC-today is always
// inside that window regardless of when/where the suite runs.
const TODAY = new Date().toISOString().slice(0, 10);
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10); // always > +36h

const DAY_TTL = 90 * 24 * 60 * 60;
const RL_TTL = 2 * 24 * 60 * 60;

function makeKV(seed = {}) {
  const store = new Map(Object.entries(seed));
  const puts = [];
  return {
    store,
    puts,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts = {}) {
      store.set(key, value);
      puts.push({ key, value, ttl: opts.expirationTtl });
    },
  };
}

function postRequest(body, { ip = '203.0.113.9', raw, date = TODAY } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ip !== null) headers['CF-Connecting-IP'] = ip;
  return new Request(`https://jeweled.test/api/leaderboard/${date}`, {
    method: 'POST',
    headers,
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
}

function getCtx({ date = TODAY, kv = makeKV(), env } = {}) {
  return { env: env !== undefined ? env : { LEADERBOARD: kv }, params: { date } };
}

function postCtx(body, { date = TODAY, kv = makeKV(), env, ip, raw } = {}) {
  return {
    env: env !== undefined ? env : { LEADERBOARD: kv },
    params: { date },
    request: postRequest(body, { ip, raw, date }),
  };
}

// Sorted-desc board of n unique scores: base, base-step, base-2*step, …
const board = (n, base = 5000, step = 10) =>
  Array.from({ length: n }, (_, i) => ({ name: `p${i}`, score: base - i * step }));

describe('onRequestGet', () => {
  it('returns an empty board with JSON + no-store headers when nothing is stored', async () => {
    const res = await onRequestGet(getCtx({ date: '2026-07-01' }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toBe('application/json');
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({ date: '2026-07-01', entries: [] });
  });

  it('returns stored entries sorted desc, shaped to {name, score}, capped at 50', async () => {
    const stored = board(60, 600, 10);                    // 60 entries, 600..10
    const shuffled = [...stored].reverse();               // stored out of order on purpose
    shuffled[0].extra = 'stripme';                        // junk field must not leak
    const kv = makeKV({ 'day:2026-07-01': JSON.stringify(shuffled) });
    const res = await onRequestGet(getCtx({ date: '2026-07-01', kv }));
    const bodyOut = await res.json();
    expect(bodyOut.entries).toHaveLength(50);
    expect(bodyOut.entries[0]).toEqual({ name: 'p0', score: 600 });   // exact keys only
    expect(bodyOut.entries[49]).toEqual({ name: 'p49', score: 110 }); // 51st+ truncated
  });

  it('collapses corrupt or non-array stored blobs to an empty board', async () => {
    for (const bad of ['{not json', '"just a string"', '{"a":1}']) {
      const kv = makeKV({ 'day:2026-07-01': bad });
      const res = await onRequestGet(getCtx({ date: '2026-07-01', kv }));
      expect(res.status).toBe(200);
      expect((await res.json()).entries).toEqual([]);
    }
  });

  it('filters malformed rows out of a stored board', async () => {
    const kv = makeKV({
      'day:2026-07-01': JSON.stringify([
        { name: 'ok', score: 5 },
        { name: 7, score: 5 },        // non-string name
        { score: 5 },                 // missing name
        null,                         // junk row
        { name: 'x', score: '9' },    // non-numeric score
      ]),
    });
    const res = await onRequestGet(getCtx({ date: '2026-07-01', kv }));
    expect((await res.json()).entries).toEqual([{ name: 'ok', score: 5 }]);
  });

  it.each(['2026-7-01', '20260701', 'not-a-date', '2026-07-011', ''])(
    'rejects malformed date %j with 400', async (date) => {
      const res = await onRequestGet(getCtx({ date }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad date' });
    },
  );

  it('rejects a missing date param with 400', async () => {
    const res = await onRequestGet({ env: { LEADERBOARD: makeKV() }, params: {} });
    expect(res.status).toBe(400);
  });

  it('returns 503 when the KV binding is missing', async () => {
    const res = await onRequestGet(getCtx({ env: {} }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBeTruthy();
    // A context with no env at all exercises the defensive ?. path.
    const bare = await onRequestGet({ params: { date: TODAY } });
    expect(bare.status).toBe(503);
  });

  it('returns 500 when KV throws', async () => {
    const kv = { get: async () => { throw new Error('kv down'); } };
    const res = await onRequestGet(getCtx({ kv }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });
});

describe('onRequestPost', () => {
  it('accepts a first submission: trims the name, stores with TTLs, returns rank 1', async () => {
    const kv = makeKV();
    const res = await onRequestPost(postCtx({ name: '  Alice  ', score: 500 }, { kv }));
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect(await res.json()).toEqual({
      date: TODAY,
      entries: [{ name: 'Alice', score: 500 }],
      rank: 1,
    });

    const dayPut = kv.puts.find((p) => p.key === `day:${TODAY}`);
    expect(JSON.parse(dayPut.value)).toEqual([{ name: 'Alice', score: 500 }]);
    expect(dayPut.ttl).toBe(DAY_TTL);

    const rlPut = kv.puts.find((p) => p.key === `rl:${TODAY}:203.0.113.9`);
    expect(rlPut.value).toBe('1');
    expect(rlPut.ttl).toBe(RL_TTL);
  });

  it('strips control characters from the name', async () => {
    const name = `${String.fromCharCode(1)} Bo${String.fromCharCode(0)}b ${String.fromCharCode(0x9f)}`;
    const res = await onRequestPost(postCtx({ name, score: 10 }));
    expect((await res.json()).entries[0].name).toBe('Bob');
  });

  it('inserts into an existing board sorted desc and reports the true rank', async () => {
    const kv = makeKV({
      [`day:${TODAY}`]: JSON.stringify([{ name: 'A', score: 300 }, { name: 'B', score: 100 }]),
    });
    const res = await onRequestPost(postCtx({ name: 'C', score: 200 }, { kv }));
    const bodyOut = await res.json();
    expect(bodyOut.rank).toBe(2);
    expect(bodyOut.entries.map((e) => e.score)).toEqual([300, 200, 100]);
  });

  it('ranks a tied score after the earlier submitter (stable sort)', async () => {
    const kv = makeKV({ [`day:${TODAY}`]: JSON.stringify([{ name: 'A', score: 300 }]) });
    const res = await onRequestPost(postCtx({ name: 'C', score: 300 }, { kv }));
    const bodyOut = await res.json();
    expect(bodyOut.rank).toBe(2);
    expect(bodyOut.entries.map((e) => e.name)).toEqual(['A', 'C']);
  });

  it('keeps only the top 100 stored and the top 50 in the response', async () => {
    const kv = makeKV({ [`day:${TODAY}`]: JSON.stringify(board(100)) }); // scores 5000..4010
    const res = await onRequestPost(postCtx({ name: 'New', score: 4015 }, { kv }));
    const bodyOut = await res.json();
    expect(bodyOut.rank).toBe(100);
    expect(bodyOut.entries).toHaveLength(50);

    const stored = JSON.parse(kv.puts.find((p) => p.key === `day:${TODAY}`).value);
    expect(stored).toHaveLength(100);
    expect(stored[99]).toEqual({ name: 'New', score: 4015 });      // squeezed in…
    expect(stored.some((e) => e.score === 4010)).toBe(false);      // …old #100 dropped
  });

  it('reports rank 101 for a score below the stored cutoff without storing it', async () => {
    const kv = makeKV({ [`day:${TODAY}`]: JSON.stringify(board(100)) });
    const res = await onRequestPost(postCtx({ name: 'Slow', score: 12 }, { kv }));
    const bodyOut = await res.json();
    expect(bodyOut.rank).toBe(101);
    expect(bodyOut.entries).toHaveLength(50);
    expect(bodyOut.entries.some((e) => e.name === 'Slow')).toBe(false);
    const stored = JSON.parse(kv.puts.find((p) => p.key === `day:${TODAY}`).value);
    expect(stored).toHaveLength(100);
    expect(stored.some((e) => e.name === 'Slow')).toBe(false);
  });

  describe('validation → 400', () => {
    it.each([
      ['missing name', { score: 10 }],
      ['non-string name', { name: 42, score: 10 }],
      ['empty name', { name: '', score: 10 }],
      ['whitespace-only name', { name: '   ', score: 10 }],
      ['name longer than 16 chars', { name: 'a'.repeat(17), score: 10 }],
      ['control-chars-only name', { name: String.fromCharCode(0, 1, 31), score: 10 }],
      ['missing score', { name: 'Bob' }],
      ['string score', { name: 'Bob', score: '500' }],
      ['fractional score', { name: 'Bob', score: 1.5 }],
      ['negative score', { name: 'Bob', score: -1 }],
      ['score above 1,000,000', { name: 'Bob', score: 1_000_001 }],
    ])('%s', async (_label, body) => {
      const res = await onRequestPost(postCtx(body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeTruthy();
    });

    it('accepts the score boundaries 0 and 1,000,000', async () => {
      for (const score of [0, 1_000_000]) {
        const res = await onRequestPost(postCtx({ name: 'Edge', score }));
        expect(res.status).toBe(200);
      }
    });

    it.each(['2020-01-01', FUTURE, '2026-02-31'])(
      'rejects date %s outside the ±36h window', async (date) => {
        const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { date }));
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: 'date out of range' });
      },
    );

    it.each(['2026-7-01', 'nope', ''])('rejects malformed date %j', async (date) => {
      const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { date }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad date' });
    });

    it.each([
      ['unparseable JSON', '{nope'],
      ['JSON null', 'null'],
      ['JSON scalar', '"hello"'],
    ])('rejects a bad body: %s', async (_label, raw) => {
      const res = await onRequestPost(postCtx(undefined, { raw }));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'bad body' });
    });
  });

  describe('rate limit', () => {
    it('allows 3 submissions per IP per day, then returns 429', async () => {
      const kv = makeKV();
      for (let i = 0; i < 3; i++) {
        const res = await onRequestPost(postCtx({ name: `Bob${i}`, score: 10 + i }, { kv }));
        expect(res.status).toBe(200);
      }
      const res4 = await onRequestPost(postCtx({ name: 'Bob4', score: 99 }, { kv }));
      expect(res4.status).toBe(429);
      expect(await res4.json()).toEqual({ error: 'rate limited' });
      // Counter climbed 1→3 and the blocked attempt wrote nothing.
      expect(kv.puts.filter((p) => p.key.startsWith('rl:')).map((p) => p.value)).toEqual(['1', '2', '3']);
      expect(kv.puts.filter((p) => p.key.startsWith('day:'))).toHaveLength(3);

      // …but a different IP is still welcome.
      const other = await onRequestPost(postCtx({ name: 'Eve', score: 5 }, { kv, ip: '198.51.100.7' }));
      expect(other.status).toBe(200);
    });

    it('blocks immediately when the counter is already at the limit', async () => {
      const kv = makeKV({ [`rl:${TODAY}:203.0.113.9`]: '3' });
      const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { kv }));
      expect(res.status).toBe(429);
      expect(kv.puts).toHaveLength(0);   // no board write, no counter bump
    });

    it('falls back to an "unknown" bucket when CF-Connecting-IP is absent', async () => {
      const kv = makeKV();
      const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { kv, ip: null }));
      expect(res.status).toBe(200);
      expect(kv.puts.some((p) => p.key === `rl:${TODAY}:unknown`)).toBe(true);
    });
  });

  it('returns 503 when the KV binding is missing', async () => {
    const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { env: {} }));
    expect(res.status).toBe(503);
  });

  it('returns 500 when KV get throws', async () => {
    const kv = { get: async () => { throw new Error('kv down'); }, put: async () => {} };
    const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { kv }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal error' });
  });

  it('returns 500 when KV put throws', async () => {
    const kv = { get: async () => null, put: async () => { throw new Error('kv full'); } };
    const res = await onRequestPost(postCtx({ name: 'Bob', score: 10 }, { kv }));
    expect(res.status).toBe(500);
  });
});
