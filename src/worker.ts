import { handleIntegrationRequest } from './integrations/index';
import type { IntegrationEnv } from './integrations/index';
import { commerceRequest } from './commerce/index';
import { consumeOutbox, reconcile, recoverOutbox } from './commerce/payments';
import { HttpError, json } from './commerce/types';
import { storageRequest, receiveEmail, type StorageEnv } from './storage';

export interface Env extends IntegrationEnv, StorageEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS?: Queue;
  PUBLIC_ORIGIN: string;
}

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/api/config') return json({
        turnstileSiteKey: env.TURNSTILE_SITE_KEY ?? null,
        googleEnabled: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.BETTER_AUTH_SECRET),
      });
      // Explicit public allowlist. No session, cookie, token or PII enters these cache values.
      // Preserve supported pagination; discard tracking/unsupported query parameters.
      if (request.method === 'GET' && (url.pathname === '/api/catalog' || /^\/api\/catalog\/[a-z0-9-]{1,100}$/.test(url.pathname))) {
        const cacheUrl = new URL(`${url.origin}${url.pathname}`);
        if (url.pathname === '/api/catalog') for (const name of ['after', 'limit']) {
          const value = url.searchParams.get(name); if (value !== null) cacheUrl.searchParams.set(name, value);
        }
        const key = new Request(cacheUrl);
        const cached = await caches.default.match(key);
        if (cached) return cached;
        const response = await commerceRequest(request, env);
        if (response) {
          if (response.ok) {
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
      if (error instanceof HttpError) return json({ error: error.message, ...(error.details ? { details: error.details } : {}) }, error.status);
      // Integration errors may carry HTTP status without sharing commerce's error class.
      if (error instanceof Error && 'status' in error && typeof error.status === 'number' && error.status >= 400 && error.status < 500) return json({ error: error.message }, error.status);
      if (/CHECK constraint failed|UNIQUE constraint failed|FOREIGN KEY constraint failed|campaign_overlap|catalog_changed|campaign_changed|checkout_changed|inventory_missing/.test(String(error))) return json({ error: 'Conflicting or invalid business operation' }, 409);
      console.error('Commerce request failed', { kind: error instanceof Error ? error.name : 'UnknownError' });
      return json({ error: 'Service temporarily unavailable' }, 503);
    }
  },
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    await reconcile(env);
    await recoverOutbox(env);
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
      catch { message.retry(); }
    }
  },
} satisfies ExportedHandler<Env, { outboxId: string }>;
