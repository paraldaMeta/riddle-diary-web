import { handleAuthRoute } from './auth.js';
import { handleBillingRoute } from './billing.js';
import { handleHistoryRoute } from './history.js';
import { handleAsk } from './oracle.js';
import { RequestError, jsonError, unixNow } from './http.js';

async function route(request, env) {
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/+$/, '') || '/';

  if (pathname === '/api/ask' && request.method === 'POST') return handleAsk(request, env);

  const authResponse = await handleAuthRoute(request, env, pathname);
  if (authResponse) return authResponse;

  const billingResponse = await handleBillingRoute(request, env, pathname);
  if (billingResponse) return billingResponse;

  const historyResponse = await handleHistoryRoute(request, env, pathname);
  if (historyResponse) return historyResponse;

  if (pathname.startsWith('/api/')) throw new RequestError('未找到该接口', 404, 'NOT_FOUND');
  if (!env.ASSETS) throw new RequestError('页面资源尚未配置', 503, 'ASSETS_UNAVAILABLE');
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env, context) {
    try {
      const response = await route(request, env);
      if (Math.random() < 0.01 && env.DB) {
        context.waitUntil(cleanExpiredData(env).catch(error => console.error('Cleanup failed', error.message)));
      }
      return response;
    } catch (error) {
      if (!(error instanceof RequestError)) {
        console.error(JSON.stringify({
          message: 'Unhandled request error',
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
      return jsonError(error);
    }
  },

  async scheduled(_event, env, context) {
    context.waitUntil(cleanExpiredData(env));
  },
};

async function cleanExpiredData(env) {
  const now = unixNow();
  await env.DB.batch([
    env.DB.prepare(`
      UPDATE usage_requests
      SET status = 'refunded', error_code = 'REQUEST_TIMEOUT', updated_at = ?
      WHERE status = 'reserved' AND created_at <= ?
    `).bind(now, now - 15 * 60),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM verification_challenges WHERE expires_at <= ? OR consumed_at IS NOT NULL').bind(now - 86400),
    env.DB.prepare('DELETE FROM oauth_states WHERE expires_at <= ?').bind(now),
    env.DB.prepare('DELETE FROM rate_limits WHERE reset_at <= ?').bind(now),
  ]);
}
