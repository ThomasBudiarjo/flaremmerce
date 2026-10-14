import { json } from './commerce/types';
import { clientIp, hmac, optionalRiskSecret } from './shared';

export interface RateLimitEnv {
  DB: D1Database;
  RISK_HASH_SECRET?: string;
  APP_ENV?: string;
  RL_CHECKOUT?: RateLimit;
  RL_QUOTE?: RateLimit;
  RL_LOOKUP?: RateLimit;
  RL_AUTH?: RateLimit;
}
// Must mirror the `ratelimits` bindings in wrangler.jsonc; the D1 fallback enforces the same numbers.
export const RATE_LIMITS = {
  checkout: { binding: 'RL_CHECKOUT', limit: 10, period: 60 },
  quote: { binding: 'RL_QUOTE', limit: 30, period: 60 },
  lookup: { binding: 'RL_LOOKUP', limit: 60, period: 60 },
  auth: { binding: 'RL_AUTH', limit: 10, period: 60 },
} as const;
type Bucket = keyof typeof RATE_LIMITS;

function bucket(method: string, path: string): { bucket: Bucket; route: string } | null {
  if (method === 'POST' && path === '/api/checkout') return { bucket: 'checkout', route: path };
  if (method === 'POST' && (path === '/api/shipping/quote' || path === '/api/shipping/destinations' || path === '/api/cart/preview')) return { bucket: 'quote', route: path };
  if (path === '/api/account/addresses' || path.startsWith('/api/account/addresses/')) return { bucket: 'lookup', route: 'account:addresses' };
  // Per-reference paths share one counter so enumerating references cannot multiply the budget.
  if ((method === 'GET' || method === 'POST') && path.startsWith('/api/orders/')) return { bucket: 'lookup', route: path.endsWith('/cancel') ? 'orders:cancel' : 'orders:read' };
  if (method === 'POST' && (path.startsWith('/api/auth/') || path === '/api/setup')) return { bucket: 'auth', route: 'auth' };
  return null;
}

/** Null when allowed. The webhook and admin APIs are never limited here. */
export async function rateLimit(request: Request, env: RateLimitEnv): Promise<Response | null> {
  const match = bucket(request.method, new URL(request.url).pathname);
  if (!match) return null;
  const rule = RATE_LIMITS[match.bucket], ip = clientIp(request);
  const binding = env[rule.binding];
  let allowed = true;
  if (binding) allowed = (await binding.limit({ key: `${match.route}:${ip}` })).success;
  else {
    // Fallback only where the binding is absent (older runtimes, tests). The key stores an HMAC, never the IP.
    const secret = optionalRiskSecret(env);
    if (!secret) return null;
    const window = Math.floor(Date.now() / (rule.period * 1000)) * rule.period * 1000;
    try {
      const count = await env.DB.prepare('INSERT INTO rate_counters(key,"window",count) VALUES(?,?,1) ON CONFLICT(key,"window") DO UPDATE SET count=count+1 RETURNING count')
        .bind(`${match.route}:${await hmac(secret, `rate:${ip}`)}`, window).first<number>('count');
      allowed = (count ?? 0) <= rule.limit;
    } catch {
      // An abuse control must not take checkout down with it; the edge WAF rule remains the outer bound.
      console.warn('rate_limit_unavailable', { bucket: match.bucket });
    }
  }
  if (allowed) return null;
  return json({ error: 'Terlalu banyak permintaan. Coba lagi sebentar.' }, 429, { 'Retry-After': String(rule.period) });
}

/** Old fixed windows are useless after their period; bounded so one cron run stays cheap. */
export async function pruneRateCounters(env: RateLimitEnv) {
  await env.DB.prepare('DELETE FROM rate_counters WHERE (key,"window") IN (SELECT key,"window" FROM rate_counters WHERE "window"<? LIMIT 1000)').bind(Date.now() - 120_000).run();
}
