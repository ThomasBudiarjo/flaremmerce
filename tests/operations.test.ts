import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import worker, { type Env } from '../src/worker';

let mf: Miniflare, env: Env, cookie: string;
const secret = 'test-secret-at-least-thirty-two-characters';
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-06', d1Databases: { DB: 'operations' } }));
  const DB = await mf.getD1Database('DB');
  for (const name of ['0001_commerce', '0002_integrations', '0004_manual_review', '0007_operations']) await DB.exec(readFileSync(new URL(`../migrations/${name}.sql`, import.meta.url), 'utf8').replace(/--[^\n]*/g, '').replace(/\s+/g, ' '));
  env = { DB, PUBLIC_ORIGIN: 'https://shop.example', BETTER_AUTH_SECRET: secret, GOOGLE_CLIENT_ID: 'test', GOOGLE_CLIENT_SECRET: 'test', ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env;
  const now = Date.now();
  await DB.batch([
    DB.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('owner','owner','private@example.com',1,now,now),
    DB.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('session','token-owner','owner',now+3600000,now,now),
    DB.prepare('INSERT INTO admin_roles VALUES (?,?,?)').bind('owner','owner',now),
  ]);
  cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`token-owner.${createHmac('sha256',secret).update('token-owner').digest('base64')}`)}`;
});
afterEach(async () => { vi.unstubAllGlobals(); vi.restoreAllMocks(); await mf?.dispose(); });
function get(path = '/api/admin/operations', auth = cookie) {
  return worker.fetch(new Request(`https://shop.example${path}`, { headers: { Cookie: auth, 'X-Request-ID': 'client-injected-secret' } }), env);
}
it('requires fresh real admin authorization and gives private correlated errors without log injection', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect((await get(undefined, '')).status).toBe(401);
  expect((await get()).status).toBe(200);
  await env.DB.prepare('DELETE FROM admin_roles').run();
  const denied = await get('/api/admin/operations?secret=private-query');
  expect(denied.status).toBe(403);
  expect(denied.headers.get('Cache-Control')).toBe('private, no-store');
  expect(denied.headers.get('X-Request-ID')).toMatch(/^[0-9a-f-]{36}$/);
  expect(log.mock.calls.at(-1)?.[1]).toMatchObject({ requestId: denied.headers.get('X-Request-ID'), category: 'admin', status: 403 });
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/private-query|client-injected-secret|token-owner|private@example/);
  await env.DB.prepare('DELETE FROM session').run();
  expect((await get()).status).toBe(401);
});
it('returns bounded oldest unfinished samples, exhausted attempts, server ages and no private columns', async () => {
  // Fixture creation bypasses checkout-only insertion guard, not request/auth/query behavior.
  await env.DB.exec('DROP TRIGGER attempt_checkout_guard');
  const created = Date.now() - 3600000;
  for (let i = 0; i < 23; i++) {
    const id = `order-${String(i).padStart(2,'0')}`;
    await env.DB.prepare("INSERT INTO orders(id,reference,guest_token_hash,contact_json,address_json,shipping_json,total,created_at) VALUES(?,?,'private-token','private-contact','private-address','private-shipping',0,?)").bind(id,`reference-${i}`,created+i).run();
    await env.DB.prepare("INSERT INTO payment_attempts(id,order_id,reference,status,checks,next_check,created_at,url,provider_id) VALUES(?,?,?,'unknown',8,0,?,'private-url',?)").bind(`attempt-${i}`,id,`reference-${i}`,created+i,`private-provider-${i}`).run();
    await env.DB.prepare("INSERT INTO outbox_events(id,order_id,kind,status,attempts,next_run,created_at) VALUES(?,?,'paid',?,8,0,?)").bind(`outbox-${i}`,id,i % 2 ? 'dead' : 'pending',created+i).run();
    await env.DB.prepare("INSERT INTO manual_review(id,order_id,reason,created_at) VALUES(?,?,'private-reason',?)").bind(`review-${i}`,id,created+i).run();
  }
  const response = await get('/api/admin/operations?limit=999');
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const data = await response.json() as any;
  expect(data.sampleLimit).toBe(20);
  for (const section of Object.values(data.sections) as any[]) {
    expect(section.items).toHaveLength(20); expect(section.hasMore).toBe(true); expect(section.atLeast).toBe(21);
    expect(section.items[0].createdAt).toBe(created);
    expect(section.items[0].ageMs).toBe(data.now - created);
  }
  expect(data.sections.payments.items[0].attempts).toBe(8);
  expect(JSON.stringify(data)).not.toContain('private-');
  await env.DB.prepare("UPDATE outbox_events SET status='done'").run();
  const next = await (await get()).json() as any;
  expect(next.sections.outbox).toEqual({ items: [], hasMore: false, atLeast: 0 });
});
it('uses a fresh server correlation ID on cached catalog responses without storing it', async () => {
  let stored: Response | undefined;
  vi.stubGlobal('caches', { default: { match: async () => stored?.clone(), put: async (_key: Request, response: Response) => { stored = response.clone(); } } });
  const first = await get('/api/catalog'), second = await get('/api/catalog');
  expect(first.status).toBe(200); expect(second.status).toBe(200);
  expect(first.headers.get('X-Request-ID')).not.toBe(second.headers.get('X-Request-ID'));
  expect(stored!.headers.has('X-Request-ID')).toBe(false);
});
it('continues durable outbox recovery when the payment scanner database query fails', async () => {
  await env.DB.prepare("INSERT INTO orders(id,reference,guest_token_hash,contact_json,address_json,shipping_json,total,created_at) VALUES('order','ref','hash','{}','{}','{}',0,0)").run();
  await env.DB.prepare("INSERT INTO outbox_events(id,order_id,kind,next_run,created_at) VALUES('outbox','order','paid',0,0)").run();
  await env.DB.exec('DROP TABLE payment_attempts');
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow('Background recovery failed');
  expect(await env.DB.prepare("SELECT status FROM outbox_events WHERE id='outbox'").first('status')).toBe('done');
});

it('continues payment exhaustion review when outbox scanning fails and reports both scanner failures safely', async () => {
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  await env.DB.exec('DROP TRIGGER attempt_checkout_guard');
  await env.DB.prepare("INSERT INTO orders(id,reference,guest_token_hash,contact_json,address_json,shipping_json,total,created_at) VALUES('order','ref','hash','{}','{}','{}',0,0)").run();
  await env.DB.prepare("INSERT INTO payment_attempts(id,order_id,reference,checks,next_check,created_at) VALUES('attempt','order','ref',8,0,0)").run();
  await env.DB.exec('DROP TABLE outbox_events');
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow('Background recovery failed');
  expect(await env.DB.prepare("SELECT reason FROM manual_review WHERE order_id='order'").first('reason')).toBe('reconciliation_exhausted');
  await env.DB.exec('DROP TABLE payment_attempts');
  await expect(worker.scheduled({} as ScheduledController, env)).rejects.toThrow('Background recovery failed');
  expect(JSON.stringify(log.mock.calls)).toContain('payment_recovery');
  expect(JSON.stringify(log.mock.calls)).toContain('outbox_recovery');
  expect(JSON.stringify(log.mock.calls)).not.toMatch(/token-owner|private@example|SQLITE|no such table/);
});
