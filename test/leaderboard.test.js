import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchDaily, submitDaily } from '../src/leaderboard.js';

// src/leaderboard.js is fetch-only, so every scenario is a global-fetch stub.
// The module's contract: {ok:true, entries, rank?} on a well-formed 200 and
// {ok:false} for EVERYTHING else — the game treats a missing/broken backend
// as "feature silently absent", so no path may throw or reject.

function jsonResponse(data, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  };
}

function stubFetch(impl) {
  const mock = typeof impl === 'function' ? vi.fn(impl) : vi.fn().mockResolvedValue(impl);
  vi.stubGlobal('fetch', mock);
  return mock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchDaily', () => {
  it('returns {ok:true, entries} on a 200 with a well-formed body', async () => {
    const entries = [{ name: 'Ana', score: 900 }, { name: 'Bo', score: 400 }];
    const mock = stubFetch(jsonResponse({ date: '2026-07-01', entries }));
    const res = await fetchDaily('2026-07-01');
    expect(res).toEqual({ ok: true, entries });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(mock).toHaveBeenCalledWith(
      '/api/leaderboard/2026-07-01',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    // GET path: no method/body/headers are set.
    const init = mock.mock.calls[0][1];
    expect(init.method).toBeUndefined();
    expect(init.body).toBeUndefined();
  });

  it('omits rank when the server did not send one', async () => {
    stubFetch(jsonResponse({ date: '2026-07-01', entries: [] }));
    const res = await fetchDaily('2026-07-01');
    expect(res.ok).toBe(true);
    expect('rank' in res).toBe(false);
  });

  it('includes rank only when it is an integer', async () => {
    stubFetch(jsonResponse({ date: '2026-07-01', entries: [], rank: 7 }));
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: true, entries: [], rank: 7 });

    stubFetch(jsonResponse({ date: '2026-07-01', entries: [], rank: 'first' }));
    expect('rank' in await fetchDaily('2026-07-01')).toBe(false);
  });

  it('URL-encodes the date segment', async () => {
    const mock = stubFetch(jsonResponse({ entries: [] }));
    await fetchDaily('2026-07-01?x=1');
    expect(mock).toHaveBeenCalledWith('/api/leaderboard/2026-07-01%3Fx%3D1', expect.anything());
  });

  it.each([400, 404, 429, 500, 503])('returns {ok:false} on HTTP %i', async (status) => {
    stubFetch(jsonResponse({ error: 'nope' }, status));
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: false });
  });

  it('returns {ok:false} on a network error (fetch rejects)', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: false });
  });

  it('returns {ok:false} when the body is not valid JSON', async () => {
    stubFetch({ ok: true, status: 200, json: async () => { throw new SyntaxError('bad json'); } });
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: false });
  });

  it('returns {ok:false} when the body parses to null', async () => {
    stubFetch(jsonResponse(null));
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: false });
  });

  it('returns {ok:false} when entries is missing or not an array', async () => {
    stubFetch(jsonResponse({ date: '2026-07-01' }));
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: false });

    stubFetch(jsonResponse({ date: '2026-07-01', entries: 'lots' }));
    expect(await fetchDaily('2026-07-01')).toEqual({ ok: false });
  });

  it('aborts after the 3s timeout and resolves {ok:false}', async () => {
    vi.useFakeTimers();
    // A fetch that never settles on its own — it only rejects via the signal,
    // exactly like a hung network call being aborted.
    const mock = stubFetch((url, init) => new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () =>
        reject(new DOMException('The operation was aborted.', 'AbortError')));
    }));
    const pending = fetchDaily('2026-07-01');
    const signal = mock.mock.calls[0][1].signal;

    await vi.advanceTimersByTimeAsync(2999);
    expect(signal.aborted).toBe(false);     // still in-flight just before the deadline
    await vi.advanceTimersByTimeAsync(1);
    expect(signal.aborted).toBe(true);      // deadline hit → aborted

    await expect(pending).resolves.toEqual({ ok: false });
  });

  it('clears the timeout on success so the signal never fires late', async () => {
    vi.useFakeTimers();
    const mock = stubFetch(jsonResponse({ entries: [] }));
    await fetchDaily('2026-07-01');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(mock.mock.calls[0][1].signal.aborted).toBe(false);
  });
});

describe('submitDaily', () => {
  it('POSTs {name, score} as JSON and returns entries + rank', async () => {
    const entries = [{ name: 'Zoe', score: 1200 }, { name: 'Ana', score: 900 }];
    const mock = stubFetch(jsonResponse({ date: '2026-07-01', entries, rank: 1 }));
    const res = await submitDaily('2026-07-01', 'Zoe', 1200);
    expect(res).toEqual({ ok: true, entries, rank: 1 });
    expect(mock).toHaveBeenCalledWith('/api/leaderboard/2026-07-01', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Zoe', score: 1200 }),
      signal: expect.any(AbortSignal),
    }));
  });

  it('returns {ok:false} on a rejected submission (rate limit, validation…)', async () => {
    stubFetch(jsonResponse({ error: 'rate limited' }, 429));
    expect(await submitDaily('2026-07-01', 'Zoe', 1200)).toEqual({ ok: false });
  });

  it('returns {ok:false} on a network error', async () => {
    stubFetch(() => Promise.reject(new TypeError('Failed to fetch')));
    expect(await submitDaily('2026-07-01', 'Zoe', 1200)).toEqual({ ok: false });
  });
});
