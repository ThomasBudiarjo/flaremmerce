import { handleIntegrationRequest } from './integrations/index';
import { devLoginEnabled, stagingLoginEnabled } from './integrations/auth';
import type { IntegrationEnv } from './integrations/index';
import { commerceRequest } from './commerce/index';
import { consumeOutbox, reconcile, recoverOutbox } from './commerce/payments';
import { json } from './commerce/types';
import { catalogParams, environment, HttpError, paymentsConfigured, publicCacheKey, shippingConfigured, turnstileSkipped } from './shared';
import { inboundRetention, storageRequest, receiveEmail, type StorageEnv } from './storage';
import { autoComplete, commerceRetention } from './commerce/lifecycle';
import { integrationRetention } from './integrations/retention';
import { robots, sitemap } from './seo';
import { pruneRateCounters, rateLimit, type RateLimitEnv } from './ratelimit';

export interface Env extends IntegrationEnv, StorageEnv, RateLimitEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS?: Queue;
  PUBLIC_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    const requestId = crypto.randomUUID();
    const pathname = new URL(request.url).pathname;
    const category = pathname.startsWith('/api/admin/') ? 'admin' : pathname.startsWith('/api/catalog') ? 'catalog' : pathname.startsWith('/api/auth/') ? 'auth' : 'api';
    const execute = async (): Promise<Response> => {
    try {
      const url = new URL(request.url);
      const limited = await rateLimit(request, env);
      if (limited) return limited;
      if (request.method === 'GET' && (url.pathname === '/sitemap.xml' || url.pathname === '/robots.txt')) {
        const origin = new URL(env.PUBLIC_ORIGIN).origin;
        if (url.pathname === '/robots.txt') return robots(origin, environment(env) === 'staging');
        // Keyed on the canonical origin: the document lists only public URLs, never request data.
        const key = new Request(`${origin}/sitemap.xml`), cached = await caches.default.match(key);
        if (cached) return cached;
        const response = await sitemap(env, origin);
        const store = caches.default.put(key, response.clone()).catch(() => {});
        if (context) context.waitUntil(store); else await store;
        return response;
      }
      if (request.method === 'GET' && url.pathname === '/api/config') {
        const skipTurnstile = turnstileSkipped(env);
        return json({
          environment: environment(env),
          turnstileSiteKey: skipTurnstile ? null : env.TURNSTILE_SITE_KEY ?? null,
          turnstile: !skipTurnstile,
          googleEnabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.BETTER_AUTH_SECRET),
          devLoginEnabled: devLoginEnabled(env),
          stagingLogin: stagingLoginEnabled(env),
          payments: paymentsConfigured(env),
          shipping: shippingConfigured(env),
        });
      }
      // Explicit public allowlist. No session, cookie, token or PII enters these cache values.
      // Preserve supported pagination; discard tracking/unsupported query parameters.
      if (request.method === 'GET' && (url.pathname === '/api/catalog' || url.pathname === '/api/categories' || /^\/api\/catalog\/[a-z0-9-]{1,100}$/.test(url.pathname))) {
        const key = publicCacheKey(url, url.pathname === '/api/catalog' ? catalogParams : {});
        const cached = key && await caches.default.match(key);
        if (cached) return cached;
        const response = await commerceRequest(request, env);
        if (response) {
          if (key && response.ok) {
            const store = caches.default.put(key, response.clone()).catch(() => {});
            if (context) context.waitUntil(store); else await store;
          }
          return response;
        }
      }
      // Integrations dispatch only their routes; public catalog never performs an auth read.
      const integration = await handleIntegrationRequest(request, env);
      if (integration) return integration;
      const storage = await storageRequest(request, env);
      if (storage) return storage;
      const commerce = await commerceRequest(request, env);
      if (commerce) return commerce;
      return env.ASSETS.fetch(request);
    } catch (error) {
      if (error instanceof URIError) return json({ error: 'Invalid path encoding' }, 400);
      if (error instanceof HttpError) return json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
      // Status-carrying errors from outside this codebase's error class (e.g. test doubles at the integration seam).
      if (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) return json({ error: error.message }, error.status);
      if (/CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed|campaign_overlap|catalog_changed|campaign_changed|checkout_changed|inventory_missing/.test(String(error))) return json({ error: 'Conflicting or invalid business operation' }, 409);
      return json({ error: 'Service temporarily unavailable' }, 503);
    }
    };
    const response = await execute();
    if (!pathname.startsWith('/api/')) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Request-ID', requestId);
    if (response.status >= 400) {
      headers.set('Cache-Control', 'private, no-store');
      console.error('api_error', { requestId, category, status: response.status, kind: response.status >= 500 ? 'service_error' : 'request_error' });
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const results = await Promise.allSettled([reconcile(env), recoverOutbox(env)]);
    // Housekeeping only: a failure here never masks or fails the recovery scanners. Each task is a few bounded statements.
    const housekeeping = { rate_counter_prune: pruneRateCounters, auto_complete: autoComplete, commerce_retention: commerceRetention, integration_retention: integrationRetention, inbound_retention: inboundRetention };
    for (const [category, task] of Object.entries(housekeeping)) await task(env).catch(() => console.warn('cron_error', { category, kind: 'background_error' }));
    const failures = results.filter(result => result.status === 'rejected');
    results.forEach((result, index) => {
      if (result.status === 'rejected') console.error('cron_error', { category: index === 0 ? 'payment_recovery' : 'outbox_recovery', kind: 'background_error' });
    });
    if (failures.length) throw new AggregateError(results.flatMap((result, index) => result.status === 'rejected' ? [new Error(index === 0 ? 'Payment recovery failed' : 'Outbox recovery failed')] : []), 'Background recovery failed');
  },
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    await receiveEmail(message, env);
  },
  async queue(batch: MessageBatch<{ outboxId: string }>, env: Env): Promise<void> {
    // Even a misconfigured large queue batch must stay within the Free subrequest budget.
    for (const message of batch.messages.slice(20)) message.retry({ delaySeconds: 30 });
    for (const message of batch.messages.slice(0, 20)) {
      if (!message.body || typeof message.body.outboxId !== 'string' || message.body.outboxId.length > 200) { message.ack(); continue; }
      try { await consumeOutbox(env, message.body.outboxId); message.ack(); }
      catch { console.warn('outbox_queue_retry', { kind: 'delivery_error' }); message.retry(); }
    }
  },
} satisfies ExportedHandler<Env, { outboxId: string }>;
