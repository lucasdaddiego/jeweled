// Minimal module-worker adapter for exercising the Pages Function handlers
// inside workerd. Cloudflare Pages supplies params/env/request in production;
// this adapter supplies the same shape after routing the test request.

import {
  onRequestGet, onRequestPost,
} from '../functions/api/leaderboard/[date].js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/api\/leaderboard\/([^/]+)$/);
    if (!match) return new Response('not found', { status: 404 });
    const context = {
      request,
      env,
      params: { date: decodeURIComponent(match[1]) },
    };
    if (request.method === 'GET') return onRequestGet(context);
    if (request.method === 'POST') return onRequestPost(context);
    return new Response('method not allowed', { status: 405 });
  },
};
