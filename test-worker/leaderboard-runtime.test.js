import { env, exports } from 'cloudflare:workers';
import { beforeEach, describe, expect, it } from 'vitest';

const TODAY = new Date().toISOString().slice(0, 10);
const endpoint = (date = TODAY) => `https://jeweled.test/api/leaderboard/${date}`;

beforeEach(async () => {
  const keys = await env.LEADERBOARD.list();
  await Promise.all(keys.keys.map(({ name }) => env.LEADERBOARD.delete(name)));
});

describe('leaderboard Pages Function in workerd', () => {
  it('writes and reads through a real KV namespace binding', async () => {
    const submitted = await exports.default.fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '203.0.113.44',
      },
      body: JSON.stringify({ name: 'Workerd', score: 9876 }),
    });
    expect(submitted.status).toBe(200);
    expect(await submitted.json()).toMatchObject({
      date: TODAY,
      entries: [{ name: 'Workerd', score: 9876 }],
      rank: 1,
    });

    const stored = await env.LEADERBOARD.get(`day:${TODAY}`, 'json');
    expect(stored).toEqual([{ name: 'Workerd', score: 9876 }]);

    const fetched = await exports.default.fetch(endpoint());
    expect(fetched.status).toBe(200);
    expect((await fetched.json()).entries).toEqual([{ name: 'Workerd', score: 9876 }]);
  });

  it('enforces the per-IP rate limit against the real binding', async () => {
    for (let i = 0; i < 3; i++) {
      const response = await exports.default.fetch(endpoint(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'CF-Connecting-IP': '198.51.100.8',
        },
        body: JSON.stringify({ name: `Run${i}`, score: i }),
      });
      expect(response.status).toBe(200);
    }
    const blocked = await exports.default.fetch(endpoint(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'CF-Connecting-IP': '198.51.100.8',
      },
      body: JSON.stringify({ name: 'Run4', score: 4 }),
    });
    expect(blocked.status).toBe(429);
  });

  it('rejects impossible calendar keys before touching KV', async () => {
    const response = await exports.default.fetch(endpoint('2026-02-29'));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: 'bad date' });
    expect((await env.LEADERBOARD.list()).keys).toHaveLength(0);
  });
});
