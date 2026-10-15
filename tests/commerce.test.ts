import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import migration from '../migrations/0001_commerce.sql?raw';
import reviewMigration from '../migrations/0004_manual_review.sql?raw';
import historyMigration from '../migrations/0005_customer_orders.sql?raw';
import pagesMigration from '../migrations/0006_admin_pages.sql?raw';
import lifecycleMigration from '../migrations/0008_lifecycle.sql?raw';
import riskMigration from '../migrations/0010_risk.sql?raw';
import ecommerceMigration from '../migrations/0012_ecommerce.sql?raw';
import reportingMigration from '../migrations/0014_reporting.sql?raw';
import worker, { housekeepingDue, type Env } from '../src/worker';
import { chargeableWeight, publicCacheKey, catalogParams, riskHash, tracking } from '../src/shared';
import { csvCell } from '../src/commerce/reports';
import { withAdminHeaders, withStorefrontHeaders } from '../src/headers';

const provider = vi.hoisted(() => ({ failCreate: false, createStatus: 200, lookupStatus: 200, lookups: 0, lookup: {status:'unknown'} as Record<string, unknown>, beforeResponse: null as null | ((input: { reference: string }) => Promise<void>) }));

// Commerce contract fixture: replace only integration boundary, never D1 or commerce logic.
// Provider calls traverse native fetch with Vitest's supported workerd outbound mock.
vi.mock('../src/integrations/index', () => ({
  handleIntegrationRequest: async () => null,
  getCustomer: async (request: Request, _env: unknown, options: { includeBanned?: boolean } = {}) => {
    const id = request.headers.get('X-Test-Customer'), banned = request.headers.get('X-Test-Banned') === '1';
    if (!id || (banned && !options.includeBanned)) return null;
    return banned ? { id, banned: true } : { id };
  },
  // X-Test-Admin: 'admin' is an owner; 'ops' and 'catalog' are the narrower roles.
  requireAdmin: async (request: Request) => {
    const role = request.headers.get('X-Test-Admin');
    if (role === 'admin') return { id: 'admin', role: 'owner' };
    if (role === 'ops' || role === 'catalog') return { id: role, role };
    throw Object.assign(new Error('Admin required'), { status: 403 });
  },
  verifyTurnstile: async (token: string) => {
    const response = await fetch('https://boundary.test/turnstile', { method: 'POST', body: token });
    if (!response.ok) throw Object.assign(new Error('Invalid Turnstile'), { status: 400 });
  },
  createPayment: async (input: unknown) => {
    const response = await fetch('https://boundary.test/create', { method: 'POST', body: JSON.stringify(input) });
    if (response.status >= 400 && response.status < 500) return { rejected: true };
    if (!response.ok) throw new Error('Provider timeout');
    if (provider.beforeResponse) await provider.beforeResponse(input as { reference: string });
    return response.json();
  },
  verifyPaymentWebhook: async (request: Request) => {
    if (request.headers.get('X-Test-Signature') !== 'valid') throw Object.assign(new Error('Invalid signature'), { status: 401 });
    return request.json();
  },
  lookupPayment: async (reference: string) => {
    const response = await fetch(`https://boundary.test/lookup/${reference}`);
    if (!response.ok) throw new Error('Lookup unavailable');
    return response.json();
  },
}));

// Risk limits are lifted for the general suite; dedicated tests restore the defaults.
// Provider credentials only mark payments/shipping as configured; the boundary doubles above answer every call.
const e = { ...env, PUBLIC_ORIGIN: 'https://shop.test', RAJAONGKIR_ORIGIN:'1', RAJAONGKIR_API_KEY: 'fixture', RAJAONGKIR_COURIERS: 'jne', DOKU_CLIENT_ID: 'fixture', DOKU_SECRET_KEY: 'fixture', RISK_HASH_SECRET: 'commerce-test-risk-secret-at-least-32-chars', MAX_PENDING_PER_IDENTITY: '1000', MAX_PENDING_PER_IP: '1000', VELOCITY_LIMIT: '1000', VELOCITY_LIMIT_IP: '1000', MEDIA_ORIGIN: 'https://media.test', ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env;
const db = () => e.DB;
const sql = (query: string, ...values: (string | number | null)[]) => db().prepare(query).bind(...values);
const count = async (table: string) => (await sql(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
async function request(path: string, payload?: unknown, headers: Record<string, string> = {}, method?: string) {
  return worker.fetch(new Request(`https://shop.test${path}`, { method: method ?? (payload ? 'POST' : 'GET'), headers: { Origin: e.PUBLIC_ORIGIN, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), e);
}
const cookie = (n: number) => `__Host-checkout_scope=${n.toString(16).padStart(64, '0')}`;
function payload(key = 'checkout-key', items = [{ variantId: 'a', quantity: 1 }]) {
  return { items, shippingQuoteId: items.length > 1 ? 'q2' : 'q1', expectedTotal: items.reduce((total, item) => total + item.quantity * 1000, 100), contact: { name: 'Customer', email: 'guest@example.com', phone: '0812345678' }, address: { line: 'Street 1', city: 'Jakarta', postalCode: '12345', destination: '42' }, idempotencyKey: key, turnstileToken: 'fresh-token' };
}
async function place(key = 'checkout-key', scope = 1, items?: { variantId: string; quantity: number }[]) {
  if (items) {
    const quoteId = items.length > 1 ? 'q2' : 'q1';
    const pairs = [...items].sort((a,b)=>a.variantId.localeCompare(b.variantId)).map(i=>[i.variantId,i.quantity]);
    const weight = items.reduce((sum,i)=>sum+i.quantity*100,0);
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({origin:'1',destination:'42',weight,items:pairs})));
    await sql('UPDATE shipping_quotes SET fingerprint=? WHERE id=?',btoa(String.fromCharCode(...new Uint8Array(bytes))),quoteId).run();
  }
  return request('/api/checkout', payload(key, items), { Cookie: cookie(scope) });
}
async function notify(reference: string, status = 'succeeded', eventKey = 'event-1', amount = 1100, currency = 'IDR', providerTx?: string) {
  return request('/api/payments/webhook', { reference, status, eventKey, amount, currency, ...(providerTx ? { providerTx } : {}) }, { 'X-Test-Signature': 'valid' });
}
const scheduled = () => worker.scheduled({} as ScheduledController, e);
// Moves an attempt's creation back so the Checkout due date (60 min) plus default grace (30 min) has passed.
const age = (orderId: string, minutes = 91) => sql('UPDATE payment_attempts SET created_at=?,next_check=0 WHERE order_id=?', Date.now() - minutes * 60_000, orderId).run();
function statements(source: string) {
  const queries: string[] = []; let current = '', trigger = false;
  for (const raw of source.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('--')) continue;
    if (line.startsWith('CREATE TRIGGER')) trigger = true;
    current += `${line}\n`;
    if (line.endsWith(';') && (!trigger || line === 'END;')) { queries.push(current); current = ''; trigger = false; }
  }
  if (current.trim()) throw new Error('Incomplete migration');
  return queries;
}

beforeAll(async () => {
  await applyD1Migrations(db(), [{ name: '0001_commerce.sql', queries: statements(migration) }, { name: '0004_manual_review.sql', queries: statements(reviewMigration) }]);
  await applyD1Migrations(db(), [{ name: '0005_customer_orders.sql', queries: statements(historyMigration) }]);
  await applyD1Migrations(db(), [{ name: '0006_admin_pages.sql', queries: statements(pagesMigration) }]);
  await applyD1Migrations(db(), [{ name: '0008_lifecycle.sql', queries: statements(lifecycleMigration) }]);
  await applyD1Migrations(db(), [{ name: '0010_risk.sql', queries: statements(riskMigration) }]);
  await applyD1Migrations(db(), [{ name: '0012_ecommerce.sql', queries: statements(ecommerceMigration) }]);
  await applyD1Migrations(db(), [{ name: '0014_reporting.sql', queries: statements(reportingMigration) }]);
  // Shipping-owned quote/destination contract. Real integration migrations are applied by the integration suite.
  await sql('CREATE TABLE IF NOT EXISTS shipping_quotes(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,destination TEXT NOT NULL,service TEXT NOT NULL,amount INTEGER NOT NULL,weight INTEGER NOT NULL,expires_at INTEGER NOT NULL,details_json TEXT NOT NULL)').run();
  await sql('CREATE TABLE IF NOT EXISTS shipping_destinations(id TEXT PRIMARY KEY,label TEXT NOT NULL,province TEXT NOT NULL,city TEXT NOT NULL,district TEXT NOT NULL,subdistrict TEXT NOT NULL,postal_code TEXT NOT NULL,updated_at INTEGER NOT NULL)').run();
});
beforeEach(async () => {
  provider.failCreate = false; provider.createStatus = 200; provider.lookupStatus = 200; provider.lookups = 0; provider.beforeResponse = null; provider.lookup = {status:'unknown'};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.origin !== 'https://boundary.test') throw new Error('Unexpected outbound request');
    if (url.pathname === '/turnstile') return new Response('{}', {status:await req.text() === 'invalid' ? 400 : 200});
    if (url.pathname === '/create') return Response.json({url:'https://pay.test/checkout',providerId:(await req.json() as any).reference}, {status:provider.failCreate ? 504 : provider.createStatus});
    if (url.pathname.startsWith('/lookup/')) { provider.lookups++; return Response.json(provider.lookup, {status:provider.lookupStatus}); }
    throw new Error('Unexpected provider route');
  });
  // Vitest 4 no longer rolls storage back between tests. Reset only the test database.
  await sql('DROP TRIGGER audit_logs_no_delete').run();
  for (const table of ['audit_logs','outbox_events','order_events','manual_review','payment_events','payment_attempts','inventory_movements','stock_reservations','order_items','checkout_requests','orders','preorder_campaigns','inventory','product_variants','products','categories','shipping_quotes','shipping_destinations','blocklist','rate_counters']) await sql(`DELETE FROM ${table}`).run();
  await sql(statements(riskMigration).find(q => q.startsWith('CREATE TRIGGER audit_logs_no_delete'))!).run();
  for (const path of ['/api/catalog','/api/catalog/product','/api/catalog/new-product','/api/catalog/preorder','/api/catalog?limit=1','/api/catalog?limit=2','/api/catalog?after=product&limit=1','/api/catalog?limit=1&after=product','/api/categories','/sitemap.xml']) await caches.default.delete(new Request(`https://shop.test${path}`));
  await db().batch([
    sql("INSERT INTO products(id,slug,name) VALUES('p','product','Product')"),
    sql("INSERT INTO product_variants(id,product_id,sku,name,price,weight) VALUES('a','p','SKU-A','A',1000,100),('b','p','SKU-B','B',1000,100)"),
    sql("INSERT INTO inventory(variant_id,on_hand) VALUES('a',1),('b',0)"),
    sql("INSERT INTO shipping_destinations VALUES('42','MENTENG, JAKARTA PUSAT, DKI JAKARTA, 10310','DKI JAKARTA','JAKARTA PUSAT','MENTENG','MENTENG','10310',0)"),
    sql("INSERT INTO shipping_quotes VALUES('q1','fingerprint','42','REG',100,100,?,'{}'),('q2','fingerprint','42','REG',100,200,?,'{}')", Date.now() + 300000, Date.now() + 300000),
  ]);
  for (const [id,weight,items] of [['q1',100,[['a',1]]],['q2',200,[['a',1],['b',1]]]] as const) {
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({origin:'1',destination:'42',weight,items})));
    await sql('UPDATE shipping_quotes SET fingerprint=? WHERE id=?',btoa(String.fromCharCode(...new Uint8Array(bytes))),id).run();
  }
});
afterEach(() => { vi.restoreAllMocks(); });

describe('commerce public API with real D1', () => {
  it('reviews evidence with immutable audited CAS and no financial side effects', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference,'succeeded','mismatch',1,'USD');
    const headers = { 'X-Test-Admin':'admin' };
    const { items } = await (await request('/api/admin/review',undefined,headers)).json() as any;
    expect(items[0]).toMatchObject({status:'open',version:0});
    const route = `/api/admin/review/${items[0].id}`;
    for (const path of ['/api/admin/review',route]) expect((await request(path)).status).toBe(403);
    expect((await request(route,{version:0,status:'resolved',note:'External refund'}, {},'PATCH')).status).toBe(403);
    expect((await request(route,{version:0,status:'resolved',note:'External refund'}, {...headers,Origin:'https://evil.test'},'PATCH')).status).toBe(403);
    const evidence = await (await request(route,undefined,headers)).json() as any;
    expect(evidence.order).toMatchObject({status:'pending_payment',total:1100});
    expect(evidence.triggeringEvent).toMatchObject({eventKey:'mismatch',amount:1,currency:'USD'});
    expect(evidence.attempt.url).toBeUndefined();
    expect(evidence.order.guestTokenHash).toBeUndefined();
    const tables = ['orders','payment_attempts','payment_events','inventory','stock_reservations','preorder_campaigns','outbox_events','inventory_movements','order_events'];
    const snapshot = () => Promise.all(tables.map(table => sql(`SELECT * FROM ${table} ORDER BY 1`).all()));
    const before = await snapshot();
    for (const note of ['', '   ']) expect((await request(route,{version:0,status:'resolved',note},headers,'PATCH')).status).toBe(400);
    const replies = await Promise.all([request(route,{version:0,status:'resolved',note:'Refund handled externally'},headers,'PATCH'),request(route,{version:0,status:'resolved',note:'Other stale resolution'},headers,'PATCH')]);
    expect(replies.map(r=>r.status).sort()).toEqual([200,409]);
    expect(await count('audit_logs')).toBe(1);
    expect((await request(route,{version:0,status:'resolved',note:'Retry'},headers,'PATCH')).status).toBe(409);
    expect((await request(route,{version:1,status:'open',note:'Reopen for follow-up'},headers,'PATCH')).status).toBe(200);
    expect((await request(route,{version:2,status:'open',note:'Contacted provider'},headers,'PATCH')).status).toBe(200);
    const final = await (await request(route,undefined,headers)).json() as any;
    expect(final.item).toMatchObject({status:'open',version:3,note:'Contacted provider',updatedBy:'admin'});
    expect(final.history).toHaveLength(3);
    await expect(sql("UPDATE audit_logs SET details_json='{}' WHERE action='review.update'").run()).rejects.toThrow('audit_log_immutable');
    await expect(sql("DELETE FROM audit_logs WHERE action='review.update'").run()).rejects.toThrow('audit_log_immutable');
    expect((await snapshot()).map(r=>r.results)).toEqual(before.map(r=>r.results));
    expect((await request('/api/admin/review/missing',undefined,headers)).status).toBe(404);
  });
  it('keeps triggering evidence beyond 100 newer events and exposes unmatched payment references', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference,'succeeded','old-mismatch',1,'USD');
    await notify('unmatched-invoice','succeeded','unknown-event',2300);
    await sql("UPDATE payment_events SET created_at=1 WHERE event_key='old-mismatch'").run();
    await db().batch(Array.from({length:101}, (_,i) => sql("INSERT INTO payment_events(event_key,reference,amount,currency,status,created_at) VALUES(?, ?,1100,'IDR','pending',?)", `new-${i}`,order.reference,i+2)));
    const headers = {'X-Test-Admin':'admin'};
    const { items } = await (await request('/api/admin/review',undefined,headers)).json() as any;
    const mismatch = items.find((item:any) => item.reason === 'payment_mismatch');
    const evidence = await (await request(`/api/admin/review/${mismatch.id}`,undefined,headers)).json() as any;
    expect(evidence.triggeringEvent).toMatchObject({eventKey:'old-mismatch',reference:order.reference,amount:1,currency:'USD'});
    expect(evidence.events).toHaveLength(100);
    expect(evidence.events[0].eventKey).toBe('new-100');
    expect(evidence.events.at(-1).eventKey).toBe('new-1');
    const unknown = items.find((item:any) => item.reason === 'unknown_reference');
    const unmatched = await (await request(`/api/admin/review/${unknown.id}`,undefined,headers)).json() as any;
    expect(unmatched.order).toBeNull();
    expect(unmatched.attempt).toBeNull();
    expect(unmatched.triggeringEvent).toMatchObject({eventKey:'unknown-event',reference:'unmatched-invoice',amount:2300,currency:'IDR'});
    expect(unmatched.events).toEqual([]);
  });
  it('paginates review cases past resolved cases without skipping equal timestamps', async () => {
    await db().batch(Array.from({length:52}, (_,i) => sql("INSERT INTO manual_review(id,reason,created_at,status) VALUES(?,'reconciliation_exhausted',10,?)", `case-${String(i).padStart(2,'0')}`,i < 2 ? 'open' : 'resolved')));
    const headers = {'X-Test-Admin':'admin'};
    const first = await (await request('/api/admin/review',undefined,headers)).json() as any;
    expect(first.items).toHaveLength(50);
    expect(first.items.every((item:any) => item.status === 'resolved')).toBe(true);
    const query = new URLSearchParams({before:String(first.nextCursor.before),beforeId:first.nextCursor.beforeId});
    const second = await (await request(`/api/admin/review?${query}`,undefined,headers)).json() as any;
    expect(second.items.map((item:any) => item.id)).toEqual(['case-01','case-00']);
    expect(second.items.every((item:any) => item.status === 'open')).toBe(true);
  });
  it('filters review cases by status on the server with the same keyset', async () => {
    await db().batch(Array.from({length:6}, (_,i) => sql("INSERT INTO manual_review(id,reason,created_at,status) VALUES(?,'reconciliation_exhausted',?,?)", `case-${i}`, i < 4 ? 10 : 20 + i, i % 2 ? 'resolved' : 'open')));
    const headers = {'X-Test-Admin':'ops'};
    const ids = async (query: string) => ((await (await request(`/api/admin/review?${query}`,undefined,headers)).json() as any).items as any[]).map(item => item.id);
    expect(await ids('status=open')).toEqual(['case-4','case-2','case-0']);
    expect(await ids('status=resolved')).toEqual(['case-5','case-3','case-1']);
    expect(await ids('')).toEqual(['case-5','case-4','case-3','case-2','case-1','case-0']);
    const first = await (await request('/api/admin/review?status=open&limit=2',undefined,headers)).json() as any;
    expect(first.items.map((item:any) => item.id)).toEqual(['case-4','case-2']);
    expect(await ids(`status=open&limit=2&before=${first.nextCursor.before}&beforeId=${first.nextCursor.beforeId}`)).toEqual(['case-0']);
    expect((await request('/api/admin/review?status=closed',undefined,headers)).status).toBe(400);
  });
  it('supports late-payment and reconciliation cases without events or reviving cancelled orders', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference,'expired','expiry');
    await notify(order.reference,'succeeded','late');
    const headers = { 'X-Test-Admin':'admin' };
    const { items } = await (await request('/api/admin/review',undefined,headers)).json() as any;
    expect(items[0].reason).toBe('late_payment');
    expect((await request(`/api/admin/review/${items[0].id}`,{version:0,status:'resolved',note:'Handled outside commerce'},headers,'PATCH')).status).toBe(200);
    expect(await sql('SELECT status FROM orders WHERE id=?',order.id).first('status')).toBe('cancelled');
    expect(await count('outbox_events')).toBe(0);
    expect(await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first()).toEqual({on_hand:1,reserved:0});
    const placed = await place('second-checkout',2);
    expect(placed.status).toBe(200);
    const second = await placed.json() as any;
    await sql('UPDATE payment_attempts SET checks=8,next_check=0 WHERE order_id=?',second.order.id).run();
    await worker.scheduled({} as ScheduledController,e);
    const list = await (await request('/api/admin/review',undefined,headers)).json() as any;
    const recovery = list.items.find((item:any)=>item.reason==='reconciliation_exhausted');
    const evidence = await (await request(`/api/admin/review/${recovery.id}`,undefined,headers)).json() as any;
    expect(evidence.triggeringEvent).toBeNull();
    expect(evidence.events).toEqual([]);
    expect((await request(`/api/admin/review/${recovery.id}`,{version:0,status:'resolved',note:'Provider investigation handled externally'},headers,'PATCH')).status).toBe(200);
    expect(await sql('SELECT status FROM orders WHERE id=?',second.order.id).first('status')).toBe('pending_payment');
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first('reserved')).toBe(1);
  });
  it('lists only customer-owned summaries with deterministic private pagination', async () => {
    for (const [id, customer, created] of [['a','owner',10],['b','owner',10],['c','owner',9],['d','other',11],['e',null,12]] as const) {
      await sql("INSERT INTO orders(id,reference,customer_id,guest_token_hash,total,contact_json,address_json,shipping_json,created_at) VALUES(?,?,?,?,1000,?,?,?,?)", id, `ref-${id}`, customer, 'private-hash', '{"email":"same@example.com"}', '{"line":"private"}', '{}', created).run();
    }
    expect((await request('/api/orders')).status).toBe(401);
    expect((await request('/api/orders', undefined, {'X-Order-Token':'private-hash'})).status).toBe(401);
    const headers = {'X-Test-Customer':'owner'};
    const first = await request('/api/orders?limit=1', undefined, headers);
    expect(first.headers.get('Cache-Control')).toBe('private, no-store');
    const page = await first.json() as any;
    expect(page.ownerId).toBe('owner');
    expect(page.orders).toEqual([{reference:'ref-b',status:'pending_payment',fulfillment:'unfulfilled',total:1000,currency:'IDR',createdAt:10}]);
    const next = await (await request(`/api/orders?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`, undefined, headers)).json() as any;
    expect(next.orders[0].reference).toBe('ref-a');
    // A new order ahead of the cursor must not duplicate or shift older pages.
    await sql("INSERT INTO orders(id,reference,customer_id,total,contact_json,address_json,shipping_json,created_at) VALUES('new','ref-new','owner',1000,'{}','{}','{}',20)").run();
    const last = await (await request(`/api/orders?limit=1&cursor=${encodeURIComponent(next.nextCursor)}`, undefined, headers)).json() as any;
    expect(last.orders[0].reference).toBe('ref-c'); expect(last.nextCursor).toBeNull();
    const other = await (await request(`/api/orders?cursor=${encodeURIComponent(page.nextCursor)}`, undefined, {'X-Test-Customer':'other'})).json() as any;
    expect(other.ownerId).toBe('other');
    expect(other.orders).toEqual([]);
    expect(await (await request('/api/orders', undefined, {'X-Test-Customer':'empty'})).json()).toEqual({ownerId:'empty',orders:[],nextCursor:null});
    for (const query of ['limit=0','limit=51','limit=1.5','cursor=bad','cursor='+encodeURIComponent(btoa('[10]')),'cursor='+encodeURIComponent(btoa('[10,{}]'))]) {
      expect((await request('/api/orders?'+query, undefined, headers)).status).toBe(400);
    }
  });
  it('accepts canonical dev portal mutations without relaxing production or admin checks', async () => {
    const payload = {slug:'dev-portal',name:'Dev portal',variants:[{sku:'PORTAL',name:'Default',price:157000,weight:275,stock:4}]};
    const proxied = (origin = 'http://shop.test', admin = 'admin') => new Request('http://shop.test/api/admin/products', {method:'POST',headers:{Origin:origin,'Content-Type':'application/json','X-Test-Admin':admin},body:JSON.stringify(payload)});
    expect((await worker.fetch(proxied(),e)).status).toBe(403);
    // An HTTPS non-local origin also needs the explicit remote dev-portal opt-in.
    expect((await worker.fetch(proxied(),{...e,APP_ENV:'development',DEV_LOGIN_ENABLED:'true'})).status).toBe(403);
    const dev = {...e,APP_ENV:'development',DEV_LOGIN_ENABLED:'true',DEV_LOGIN_ALLOW_REMOTE:'true'};
    expect((await worker.fetch(proxied('http://evil.test'),dev)).status).toBe(403);
    expect((await worker.fetch(proxied('http://shop.test','unauthorized'),dev)).status).toBe(403);
    const response = await worker.fetch(proxied(),dev);
    expect(response.status).toBe(201);
    const created = await response.json() as any;
    expect(created.product.variants[0]).toMatchObject({sku:'PORTAL',price:157000,weight:275});
    expect(await sql('SELECT on_hand FROM inventory WHERE variant_id=?',created.product.variants[0].id).first('on_hand')).toBe(4);
  });
  it('returns authoritative public catalog and keeps personal order data private', async () => {
    const catalog = await request('/api/catalog');
    expect(catalog.headers.get('cache-control')).toContain('s-maxage=60');
    const publicVariant = (await catalog.json() as any).products[0].variants[0];
    expect(publicVariant.stockLevel).toBe('low'); expect(publicVariant.available).toBeUndefined();
    const placed = await place(); expect(placed.status).toBe(200);
    const { order } = await placed.json() as any;
    expect((await request(`/api/orders/${order.reference}`)).status).toBe(404);
    expect((await request(`/api/orders/${order.reference}`, undefined, { 'X-Order-Token': 'wrong' })).status).toBe(404);
    const read = await request(`/api/orders/${order.reference}`, undefined, { 'X-Order-Token': order.guestToken });
    expect(read.status).toBe(200); expect(read.headers.get('cache-control')).toBe('private, no-store');
    const result = await read.json() as any;
    expect(result.order.items[0].sku).toBe('SKU-A');
    expect(result.access).toEqual({type:'guest'});
  });

  it('establishes random scope before checkout; concurrent no-cookie keys disclose no order', async () => {
    const [a, b] = await Promise.all([request('/api/checkout', payload()), request('/api/checkout', payload())]);
    expect(a.status).toBe(428); expect(b.status).toBe(428);
    expect(a.headers.get('set-cookie')).not.toBe(b.headers.get('set-cookie'));
    expect(a.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Lax');
    expect(await count('orders')).toBe(0);
  });

  it('resolves same-scope simultaneous retries once and returns the same guest token with a new Turnstile token', async () => {
    const [a, b] = await Promise.all([place(), place()]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    const aa = await a.json() as any, bb = await b.json() as any;
    expect(aa.order.id).toBe(bb.order.id); expect(aa.order.guestToken).toBe(bb.order.guestToken);
    const retry = await request('/api/checkout', { ...payload(), turnstileToken: 'new-token' }, { Cookie: cookie(1) });
    expect((await retry.json() as any).order.guestToken).toBe(aa.order.guestToken);
    expect(await count('orders')).toBe(1); expect(await count('payment_attempts')).toBe(1);
    const conflict = await request('/api/checkout', { ...payload(), expectedTotal: 1200 }, { Cookie: cookie(1) });
    expect(conflict.status).toBe(409);
  });

  it('two guest scopes racing for the final unit cannot oversell or access the other result', async () => {
    const results = await Promise.all([place('same-key', 1), place('same-key', 2)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await count('orders')).toBe(1);
    expect(await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ on_hand: 1, reserved: 1 });
  });

  it('rolls back all items, order and payment attempt when the second reservation fails', async () => {
    const result = await place('multi-item', 1, [{ variantId: 'a', quantity: 1 }, { variantId: 'b', quantity: 1 }]);
    expect(result.status).toBe(409);
    expect(await count('orders')).toBe(0); expect(await count('order_items')).toBe(0); expect(await count('payment_attempts')).toBe(0);
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ reserved: 0 });
  });

  it('finite preorder quotas race safely without touching physical stock and reject campaign overlap', async () => {
    await db().batch([
      sql("UPDATE product_variants SET mode='preorder' WHERE id='a'"),
      sql("INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota) VALUES('c','a',?,?,'2026-12-01','2026-12-15',1)", Date.now() - 1000, Date.now() + 300000),
    ]);
    const results = await Promise.all([place('preorder-key', 1), place('preorder-key', 2)]);
    expect(results.map(r => r.status).sort()).toEqual([200, 409]);
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ reserved: 0 });
    const winner = await results.find(r => r.status === 200)!.json() as any;
    await notify(winner.order.reference);
    expect(await sql("SELECT reserved,sold FROM preorder_campaigns WHERE id='c'").first()).toEqual({ reserved: 0, sold: 1 });
    await expect(sql("INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota) VALUES('overlap','a',?,?,'2026-12-01','2026-12-15',1)", Date.now(), Date.now() + 300000).run()).rejects.toThrow('campaign_overlap');
  });

  it('duplicate success and older expiry consume inventory and create outbox exactly once', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference, 'ignored', 'method-failed');
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first()).toEqual({status:'pending_payment'});
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({reserved:1});
    const replies = await Promise.all([notify(order.reference,'succeeded','event-1',1100,'IDR','VA_BCA@1'), notify(order.reference,'succeeded','event-1',1100,'IDR','VA_BCA@1')]);
    expect(replies.every(r => r.status === 200)).toBe(true);
    await notify(order.reference, 'expired', 'older-expiry');
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first()).toEqual({ status: 'paid' });
    expect(await sql('SELECT status FROM payment_attempts WHERE order_id=?', order.id).first()).toEqual({ status: 'succeeded' });
    expect(await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ on_hand: 0, reserved: 0 });
    expect(await count('outbox_events')).toBe(1); expect(await count('inventory_movements')).toBe(1);
    await notify(order.reference, 'succeeded', 'another-confirmation', 1100, 'IDR', 'QRIS@2');
    expect(await sql('SELECT reason FROM manual_review').first()).toEqual({reason:'additional_payment_confirmation'});
    expect(await count('inventory_movements')).toBe(1);
    await worker.scheduled({} as ScheduledController, e);
    await worker.scheduled({} as ScheduledController, e);
    expect(await sql('SELECT status FROM outbox_events').first()).toEqual({ status: 'done' });
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='payment_recorded'").first()).toEqual({ n: 1 });
  });

  it('verified authoritative expiry releases inventory; late success records review rather than fulfilling', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference, 'expired', 'expiry');
    await notify(order.reference, 'succeeded', 'late');
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first()).toEqual({ status: 'cancelled' });
    expect(await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ on_hand: 1, reserved: 0 });
    expect(await sql('SELECT reason FROM manual_review').first()).toEqual({ reason: 'late_payment' });
    expect(await count('outbox_events')).toBe(0);
  });

  it('expiry racing success always yields a single consistent terminal outcome', async () => {
    const { order } = await (await place()).json() as any;
    await Promise.all([notify(order.reference, 'expired', 'expiry'), notify(order.reference, 'succeeded', 'success')]);
    const state = await sql('SELECT status FROM orders WHERE id=?', order.id).first<{ status: string }>();
    const stock = await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first();
    expect(stock).toEqual({ on_hand: state!.status === 'paid' ? 0 : 1, reserved: 0 });
    expect(await count('outbox_events')).toBe(state!.status === 'paid' ? 1 : 0);
  });

  it('signature failure and currency/amount mismatch do not mark paid', async () => {
    const { order } = await (await place()).json() as any;
    expect((await request('/api/payments/webhook', { reference: order.reference })).status).toBe(401);
    await notify(order.reference, 'succeeded', 'mismatch', 1, 'USD');
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first()).toEqual({ status: 'pending_payment' });
    expect(await sql('SELECT reason FROM manual_review').first()).toEqual({ reason: 'payment_mismatch' });
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ reserved: 1 });
  });

  it('rejects browser totals, changed destination, changed weight and expired quotes', async () => {
    for (const changed of [{ ...payload(), expectedTotal: 1 }, { ...payload(), address: { ...payload().address, destination: '99' } }, { ...payload(), items: [{ variantId: 'a', quantity: 2 }] }]) {
      expect((await request('/api/checkout', changed, { Cookie: cookie(1) })).status).toBe(409);
    }
    await sql('UPDATE shipping_quotes SET expires_at=0').run();
    expect((await place()).status).toBe(409); expect(await count('orders')).toBe(0);
  });

  it('unknown provider creation remains reserved and retries never blindly recreate', async () => {
    provider.failCreate = true;
    const created = await (await place()).json() as any;
    expect(created.paymentState).toBe('unknown');
    const retried = await (await place()).json() as any;
    expect(retried.order.id).toBe(created.order.id); expect(retried.paymentState).toBe('unknown');
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ reserved: 1 });
    expect(await count('payment_attempts')).toBe(1);
  });

  it('persists attempt before provider call and does not downgrade an early webhook success', async () => {
    provider.beforeResponse = async ({ reference }) => {
      expect(reference.length).toBeLessThanOrEqual(30);
      expect(await sql('SELECT status FROM payment_attempts WHERE reference=?', reference).first()).toEqual({ status: 'created' });
      expect((await notify(reference)).status).toBe(200);
    };
    const created = await (await place()).json() as any;
    expect(created.order.status).toBe('paid'); expect(created.paymentState).toBe('succeeded');
    expect(created.paymentUrl).toBeUndefined();
    expect(await count('inventory_movements')).toBe(1);
  });

  it('pending lookup does not release from clock; authoritative expiry can release and exhaustion is durable review', async () => {
    const { order } = await (await place()).json() as any;
    await sql('UPDATE payment_attempts SET next_check=0').run();
    provider.lookup = {status:'unknown'};
    await worker.scheduled({} as ScheduledController, e);
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ reserved: 1 });
    await sql('UPDATE payment_attempts SET checks=8,next_check=0').run();
    await worker.scheduled({} as ScheduledController, e);
    expect(await sql('SELECT reason FROM manual_review').first()).toEqual({ reason: 'reconciliation_exhausted' });
    // Operators may reconcile again only through an authoritative provider result, never a blind create.
    await sql('UPDATE payment_attempts SET checks=0').run();
    await age(order.id);
    provider.lookup = {status:'not_paid',amount:1100,currency:'IDR'};
    await worker.scheduled({} as ScheduledController, e);
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first()).toEqual({ status: 'cancelled' });
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ reserved: 0 });
  });

  it('queue failure and duplicate/redelivered jobs recover internal effects without repeating stock consumption', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference);
    const send = vi.fn().mockRejectedValue(new Error('Queue unavailable'));
    await worker.scheduled({} as ScheduledController, { ...e, JOBS: { send } as unknown as Queue });
    const outbox = await sql('SELECT id,status,attempts FROM outbox_events').first<{ id: string; status: string; attempts: number }>();
    expect(outbox!.status).toBe('pending'); expect(outbox!.attempts).toBe(1);
    const ack = vi.fn(), retry = vi.fn();
    const message = { body: { outboxId: outbox!.id }, ack, retry };
    const batch = { messages: [message, message] } as unknown as MessageBatch<{ outboxId: string }>;
    await worker.queue(batch, e); await worker.queue(batch, e);
    expect(ack).toHaveBeenCalledTimes(4); expect(retry).not.toHaveBeenCalled();
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='payment_recorded'").first()).toEqual({ n: 1 });
    expect(await count('inventory_movements')).toBe(1);
  });

  it('rejects invalid Turnstile and cross-origin requests before any reservation', async () => {
    expect((await request('/api/checkout', { ...payload(), turnstileToken: 'invalid' }, { Cookie: cookie(1) })).status).toBe(400);
    expect((await request('/api/checkout', payload(), { Cookie: cookie(1), Origin: 'https://attacker.test' })).status).toBe(403);
    expect(await count('orders')).toBe(0);
  });

  it('verified customer ownership is independent of contact email and guest scope', async () => {
    const response = await request('/api/checkout', payload(), { 'X-Test-Customer': 'owner' });
    expect(response.status).toBe(200);
    const { order } = await response.json() as any;
    expect(order.guestToken).toBeUndefined();
    const read = await request(`/api/orders/${order.reference}`, undefined, { 'X-Test-Customer': 'owner', 'X-Order-Token': 'wrong-token' });
    expect(read.status).toBe(200);
    expect((await read.json() as any).access).toEqual({type:'account',ownerId:'owner'});
    expect((await request(`/api/orders/${order.reference}`, undefined, { 'X-Test-Customer': 'other' })).status).toBe(404);
    expect((await request(`/api/orders/${order.reference}`)).status).toBe(404);
  });

  it('creates products, adjusts stock with ledger, prevents removing held stock and creates explicit unlimited campaigns', async () => {
    const headers = { 'X-Test-Admin': 'admin' };
    const result = await request('/api/admin/products', { slug: 'new-product', name: 'New product', variants: [{ sku: 'SKU-NEW', name: 'Default', price: 2000, weight: 200, mode: 'preorder' }] }, headers);
    expect(result.status).toBe(201);
    const { product } = await result.json() as any;
    const campaign = await request('/api/admin/campaigns', { variantId: product.variants[0].id, startsAt: Date.now() - 1000, endsAt: Date.now() + 300000, shipFrom: '2026-12-01', shipTo: '2026-12-15', quota: null }, headers);
    expect(campaign.status).toBe(201);
    const catalog = await request('/api/catalog/new-product');
    const preorder = (await catalog.json() as any).product.variants[0];
    expect(preorder.stockLevel).toBe('in_stock'); expect(preorder.campaign.available).toBeUndefined(); expect(preorder.campaign.quota).toBeUndefined();
    expect((await request('/api/admin/inventory', { variantId: 'b', delta: 2, reason: 'receipt', key: crypto.randomUUID() }, headers)).status).toBe(200);
    const { order } = await (await place()).json() as any;
    expect((await request('/api/admin/inventory', { variantId: 'a', delta: -1, reason: 'shrinkage', key: crypto.randomUUID() }, headers)).status).toBe(409);
    expect(await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ on_hand: 1, reserved: 1 });
    await expect(sql('UPDATE orders SET total=0 WHERE id=?', order.id).run()).rejects.toThrow('commercial_snapshot_immutable');
  });

  it('cache keys preserve pagination, ignore tracking and never make stale catalog authoritative', async () => {
    await request('/api/admin/products', { slug: 'z-last', name: 'Last', variants: [{ sku: 'SKU-LAST', name: 'Default', price: 1000, weight: 100 }] }, { 'X-Test-Admin': 'admin' });
    const first = await (await request('/api/catalog?limit=1')).json() as any;
    expect(first.products[0].slug).toBe('product'); expect(first.nextCursor).toBe('product');
    await sql("UPDATE products SET active=0 WHERE id='p'").run();
    const cached = await (await request('/api/catalog?limit=1&utm_source=tracking', undefined, { Cookie: cookie(8) })).json() as any;
    expect(cached).toEqual(first);
    const next = await (await request('/api/catalog?limit=1&after=product')).json() as any;
    expect(next.products[0].slug).toBe('z-last'); expect(next.nextCursor).toBeNull();
    expect((await place()).status).toBe(409); expect(await count('orders')).toBe(0);
  });

  it('numbers catalog pages with a total, keys the cache by page and keeps the slug cursor for old links', async () => {
    for (const slug of ['b-two', 'c-three']) await request('/api/admin/products', { slug, name: slug, variants: [{ sku: `SKU-${slug}`, name: 'Default', price: 1000, weight: 100 }] }, { 'X-Test-Admin': 'admin' });
    const slugs = (body: any) => body.products.map((p: any) => p.slug);
    const first = await (await request('/api/catalog?limit=2')).json() as any;
    expect(slugs(first)).toEqual(['b-two', 'c-three']); expect(first).toMatchObject({ page: 1, total: 3 });
    const second = await (await request('/api/catalog?limit=2&page=2')).json() as any;
    expect(slugs(second)).toEqual(['product']); expect(second).toMatchObject({ page: 2, total: 3, nextCursor: null });
    expect(await (await request('/api/catalog?limit=2&page=9')).json()).toMatchObject({ products: [], total: 3 });
    for (const query of ['page=0', 'page=abc', 'page=1001', 'page=1e2']) expect((await request(`/api/catalog?${query}`)).status).toBe(400);
    expect(publicCacheKey(new URL('https://shop.test/catalog?page=1&limit=10'), catalogParams)!.url).toBe('https://shop.test/catalog?limit=10');
    expect(publicCacheKey(new URL('https://shop.test/catalog?page=02'), catalogParams)!.url).toBe('https://shop.test/catalog?page=2');
    const old = await (await request('/api/catalog?limit=1&after=b-two')).json() as any;
    expect(slugs(old)).toEqual(['c-three']); expect(old).not.toHaveProperty('total');
  });

  it('mixed stock and unlimited PO use one shipping promise snapshot unaffected by later campaign changes', async () => {
    const headers = { 'X-Test-Admin': 'admin' };
    const { product } = await (await request('/api/admin/products', { slug: 'preorder', name: 'PO', variants: [{ sku: 'SKU-PO', name: 'Default', price: 1000, weight: 100, mode: 'preorder' }] }, headers)).json() as any;
    const variantId = product.variants[0].id;
    const { campaign } = await (await request('/api/admin/campaigns', { variantId, startsAt: Date.now() - 1000, endsAt: Date.now() + 300000, shipFrom: '2026-12-01', shipTo: '2026-12-15', quota: null }, headers)).json() as any;
    const placed = await place('mixed-cart', 1, [{ variantId: 'a', quantity: 1 }, { variantId, quantity: 1 }]);
    expect(placed.status).toBe(200);
    const { order } = await placed.json() as any;
    await sql("UPDATE preorder_campaigns SET ship_to='2027-01-01' WHERE id=?", campaign.id).run();
    const history = await (await request(`/api/orders/${order.reference}`, undefined, { 'X-Order-Token': order.guestToken })).json() as any;
    expect(history.order.shipping.policy).toBe('single-shipment-latest-item');
    expect(history.order.shipping.shipTo).toBe('2026-12-15');
    expect(history.order.items.find((i: any) => i.variantId === variantId).campaign.shipTo).toBe('2026-12-15');
    expect(await sql('SELECT on_hand,reserved FROM inventory WHERE variant_id=?', variantId).first()).toEqual({ on_hand: 0, reserved: 0 });
  });

  it('admin mutations require authorization and enforce fulfillment progression with audit', async () => {
    expect((await request('/api/admin/inventory', { variantId: 'a', delta: 1, reason: 'restock', key: crypto.randomUUID() })).status).toBe(403);
    const { order } = await (await place()).json() as any;
    const route = `/api/admin/orders/${order.id}/fulfillment`, headers = { 'X-Test-Admin': 'admin' };
    expect((await request(route, { status: 'processing' }, headers, 'PATCH')).status).toBe(409);
    await notify(order.reference);
    expect((await request(`/api/admin/orders/${order.id}/timeline`,{kind:'production',note:'Production started',estimatedDate:'2026-11-06'},headers)).status).toBe(200);
    expect((await request(route, { status: 'shipped', tracking: 'TRACK' }, headers, 'PATCH')).status).toBe(409);
    for (const status of ['processing', 'shipped', 'delivered']) expect((await request(route, { status, tracking: 'TRACK' }, headers, 'PATCH')).status).toBe(200);
    expect(await sql('SELECT status,fulfillment FROM orders WHERE id=?', order.id).first()).toEqual({ status: 'completed', fulfillment: 'delivered' });
    expect(await count('audit_logs')).toBe(4);
    expect((await request('/api/admin/orders', undefined, headers)).headers.get('cache-control')).toBe('private, no-store');
    expect((await request('/api/admin/products/p',{active:false,version:0},headers,'PATCH')).status).toBe(200);
    expect((await request('/api/admin/variants/a',{price:9000,version:0},headers,'PATCH')).status).toBe(200);
    const fresh = await (await request('/api/admin/products',undefined,headers)).json() as any;
    expect(fresh.products[0].active).toBe(false);
    const single = await request('/api/admin/products/p',undefined,headers);
    expect(single.headers.get('cache-control')).toBe('private, no-store');
    const { product: archived } = await single.json() as any;
    expect(archived).toMatchObject({ id: 'p', active: false, version: 1 });
    expect(archived.variants.find((v: any) => v.id === 'a')).toMatchObject({ price: 9000, version: 1 });
    expect((await request('/api/admin/products/missing',undefined,headers)).status).toBe(404);
    expect((await request('/api/catalog/product')).status).toBe(404);
    const history = await (await request(`/api/orders/${order.reference}`,undefined,{'X-Order-Token':order.guestToken})).json() as any;
    expect(history.order.items[0].price).toBe(1000);
    expect(history.order.timeline.find((e:any)=>e.kind==='production').details).toEqual({note:'Production started',estimatedDate:'2026-11-06'});
  });
});

describe('local baseline admin contracts',()=>{
  const headers={'X-Test-Admin':'admin'};
  const variant={sku:'NEW',name:'New',price:2000,weight:100,stock:3};
  it('creates variants atomically, rejects duplicate SKU and concurrent cap overflow',async()=>{
    expect((await request('/api/admin/products/missing/variants',variant,headers)).status).toBe(404);
    const created=await (await request('/api/admin/products/p/variants',variant,headers)).json() as any;
    const {stock:_stock,...fields}=variant;
    expect(created.variant).toMatchObject({...fields,mode:'stock',productId:'p',onHand:3,reserved:0,version:0,active:true});
    const ledger=await (await request(`/api/admin/inventory?variantId=${created.variant.id}`,undefined,headers)).json() as any;
    expect(ledger.inventory).toEqual({variantId:created.variant.id,onHand:3,reserved:0,available:3,awaitingShipment:0});
    expect(ledger.movements[0]).toMatchObject({delta:3,reason:'initial stock',actor:'admin',orderId:null});
    expect(ledger.nextCursor).toBeNull();
    const counts=await Promise.all(['product_variants','inventory','inventory_movements','audit_logs'].map(count));
    expect((await request('/api/admin/products/p/variants',variant,headers)).status).toBe(409);
    expect(await Promise.all(['product_variants','inventory','inventory_movements','audit_logs'].map(count))).toEqual(counts);
    for(let i=0;i<26;i++) await sql('INSERT INTO product_variants(id,product_id,sku,name,price,weight) VALUES(?,?,?,?,?,?)',`v${i}`,'p',`S${i}`,'Extra',1,1).run();
    const responses=await Promise.all(['one','two'].map(sku=>request('/api/admin/products/p/variants',{...variant,sku},headers)));
    expect(responses.map(r=>r.status).sort()).toEqual([201,409]);
    expect(await count('product_variants')).toBe(30);
    expect(await count('audit_logs')).toBe(2);
    const admin=await (await request('/api/admin/products',undefined,headers)).json() as any;
    expect(admin.products[0].variants.find((v:any)=>v.id==='a')).toMatchObject({onHand:1,reserved:0});
    const publicCatalog=await (await request('/api/catalog')).json() as any;
    expect(publicCatalog.products[0].variants[0]).not.toHaveProperty('onHand');
  });
  it('paginates asymmetric timestamp ties without omissions or terminal cursors',async()=>{
    for(const [id,time] of [['z',10],['b',10],['a',10],['y',9]] as const) await sql('INSERT INTO inventory_movements(id,variant_id,delta,reason,created_at) VALUES(?,?,?,?,?)',id,'a',1,'adjustment',time).run();
    const first=await (await request('/api/admin/inventory?variantId=a&limit=2',undefined,headers)).json() as any;
    expect(first.movements.map((m:any)=>m.id)).toEqual(['z','b']);
    expect(first.nextCursor).toEqual({before:10,beforeId:'b'});
    const last=await (await request('/api/admin/inventory?variantId=a&limit=2&before=10&beforeId=b',undefined,headers)).json() as any;
    expect(last.movements.map((m:any)=>m.id)).toEqual(['a','y']);
    expect(last.nextCursor).toBeNull();
    expect((await request('/api/admin/inventory?variantId=missing',undefined,headers)).status).toBe(404);
  });
  const adjust=(input:Record<string,unknown>)=>request('/api/admin/inventory',{reason:'Stok opname',key:crypto.randomUUID(),variantId:'a',...input},headers);
  const stockOf=(variant='a')=>sql('SELECT on_hand AS onHand,reserved FROM inventory WHERE variant_id=?',variant).first();
  const ship=async(orderId:string)=>{for(const status of ['processing','shipped']) expect((await request(`/api/admin/orders/${orderId}/fulfillment`,{status,tracking:'RESI'},headers,'PATCH')).status).toBe(200);};
  it('counts paid but unshipped units as shelf stock so an opname never inflates on_hand',async()=>{
    await sql("UPDATE inventory SET on_hand=10 WHERE variant_id='a'").run();
    const {order}=await (await place()).json() as any;
    await notify(order.reference);
    // 9 recorded, 1 paid and still on the shelf waiting to be packed: the shelf really holds 10.
    const view=await (await request('/api/admin/inventory?variantId=a',undefined,headers)).json() as any;
    expect(view.inventory).toEqual({variantId:'a',onHand:9,reserved:0,available:9,awaitingShipment:1});
    const counted=await adjust({counted:12});
    expect(counted.status).toBe(200);
    expect((await counted.json() as any).inventory).toEqual({variantId:'a',onHand:11,reserved:0,awaitingShipment:1});
    const ledger=await (await request('/api/admin/inventory?variantId=a&limit=1',undefined,headers)).json() as any;
    expect(ledger.movements[0]).toMatchObject({delta:2,reason:'Stok opname',actor:'admin'});
    const details=JSON.parse((await sql("SELECT details_json FROM audit_logs WHERE action='inventory.adjust'").first<string>('details_json'))!);
    expect(details).toMatchObject({variantId:'a',delta:2,counted:12,awaitingShipment:1});
    // A count with no difference is still recorded; a zero add/remove is not a change.
    expect((await adjust({counted:12})).status).toBe(200);
    expect(await stockOf()).toEqual({onHand:11,reserved:0});
    expect(await sql("SELECT count(*) AS n FROM inventory_movements WHERE variant_id='a'").first('n')).toBe(3);
    for (const input of [{delta:0},{delta:1,counted:1},{},{delta:1,key:'not-a-uuid'}]) expect((await adjust(input)).status).toBe(400);
    await ship(order.id);
    expect((await (await request('/api/admin/inventory?variantId=a',undefined,headers)).json() as any).inventory.awaitingShipment).toBe(0);
  });
  it('computes an opname delta from live stock, so a sale after the dialog opened is not lost',async()=>{
    await sql("UPDATE inventory SET on_hand=10 WHERE variant_id='a'").run();
    expect((await (await request('/api/admin/inventory?variantId=a&limit=1',undefined,headers)).json() as any).inventory.onHand).toBe(10);
    const {order}=await (await place()).json() as any;
    await notify(order.reference); await ship(order.id);
    // The shelf now holds 9; staff count 8. The old client delta (8-10) would have recorded 7.
    expect((await adjust({counted:8})).status).toBe(200);
    expect(await stockOf()).toEqual({onHand:8,reserved:0});
    // A count below what is reserved or awaiting shipment aborts the whole batch with the current numbers.
    await place('held-order');
    const refused=await adjust({counted:0});
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({error:'Stok di bawah jumlah yang dipesan atau menunggu kirim',details:{inventory:{onHand:8,reserved:1,awaitingShipment:0}}});
    expect(await stockOf()).toEqual({onHand:8,reserved:1});
    expect(await sql("SELECT count(*) AS n FROM audit_logs WHERE action='inventory.adjust'").first('n')).toBe(1);
  });
  it('applies an adjustment key once and refuses the same key on another variant',async()=>{
    const key=crypto.randomUUID();
    expect((await (await adjust({variantId:'b',delta:5,key})).json() as any)).toEqual({inventory:{variantId:'b',onHand:5,reserved:0,awaitingShipment:0}});
    const replay=await (await adjust({variantId:'b',delta:5,key})).json() as any;
    expect(replay).toEqual({inventory:{variantId:'b',onHand:5,reserved:0,awaitingShipment:0},replayed:true});
    const racing=crypto.randomUUID();
    const both=await Promise.all([adjust({variantId:'b',delta:2,key:racing}),adjust({variantId:'b',delta:2,key:racing})]);
    expect(both.map(r=>r.status)).toEqual([200,200]);
    expect(await stockOf('b')).toEqual({onHand:7,reserved:0});
    const elsewhere=await adjust({variantId:'a',delta:5,key});
    expect(elsewhere.status).toBe(409);
    expect(await stockOf('a')).toEqual({onHand:1,reserved:0});
    expect(await sql("SELECT count(*) AS n FROM inventory_movements WHERE variant_id='b'").first('n')).toBe(2);
    expect(await sql("SELECT count(*) AS n FROM audit_logs WHERE action='inventory.adjust'").first('n')).toBe(2);
    expect((await adjust({variantId:'missing',delta:1})).status).toBe(404);
  });
  it('keeps stock off pre-order variants and writes no empty initial-stock rows',async()=>{
    const preorder={sku:'PO-1',name:'PO',price:1000,weight:100,mode:'preorder'};
    expect((await request('/api/admin/products',{slug:'po',name:'PO',variants:[{...preorder,stock:5}]},headers)).status).toBe(400);
    expect((await request('/api/admin/products/p/variants',{...preorder,stock:2},headers)).status).toBe(400);
    const {variant}=await (await request('/api/admin/products/p/variants',preorder,headers)).json() as any;
    expect(await sql('SELECT count(*) AS n FROM inventory_movements WHERE variant_id=?',variant.id).first('n')).toBe(0);
    const refused=await adjust({variantId:variant.id,delta:3});
    expect(refused.status).toBe(409);
    expect((await refused.json() as any).error).toBe('Varian pre-order tidak memakai stok');
    expect((await adjust({variantId:variant.id,counted:3})).status).toBe(409);
    expect(await stockOf(variant.id)).toEqual({onHand:0,reserved:0});
    const {variant:empty}=await (await request('/api/admin/products/p/variants',{...preorder,sku:'S-0',mode:'stock',stock:0},headers)).json() as any;
    expect(await sql('SELECT count(*) AS n FROM inventory_movements WHERE variant_id=?',empty.id).first('n')).toBe(0);
  });
  it('sums awaiting shipment from in-flight paid orders, not from every order item',async()=>{
    const {results}=await sql(`EXPLAIN QUERY PLAN SELECT (SELECT coalesce(sum(i.quantity),0) FROM orders o CROSS JOIN order_items i ON i.order_id=o.id
      WHERE o.status='paid' AND o.fulfillment IN ('unfulfilled','processing') AND i.variant_id=inventory.variant_id AND i.campaign_id IS NULL) FROM inventory WHERE variant_id='a'`).all<{detail:string}>();
    const plan=results.map(r=>r.detail).join('\n');
    expect(plan).toMatch(/SEARCH o USING INDEX orders_status_page \(status=\?\)/);
    expect(plan).toMatch(/SEARCH i USING INDEX items_order \(order_id=\?\)/);
  });
  it('uses immutable snapshots and projects payment metadata and sale ledger only',async()=>{
    const placed=await (await place()).json() as any;
    const order=placed.order;
    await request('/api/admin/variants/a',{name:'Renamed',price:9999,version:0},headers,'PATCH');
    await notify(order.reference);
    const detail=await (await request(`/api/admin/orders/${order.id}`,undefined,headers)).json() as any;
    expect(Object.keys(detail.order).sort()).toEqual(['id','reference','status','fulfillment','total','currency','createdAt','contact','address','shipping','tracking','items','timeline','hold','openReviewReasons'].sort());
    expect(detail.order.address).toEqual({line:'Street 1',destination:'42',label:'MENTENG, JAKARTA PUSAT, DKI JAKARTA, 10310',province:'DKI JAKARTA',city:'JAKARTA PUSAT',district:'MENTENG',subdistrict:'MENTENG',postalCode:'10310'});
    expect(detail.order.contact.phone).toBe('+62812345678');
    expect(detail.order.items[0]).toMatchObject({name:'A',price:1000,sku:'SKU-A'});
    expect(Object.keys(detail.payment).sort()).toEqual(['status','checks','nextCheck','createdAt'].sort());
    const ledger=await (await request('/api/admin/inventory?variantId=a',undefined,headers)).json() as any;
    expect(ledger.movements[0]).toMatchObject({reason:'sale',delta:-1,orderId:order.id,actor:null});
    expect((await request('/api/admin/orders/missing',undefined,headers)).status).toBe(404);
    expect((await (await request('/api/admin/orders?limit=1',undefined,headers)).json() as any).nextCursor).toBeNull();
  });
  it('lists every campaign and preserves historical shipping promises on edits',async()=>{
    await request('/api/admin/variants/a',{mode:'preorder',version:0},headers,'PATCH');
    const now=Date.now();
    const input={variantId:'a',startsAt:now-10000,endsAt:now+100000,shipFrom:'2026-11-01',shipTo:'2026-11-10',quota:3};
    const campaign=(await (await request('/api/admin/campaigns',input,headers)).json() as any).campaign;
    const order=(await (await place()).json() as any).order;
    const route=`/api/admin/campaigns/${campaign.id}`;
    expect((await request(route,{reserved:0,version:0},headers,'PATCH')).status).toBe(400);
    expect((await request(route,{sold:0,version:0},headers,'PATCH')).status).toBe(400);
    expect((await request(route,{quota:0,version:0},headers,'PATCH')).status).toBe(409);
    expect((await request(route,{endsAt:input.startsAt,version:0},headers,'PATCH')).status).toBe(409);
    expect(await count('audit_logs')).toBe(2);
    expect((await request(route,{shipFrom:'2026-12-01',shipTo:'2026-12-10',active:false,version:0},headers,'PATCH')).status).toBe(200);
    const detail=await (await request(`/api/admin/orders/${order.id}`,undefined,headers)).json() as any;
    expect(detail.order.items[0].campaign).toEqual({id:campaign.id,shipFrom:input.shipFrom,shipTo:input.shipTo});
    for(const [id,start,active] of [['z',now+200000,0],['b',now+200000,0],['y',1,1]] as const) await sql('INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota,active) VALUES(?,?,?,?,?,?,?,?)',id,'a',start,start+100,'2026-11-01','2026-11-10',3,active).run();
    const first=await (await request('/api/admin/campaigns?limit=2',undefined,headers)).json() as any;
    expect(first.campaigns.map((c:any)=>c.id)).toEqual(['z','b']);
    const last=await (await request(`/api/admin/campaigns?limit=2&before=${first.nextCursor.before}&beforeId=b`,undefined,headers)).json() as any;
    expect(last.campaigns.map((c:any)=>c.id)).toEqual([campaign.id,'y']);
    expect(last.nextCursor).toBeNull();
    expect(last.campaigns[0]).toMatchObject({sku:'SKU-A',productName:'Product',reserved:1,sold:0,active:false});
    expect((await request(route,{active:true,startsAt:1,version:1},headers,'PATCH')).status).toBe(409);
  });
  it('numbers campaign and blocklist pages with totals and filters phase and kind on the server',async()=>{
    await request('/api/admin/variants/a',{mode:'preorder',version:0},headers,'PATCH');
    const now=Date.now();
    for(const [id,start,end,active] of [['run',now-1000,now+10000,1],['soon',now+20000,now+30000,1],['old',1,100,1],['off',now+40000,now+50000,0]] as const) await sql('INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota,active) VALUES(?,?,?,?,?,?,?,?)',id,'a',start,end,'2026-11-01','2026-11-10',3,active).run();
    const campaigns=async(query:string)=>{const body=await (await request(`/api/admin/campaigns?${query}`,undefined,headers)).json() as any;return [body.campaigns.map((c:any)=>c.id),body.total];};
    expect(await campaigns('limit=2&page=1')).toEqual([['off','soon'],4]);
    expect(await campaigns('limit=2&page=2')).toEqual([['run','old'],4]);
    expect(await campaigns('phase=running')).toEqual([['run'],1]);
    expect(await campaigns('phase=upcoming')).toEqual([['soon'],1]);
    expect(await campaigns('phase=ended')).toEqual([['old'],1]);
    for(const query of ['phase=inactive','page=0','page=1001']) expect((await request(`/api/admin/campaigns?${query}`,undefined,headers)).status).toBe(400);
    for(const [id,kind,time] of [['e1','email',3],['i1','ip',2],['e2','email',1]] as const) await sql('INSERT INTO blocklist(id,kind,value_hash,reason,actor,created_at) VALUES(?,?,?,?,?,?)',id,kind,id.padStart(64,'0'),'Spam','ops',time).run();
    const blocked=async(query:string)=>{const body=await (await request(`/api/admin/blocklist?${query}`,undefined,headers)).json() as any;return [body.items.map((e:any)=>e.id),body.total];};
    expect(await blocked('kind=email')).toEqual([['e1','e2'],2]);
    expect(await blocked('limit=1&page=2')).toEqual([['i1'],3]);
    expect(await blocked('limit=1&page=4')).toEqual([[],3]);
    expect((await request('/api/admin/blocklist?kind=name',undefined,headers)).status).toBe(400);
  });
  it('patches only supplied catalog fields, never creation defaults', async () => {
    await sql("UPDATE products SET description='Deskripsi yang harus tetap' WHERE id='p'").run();
    await sql("UPDATE product_variants SET mode='preorder' WHERE id='a'").run();
    expect((await request('/api/admin/products/p', { name: 'Nama baru', version: 0 }, headers, 'PATCH')).status).toBe(200);
    expect((await request('/api/admin/variants/a', { price: 2700, version: 0 }, headers, 'PATCH')).status).toBe(200);
    const page = await (await request('/api/admin/products', undefined, headers)).json() as any;
    expect(page.products[0]).toMatchObject({ name: 'Nama baru', description: 'Deskripsi yang harus tetap' });
    expect(page.products[0].variants.find((v: any) => v.id === 'a')).toMatchObject({ price: 2700, mode: 'preorder' });
    for (const path of ['/api/admin/products/p', '/api/admin/variants/a']) {
      expect((await request(path, {}, headers, 'PATCH')).status).toBe(400);
      expect((await request(path, { version: 1 }, headers, 'PATCH')).status).toBe(400);
    }
  });
  it('paginates admin orders sharing timestamps without skipping the boundary', async () => {
    for (const [orderId, created] of [['z', 10], ['b', 10], ['a', 10], ['y', 9]] as const) {
      await sql("INSERT INTO orders(id,reference,guest_token_hash,total,contact_json,address_json,shipping_json,created_at) VALUES(?,?,'private',1000,'{}','{}','{}',?)", orderId, `order-${orderId}`, created).run();
    }
    const first = await (await request('/api/admin/orders?limit=2', undefined, headers)).json() as any;
    expect(first.orders.map((o: any) => o.id)).toEqual(['z', 'b']);
    const last = await (await request('/api/admin/orders?limit=2&before=10&beforeId=b', undefined, headers)).json() as any;
    expect(last.orders.map((o: any) => o.id)).toEqual(['a', 'y']);
    expect(last.nextCursor).toBeNull();
  });
  it('denies nonadmins and cross-origin admin writes',async()=>{
    for(const path of ['/api/admin/orders/missing','/api/admin/inventory?variantId=a','/api/admin/campaigns']) expect((await request(path)).status).toBe(403);
    expect((await request('/api/admin/products/p/variants',variant)).status).toBe(403);
    expect((await request('/api/admin/products/p/variants',variant,{...headers,Origin:'https://evil.test'})).status).toBe(403);
    expect((await request('/api/admin/campaigns/missing',{active:false},{...headers,Origin:'https://evil.test'},'PATCH')).status).toBe(403);
  });
});

describe('payment expiry, cancellation and provider identity', () => {
  const admin = { 'X-Test-Admin': 'admin' };
  const stock = () => sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first();
  const status = (orderId: string) => sql('SELECT o.status AS orderStatus,a.status AS attemptStatus FROM orders o JOIN payment_attempts a ON a.order_id=o.id WHERE o.id=?', orderId).first();
  it('holds stock before the deadline and on lookup failure; expires after due date plus grace', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    await age(order.id, 89);
    await scheduled();
    expect(await status(order.id)).toEqual({ orderStatus: 'pending_payment', attemptStatus: 'pending' });
    // The next check never lands later than the deadline, however small the backoff step.
    const next = await sql('SELECT next_check,created_at FROM payment_attempts WHERE order_id=?', order.id).first<{ next_check: number; created_at: number }>();
    expect(next!.next_check).toBeLessThanOrEqual(next!.created_at + 90 * 60_000);
    await age(order.id);
    provider.lookupStatus = 503;
    await scheduled();
    expect(await status(order.id)).toEqual({ orderStatus: 'pending_payment', attemptStatus: 'pending' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
    provider.lookupStatus = 200; provider.lookup = { status: 'unknown' };
    await age(order.id);
    await scheduled();
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    await age(order.id);
    await scheduled();
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    expect(await sql("SELECT kind FROM order_events WHERE order_id=?", order.id).all()).toMatchObject({ results: [{ kind: 'cancelled' }] });
    expect(await count('manual_review')).toBe(0);
    // A success after expiry is evidence for operators, never a consumption of released stock.
    await notify(order.reference, 'succeeded', 'late-success');
    expect(await sql('SELECT reason FROM manual_review').first()).toEqual({ reason: 'late_payment' });
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    expect(await count('outbox_events')).toBe(0); expect(await count('inventory_movements')).toBe(0);
  });
  it('honours EXPIRY_GRACE_MIN and keeps a mismatched not-paid answer on hold', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    await age(order.id, 91);
    await worker.scheduled({} as ScheduledController, { ...e, EXPIRY_GRACE_MIN: '45' });
    expect(await status(order.id)).toMatchObject({ orderStatus: 'pending_payment' });
    provider.lookup = { status: 'not_paid', amount: 999, currency: 'IDR' };
    await age(order.id, 106);
    await worker.scheduled({} as ScheduledController, { ...e, EXPIRY_GRACE_MIN: '45' });
    expect(await status(order.id)).toMatchObject({ orderStatus: 'pending_payment' });
    expect(await sql('SELECT reason FROM manual_review').first()).toEqual({ reason: 'payment_mismatch' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
  });
  it('moves exhausted attempts out of the scan range with one deterministic review', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookupStatus = 503;
    await sql('UPDATE payment_attempts SET checks=7,next_check=0').run();
    await scheduled();
    const attempt = await sql('SELECT checks,next_check FROM payment_attempts WHERE order_id=?', order.id).first();
    expect(attempt).toEqual({ checks: 8, next_check: 8_640_000_000_000_000 });
    expect(await sql('SELECT id,event_key,reason FROM manual_review').all()).toMatchObject({ results: [{ id: `recovery:${order.reference}`, event_key: `recovery:${order.reference}`, reason: 'reconciliation_exhausted' }] });
    const lookups = provider.lookups;
    await scheduled(); await scheduled();
    expect(provider.lookups).toBe(lookups);
    expect(await count('manual_review')).toBe(1);
    const detail = await (await request(`/api/admin/orders/${order.id}`, undefined, admin)).json() as any;
    expect(detail.payment).toMatchObject({ checks: 8, nextCheck: null });
    // An attempt already reviewed under the old random-id path is moved out of range, not filed twice.
    await sql("UPDATE inventory SET on_hand=2 WHERE variant_id='a'").run();
    const legacy = (await (await place('legacy-key', 2)).json() as any).order;
    await sql("INSERT INTO manual_review(id,event_key,order_id,reason,created_at) VALUES('random-uuid',?,?,'reconciliation_exhausted',1)", `recovery:${legacy.reference}`, legacy.id).run();
    await sql('UPDATE payment_attempts SET checks=8,next_check=0 WHERE order_id=?', legacy.id).run();
    await scheduled();
    expect(await count('manual_review')).toBe(2);
    expect(await sql('SELECT next_check FROM payment_attempts WHERE order_id=?', legacy.id).first('next_check')).toBe(8_640_000_000_000_000);
  });
  // Runs the cron as if `minutes` had passed since the attempt was created.
  async function cronAt(orderId: string, minutes: number, env: Env = e) {
    const created = (await sql('SELECT created_at FROM payment_attempts WHERE order_id=?', orderId).first<number>('created_at'))!;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(created + minutes * 60_000);
    try { await worker.scheduled({} as ScheduledController, env); } finally { clock.mockRestore(); }
    return sql('SELECT checks,next_check-created_at AS nextIn FROM payment_attempts WHERE order_id=?', orderId).first<{ checks: number; nextIn: number }>();
  }
  const minutes = (n: number) => n * 60_000;
  it('expires an abandoned order after three lookups at fixed checkpoints', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    expect(await sql('SELECT next_check-created_at AS n FROM payment_attempts WHERE order_id=?', order.id).first('n')).toBe(minutes(10));
    expect(await cronAt(order.id, 5)).toEqual({ checks: 0, nextIn: minutes(10) });
    expect(await cronAt(order.id, 10)).toEqual({ checks: 1, nextIn: minutes(30) });
    expect(await cronAt(order.id, 20)).toEqual({ checks: 1, nextIn: minutes(30) });
    expect(await cronAt(order.id, 31)).toEqual({ checks: 2, nextIn: minutes(90) });
    expect(await cronAt(order.id, 89)).toMatchObject({ checks: 2 });
    expect(await status(order.id)).toEqual({ orderStatus: 'pending_payment', attemptStatus: 'pending' });
    await cronAt(order.id, 90);
    expect(provider.lookups).toBe(3);
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    expect(await count('manual_review')).toBe(0);
  });
  it('skips missed checkpoints after a late cron run and keeps inconclusive answers going after the deadline', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'unknown' };
    // A backlog reaching the order at 45 minutes skips the 30-minute checkpoint instead of adding lookups.
    expect(await cronAt(order.id, 45)).toEqual({ checks: 1, nextIn: minutes(90) });
    const expected: [number, number][] = [[90, 95], [95, 105], [106, 125], [125, 165], [170, 225], [225, 285]];
    for (const [at, next] of expected) expect((await cronAt(order.id, at))!.nextIn).toBe(minutes(next));
    expect(provider.lookups).toBe(7);
    await cronAt(order.id, 285);
    expect(provider.lookups).toBe(8);
    expect(await sql('SELECT reason FROM manual_review').first('reason')).toBe('reconciliation_exhausted');
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
  });
  it('expires with the maximum grace instead of filing every abandoned order for review', async () => {
    const { order } = await (await place()).json() as any;
    const graced = { ...e, EXPIRY_GRACE_MIN: '120' } as Env;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    await cronAt(order.id, 10, graced);
    expect(await cronAt(order.id, 30, graced)).toEqual({ checks: 2, nextIn: minutes(180) });
    await cronAt(order.id, 179, graced);
    expect(await status(order.id)).toMatchObject({ orderStatus: 'pending_payment' });
    await cronAt(order.id, 180, graced);
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(provider.lookups).toBe(3);
    expect(await count('manual_review')).toBe(0);
  });
  it('expires an order whose payment link was never created once DOKU has no invoice after the deadline', async () => {
    provider.failCreate = true;
    const { order } = await (await place()).json() as any;
    expect(await sql('SELECT status,url FROM payment_attempts WHERE order_id=?', order.id).first()).toEqual({ status: 'unknown', url: null });
    provider.lookup = { status: 'not_found' };
    await cronAt(order.id, 10);
    expect(await status(order.id)).toEqual({ orderStatus: 'pending_payment', attemptStatus: 'unknown' });
    await cronAt(order.id, 90);
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await sql('SELECT amount,status FROM payment_events WHERE event_key=?', `expiry:${order.reference}`).first()).toEqual({ amount: 1100, status: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    // A payment that still arrives is evidence for an operator, not a sale.
    await notify(order.reference, 'succeeded', 'late-after-404');
    expect(await sql('SELECT reason FROM manual_review').first('reason')).toBe('late_payment');
  });
  it('holds an order with a payment link when DOKU reports no invoice', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'not_found' };
    await cronAt(order.id, 90);
    expect(await status(order.id)).toEqual({ orderStatus: 'pending_payment', attemptStatus: 'pending' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
    const route = `/api/orders/${order.reference}/cancel`;
    expect((await request(route, undefined, { 'X-Order-Token': order.guestToken }, 'POST')).status).toBe(503);
  });
  it('lets the shopper cancel right away when no payment link was created and DOKU has no invoice', async () => {
    provider.failCreate = true;
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'not_found' };
    const cancelled = await request(`/api/orders/${order.reference}/cancel`, undefined, { 'X-Order-Token': order.guestToken }, 'POST');
    expect(cancelled.status).toBe(200);
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
  });
  it('reviews a second webhook without a shared transaction, but not a lookup echoing the webhook', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference, 'succeeded', 'doku:first');
    await notify(order.reference, 'succeeded', `lookup:${order.reference}:succeeded:1100:IDR`);
    expect(await count('manual_review')).toBe(0);
    await notify(order.reference, 'succeeded', 'doku:second');
    expect(await sql('SELECT reason,event_key FROM manual_review').first()).toEqual({ reason: 'additional_payment_confirmation', event_key: 'doku:second' });
    // A webhook with a transaction id after a lookup without one is still the same payment.
    await sql("UPDATE inventory SET on_hand=2 WHERE variant_id='a'").run();
    const other = (await (await place('lookup-first', 2)).json() as any).order;
    await notify(other.reference, 'succeeded', `lookup:${other.reference}:succeeded:1100:IDR`);
    await notify(other.reference, 'succeeded', 'doku:after-lookup', 1100, 'IDR', 'VA_BCA@1');
    expect(await sql('SELECT count(*) AS n FROM manual_review WHERE order_id=?', other.id).first('n')).toBe(0);
  });
  it('runs payment recovery every minute but cleanup only on five-minute marks', async () => {
    expect(housekeepingDue(undefined)).toBe(true);
    expect(housekeepingDue(Date.UTC(2026, 9, 15, 3, 10))).toBe(true);
    expect(housekeepingDue(Date.UTC(2026, 9, 15, 3, 12))).toBe(false);
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'unknown' };
    await sql('UPDATE payment_attempts SET next_check=0').run();
    await sql("INSERT INTO rate_counters(key,\"window\",count) VALUES('old',0,1)").run();
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 15, 3, 12) } as ScheduledController, e);
    expect(provider.lookups).toBe(1);
    expect(await count('rate_counters')).toBe(1);
    await worker.scheduled({ scheduledTime: Date.UTC(2026, 9, 15, 3, 15) } as ScheduledController, e);
    expect(await count('rate_counters')).toBe(0);
    expect(await sql('SELECT checks FROM payment_attempts WHERE order_id=?', order.id).first('checks')).toBe(1);
  });
  it('rejected payment creation cancels the order and releases stock; ambiguous failures keep it', async () => {
    provider.createStatus = 400;
    const rejected = await (await place('rejected-key', 1)).json() as any;
    expect(rejected.order.status).toBe('cancelled'); expect(rejected.paymentState).toBe('failed'); expect(rejected.paymentUrl).toBeUndefined();
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    provider.createStatus = 200; provider.failCreate = true;
    const unknown = await (await place('ambiguous-key', 2)).json() as any;
    expect(unknown.order.status).toBe('pending_payment'); expect(unknown.paymentState).toBe('unknown');
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
  });
  it('admin cancel confirms with the provider, is audited, idempotent and loses to a found success', async () => {
    const { order } = await (await place()).json() as any;
    const route = `/api/admin/orders/${order.id}/cancel`;
    expect((await request(route, {})).status).toBe(403);
    expect((await request(route, {}, { ...admin, Origin: 'https://evil.test' })).status).toBe(403);
    provider.lookupStatus = 503;
    expect((await request(route, {}, admin)).status).toBe(503);
    provider.lookupStatus = 200; provider.lookup = { status: 'unknown' };
    expect((await request(route, {}, admin)).status).toBe(503);
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    const cancelled = await request(route, { reason: 'Customer called' }, admin);
    expect(cancelled.status).toBe(200);
    expect(await cancelled.json()).toEqual({ order: { id: order.id, reference: order.reference, status: 'cancelled' }, cancelled: true });
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    expect(await sql("SELECT actor,action,target,details_json FROM audit_logs WHERE action='order.cancel'").first()).toEqual({ actor: 'admin', action: 'order.cancel', target: order.id, details_json: JSON.stringify({ reference: order.reference, reason: 'Customer called' }) });
    const again = await request(route, {}, admin);
    expect(again.status).toBe(200); expect((await again.json() as any).cancelled).toBe(false);
    expect(await count('audit_logs')).toBe(1);
    const second = await (await place('second-key', 2)).json() as any;
    provider.lookup = { status: 'succeeded', amount: 1100, currency: 'IDR' };
    expect((await request(`/api/admin/orders/${second.order.id}/cancel`, {}, admin)).status).toBe(409);
    expect(await status(second.order.id)).toEqual({ orderStatus: 'paid', attemptStatus: 'succeeded' });
    expect(await stock()).toEqual({ on_hand: 0, reserved: 0 });
    expect((await request(`/api/admin/orders/${second.order.id}/cancel`, {}, admin)).status).toBe(409);
    expect((await request('/api/admin/orders/missing/cancel', {}, admin)).status).toBe(404);
  });
  it('customer cancel requires the guest token or owner and records the request on the timeline', async () => {
    const { order } = await (await place()).json() as any;
    const route = `/api/orders/${order.reference}/cancel`;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    expect((await request(route, {})).status).toBe(404);
    expect((await request(route, {}, { 'X-Order-Token': 'wrong' })).status).toBe(404);
    expect((await request(route, {}, { 'X-Order-Token': order.guestToken, Origin: 'https://evil.test' })).status).toBe(403);
    expect(await stock()).toEqual({ on_hand: 1, reserved: 1 });
    const response = await request(route, undefined, { 'X-Order-Token': order.guestToken }, 'POST');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ order: { reference: order.reference, status: 'cancelled' }, cancelled: true });
    expect((await request(route, undefined, { 'X-Order-Token': order.guestToken }, 'POST')).status).toBe(200);
    const read = await (await request(`/api/orders/${order.reference}`, undefined, { 'X-Order-Token': order.guestToken })).json() as any;
    expect(read.order.timeline.map((event: any) => event.kind).sort()).toEqual(['cancelled', 'cancelled_by_customer']);
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    const owned = await (await request('/api/checkout', payload('owned-key'), { 'X-Test-Customer': 'owner' })).json() as any;
    const ownedRoute = `/api/orders/${owned.order.reference}/cancel`;
    expect((await request(ownedRoute, undefined, { 'X-Test-Customer': 'other' }, 'POST')).status).toBe(404);
    provider.lookup = { status: 'succeeded', amount: 1100, currency: 'IDR' };
    expect((await request(ownedRoute, undefined, { 'X-Test-Customer': 'owner' }, 'POST')).status).toBe(409);
    expect(await status(owned.order.id)).toEqual({ orderStatus: 'paid', attemptStatus: 'succeeded' });
  });
  it('resolves a review by cancelling its order atomically with the CAS', async () => {
    const { order } = await (await place()).json() as any;
    await sql('UPDATE payment_attempts SET checks=8,next_check=0').run();
    await scheduled();
    const review = await sql('SELECT id FROM manual_review').first<{ id: string }>();
    const route = `/api/admin/review/${review!.id}`;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    expect((await request(route, { version: 1, status: 'resolved', note: 'stale', action: 'cancel_order' }, admin, 'PATCH')).status).toBe(409);
    expect(await status(order.id)).toMatchObject({ orderStatus: 'pending_payment' });
    expect((await request(route, { version: 0, status: 'resolved', note: 'x', action: 'refund' }, admin, 'PATCH')).status).toBe(400);
    const resolved = await request(route, { version: 0, status: 'resolved', note: 'Provider confirms unpaid', action: 'cancel_order' }, admin, 'PATCH');
    expect(resolved.status).toBe(200);
    expect(await resolved.json()).toMatchObject({ updated: true, version: 1, order: { id: order.id, status: 'cancelled' } });
    expect(await status(order.id)).toEqual({ orderStatus: 'cancelled', attemptStatus: 'expired' });
    expect(await stock()).toEqual({ on_hand: 1, reserved: 0 });
    expect((await sql('SELECT action FROM audit_logs ORDER BY action').all()).results).toEqual([{ action: 'order.cancel' }, { action: 'review.update' }]);
    expect((await request(route, { version: 1, status: 'open', note: 'Reopen', action: 'cancel_order' }, admin, 'PATCH')).status).toBe(200);
    expect(await sql('SELECT version,status FROM manual_review').first()).toEqual({ version: 2, status: 'open' });
  });
  it('does not review the same payment seen via webhook retry and lookup, but reviews a distinct one', async () => {
    const { order } = await (await place()).json() as any;
    await notify(order.reference, 'succeeded', 'doku:first', 1100, 'IDR', 'VA_BCA@1000');
    await notify(order.reference, 'succeeded', 'doku:retry-new-request-id', 1100, 'IDR', 'VA_BCA@1000');
    await notify(order.reference, 'succeeded', 'lookup:no-identity');
    expect(await count('manual_review')).toBe(0);
    expect(await sql('SELECT count(*) AS n FROM payment_events WHERE processed=1').first('n')).toBe(3);
    await notify(order.reference, 'succeeded', 'doku:second-payment', 1100, 'IDR', 'QRIS@2000');
    expect(await sql('SELECT reason,event_key FROM manual_review').first()).toEqual({ reason: 'additional_payment_confirmation', event_key: 'doku:second-payment' });
    await notify(order.reference, 'succeeded', 'doku:other-amount', 1200, 'IDR', 'VA_BCA@1000');
    expect(await sql("SELECT reason FROM manual_review WHERE event_key='doku:other-amount'").first('reason')).toBe('payment_mismatch');
    expect(await count('inventory_movements')).toBe(1); expect(await count('outbox_events')).toBe(1);
  });
  it('announces changed campaign estimates to non-cancelled orders that snapshot the campaign', async () => {
    await sql("UPDATE product_variants SET mode='preorder' WHERE id='a'").run();
    const now = Date.now();
    const { campaign } = await (await request('/api/admin/campaigns', { variantId: 'a', startsAt: now - 1000, endsAt: now + 300000, shipFrom: '2026-12-01', shipTo: '2026-12-15', quota: null }, admin)).json() as any;
    const kept = (await (await place('kept-key', 1)).json() as any).order;
    const dropped = (await (await place('dropped-key', 2)).json() as any).order;
    provider.lookup = { status: 'not_paid', amount: 1100, currency: 'IDR' };
    expect((await request(`/api/admin/orders/${dropped.id}/cancel`, {}, admin)).status).toBe(200);
    const route = `/api/admin/campaigns/${campaign.id}`;
    expect((await request(route, { quota: 10, version: 0 }, admin, 'PATCH')).status).toBe(200);
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='campaign_updated'").first('n')).toBe(0);
    expect((await request(route, { shipTo: '2027-01-10', version: 1 }, admin, 'PATCH')).status).toBe(200);
    const history = await (await request(`/api/orders/${kept.reference}`, undefined, { 'X-Order-Token': kept.guestToken })).json() as any;
    expect(history.order.timeline.find((event: any) => event.kind === 'campaign_updated').details).toEqual({ campaignId: campaign.id, shipFrom: '2026-12-01', shipTo: '2027-01-10' });
    expect(history.order.items[0].campaign.shipTo).toBe('2026-12-15');
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='campaign_updated' AND order_id=?", dropped.id).first('n')).toBe(0);
    expect((await request('/api/admin/campaigns/missing', { shipTo: '2027-01-10', version: 0 }, admin, 'PATCH')).status).toBe(404);
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='campaign_updated'").first('n')).toBe(1);
    expect(history.order.shipping.origin).toBe('1');
  });
  it('normalizes public cache keys, rejects invalid catalog queries and malformed path encoding', async () => {
    const first = await (await request('/api/catalog?limit=1')).json() as any;
    await sql("UPDATE products SET name='Changed' WHERE id='p'").run();
    expect(await (await request('/api/catalog?limit=01&utm_source=x')).json()).toEqual(first);
    for (const query of ['limit=1e1', 'limit=0', 'limit=91', 'limit=+5', 'after=Bad_Slug']) expect((await request(`/api/catalog?${query}`)).status).toBe(400);
    expect((await (await request('/api/catalog?limit=2')).json() as any).products[0].name).toBe('Changed');
    for (const path of ['/api/catalog/%E0%A4%A', '/api/orders/%E0%A4%A', '/api/orders/%E0%A4%A/cancel']) expect((await request(path, path.endsWith('cancel') ? {} : undefined)).status).toBe(400);
  });
});


describe('anti-fraud and abuse controls', () => {
  const owner = { 'X-Test-Admin': 'admin' };
  const turnstileCalls = () => vi.mocked(globalThis.fetch).mock.calls.filter(([input]) => String(input instanceof Request ? input.url : input).endsWith('/turnstile')).length;
  async function buy(o: { key?: string; scope?: number; quantity?: number; contact?: Record<string, string>; address?: Record<string, string>; headers?: Record<string, string>; env?: Env } = {}) {
    const quantity = o.quantity ?? 1, items = [{ variantId: 'a', quantity }];
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify({ origin: '1', destination: '42', weight: quantity * 100, items: [['a', quantity]] })));
    await sql('UPDATE shipping_quotes SET fingerprint=?,weight=? WHERE id=?', btoa(String.fromCharCode(...new Uint8Array(bytes))), quantity * 100, 'q1').run();
    const base = payload(o.key ?? crypto.randomUUID(), items);
    const body = { ...base, contact: { ...base.contact, ...o.contact }, address: { ...base.address, ...o.address } };
    return worker.fetch(new Request('https://shop.test/api/checkout', { method: 'POST', headers: { Origin: e.PUBLIC_ORIGIN, 'Content-Type': 'application/json', Cookie: cookie(o.scope ?? 1), ...o.headers }, body: JSON.stringify(body) }), o.env ?? e);
  }
  const stock = (n = 100) => sql("UPDATE inventory SET on_hand=? WHERE variant_id='a'", n).run();
  const reviews = async (orderId: string) => (await sql('SELECT reason FROM manual_review WHERE order_id=? ORDER BY reason', orderId).all<{ reason: string }>()).results.map(r => r.reason);

  it('rate limits public abuse routes per IP via the binding, or a hashed D1 fixed window, but never the webhook', async () => {
    const tight = { ...e, RL_LOOKUP: (env as any).RL_TIGHT } as Env;
    const lookup = (ip: string, target: Env) => worker.fetch(new Request('https://shop.test/api/orders/FL-missing', { headers: { 'CF-Connecting-IP': ip } }), target);
    expect((await lookup('203.0.113.1', tight)).status).toBe(404);
    expect((await lookup('203.0.113.1', tight)).status).toBe(404);
    const limited = await lookup('203.0.113.1', tight);
    expect(limited.status).toBe(429);
    expect(limited.headers.get('Retry-After')).toBe('60');
    expect(limited.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await limited.json()).toEqual({ error: 'Terlalu banyak permintaan. Coba lagi sebentar.' });
    expect((await lookup('203.0.113.2', tight)).status).toBe(404);
    const fallback = { ...e, RL_CHECKOUT: undefined, RL_QUOTE: undefined, RL_LOOKUP: undefined, RL_AUTH: undefined } as unknown as Env;
    const signIn = () => worker.fetch(new Request('https://shop.test/api/auth/sign-in/social', { method: 'POST', headers: { Origin: e.PUBLIC_ORIGIN, 'Content-Type': 'application/json', 'CF-Connecting-IP': '198.51.100.7' }, body: '{}' }), fallback);
    for (let i = 0; i < 10; i++) expect((await signIn()).status).not.toBe(429);
    expect((await signIn()).status).toBe(429);
    const { results } = await sql('SELECT key,count FROM rate_counters').all<{ key: string; count: number }>();
    expect(results).toEqual([{ key: expect.stringMatching(/^auth:[0-9a-f]{64}$/), count: 11 }]);
    expect(JSON.stringify(results)).not.toContain('198.51.100.7');
    const { order } = await (await place()).json() as any;
    const webhook = () => worker.fetch(new Request('https://shop.test/api/payments/webhook', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Test-Signature': 'valid', 'CF-Connecting-IP': '198.51.100.7' }, body: JSON.stringify({ reference: order.reference, status: 'ignored', eventKey: crypto.randomUUID(), amount: 1100, currency: 'IDR' }) }), { ...fallback, RL_AUTH: (env as any).RL_TIGHT } as Env);
    for (let i = 0; i < 4; i++) expect((await webhook()).status).toBe(200);
    // Old windows are pruned by the cron housekeeping.
    await sql('UPDATE rate_counters SET "window"=0').run();
    await scheduled();
    expect(await count('rate_counters')).toBe(0);
  });

  it('normalizes Indonesian mobile numbers and rejects others before reserving', async () => {
    await stock();
    for (const [phone, normalized] of [['0812-3456-789', '+628123456789'], ['62812345678', '+62812345678'], ['+62 812 345 678', '+62812345678']]) {
      const { order } = await (await buy({ contact: { phone } })).json() as any;
      expect(JSON.parse((await sql('SELECT contact_json FROM orders WHERE id=?', order.id).first<string>('contact_json'))!).phone).toBe(normalized);
    }
    const before = await count('orders');
    for (const phone of ['12345', '+6512345678', '0212345678', '08123', '0812345678901234']) {
      const response = await buy({ contact: { phone } });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: 'Nomor HP tidak valid' });
    }
    expect(await count('orders')).toBe(before);
  });

  it('limits unpaid orders per email, phone or IP before Turnstile without breaking idempotent retries', async () => {
    await stock();
    const strict = { ...e, MAX_PENDING_PER_IDENTITY: undefined, MAX_PENDING_PER_IP: undefined } as unknown as Env, ip = { 'CF-Connecting-IP': '192.0.2.10' };
    const first = await (await buy({ key: 'pending-1', env: strict, headers: ip })).json() as any;
    for (const key of ['pending-2', 'pending-3']) expect((await buy({ key, env: strict, headers: ip })).status).toBe(200);
    const calls = turnstileCalls();
    const refused = await buy({ key: 'pending-4', env: strict, headers: ip });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ error: 'Terlalu banyak pesanan belum dibayar' });
    expect(turnstileCalls()).toBe(calls);
    const retry = await buy({ key: 'pending-1', env: strict, headers: ip });
    expect(retry.status).toBe(200);
    expect((await retry.json() as any).order).toEqual(first.order);
    // Either shared email or phone counts against the identity limit, from any IP.
    expect((await buy({ key: 'pending-5', env: strict, headers: { 'CF-Connecting-IP': '192.0.2.11' }, contact: { email: 'other@example.com' } })).status).toBe(429);
    // CGNAT: a new shopper behind the same carrier IP is admitted until the separate, higher MAX_PENDING_PER_IP (default 10).
    expect((await buy({ key: 'pending-6', env: strict, headers: ip, contact: { email: 'other@example.com', phone: '0899999999' } })).status).toBe(200);
    const ipLimited = { ...strict, MAX_PENDING_PER_IP: '4' } as Env;
    expect((await buy({ key: 'pending-7', env: ipLimited, headers: ip, contact: { email: 'third@example.com', phone: '0855555555' } })).status).toBe(429);
    expect((await buy({ key: 'pending-8', env: ipLimited, headers: { 'CF-Connecting-IP': '192.0.2.11' }, contact: { email: 'third@example.com', phone: '0855555555' } })).status).toBe(200);
    expect(await sql("SELECT count(*) AS n FROM orders WHERE ip_hash IS NOT NULL AND email_hash IS NOT NULL AND phone_hash IS NOT NULL").first('n')).toBe(5);
    expect(JSON.stringify((await sql('SELECT email_hash,phone_hash,ip_hash FROM orders').all()).results)).not.toMatch(/192\.0\.2|example\.com|0812/);
    // Concurrent first orders can all pass the pre-check; the guarded order insert admits only the limit.
    const single = { ...e, MAX_PENDING_PER_IDENTITY: '1' } as Env;
    const racing = await Promise.all([1, 2, 3].map(n => buy({ key: `race-key-${n}`, scope: 10 + n, env: single, contact: { email: 'race@example.com', phone: '0866666666' }, headers: { 'CF-Connecting-IP': '192.0.2.99' } })));
    expect(racing.map(r => r.status).sort()).toEqual([200, 429, 429]);
    expect(await sql("SELECT count(*) AS n FROM checkout_requests WHERE key LIKE 'race-key-%'").first('n')).toBe(1);
  });

  it('opens velocity and disposable-email reviews in the order batch, and holds fulfillment until resolved', async () => {
    await stock(3);
    const fast = { ...e, VELOCITY_LIMIT: '2' } as Env;
    const orders = [];
    for (let i = 0; i < 3; i++) orders.push((await (await buy({ env: fast })).json() as any).order);
    expect(await reviews(orders[0].id)).toEqual([]);
    expect(await reviews(orders[2].id)).toEqual(['risk_velocity']);
    // Velocity by IP alone uses its own, higher VELOCITY_LIMIT_IP so carrier CGNAT does not flag every shopper.
    const shared = { ...e, VELOCITY_LIMIT_IP: '2' } as Env, carrier = { 'CF-Connecting-IP': '198.51.100.7' };
    await stock(10);
    const viaIp = [];
    for (const [n, phone] of [[1, '0811111111'], [2, '0822222222'], [3, '0833333333']] as const) viaIp.push((await (await buy({ env: shared, headers: carrier, contact: { email: `cgnat${n}@example.com`, phone } })).json() as any).order);
    expect(await reviews(viaIp[1].id)).toEqual([]);
    expect(await reviews(viaIp[2].id)).toEqual(['risk_velocity']);
    await sql("UPDATE inventory SET on_hand=reserved WHERE variant_id='a'").run();
    // A rolled-back checkout (no stock left) leaves no orphan review even though velocity would fire.
    const reviewCount = await count('manual_review');
    expect((await buy({ env: fast })).status).toBe(409);
    expect(await count('manual_review')).toBe(reviewCount);
    await stock(10);
    const { order } = await (await buy({ contact: { email: 'Someone@Sub.Mailinator.com' } })).json() as any;
    expect(await reviews(order.id)).toEqual(['risk_disposable_email']);
    expect(order.status).toBe('pending_payment');
    await notify(order.reference, 'succeeded', `paid-${order.id}`);
    const held = await request(`/api/admin/orders/${order.id}/fulfillment`, { status: 'processing' }, owner, 'PATCH');
    expect(held.status).toBe(409);
    expect(await held.json()).toEqual({ error: 'Pesanan ditahan: review risiko terbuka' });
    const listed = (await (await request('/api/admin/orders', undefined, owner)).json() as any).orders.find((o: any) => o.id === order.id);
    expect(listed).toMatchObject({ hold: true, openReviewReasons: ['risk_disposable_email'] });
    expect((await (await request(`/api/admin/orders/${orders[0].id}`, undefined, owner)).json() as any).order).toMatchObject({ hold: false, openReviewReasons: [] });
    const review = await sql('SELECT id FROM manual_review WHERE order_id=?', order.id).first<string>('id');
    expect((await request(`/api/admin/review/${review}`, { version: 0, status: 'resolved', note: 'Customer verified by phone' }, owner, 'PATCH')).status).toBe(200);
    expect((await (await request(`/api/admin/orders/${order.id}`, undefined, owner)).json() as any).order.hold).toBe(false);
    expect((await request(`/api/admin/orders/${order.id}/fulfillment`, { status: 'processing' }, owner, 'PATCH')).status).toBe(200);
  });

  it('blocks hashed identities before Turnstile with audited admin CRUD that never stores raw values', async () => {
    await stock();
    const ops = { 'X-Test-Admin': 'ops' };
    const created = await request('/api/admin/blocklist', { kind: 'email', value: ' Guest@Example.com ', reason: 'chargeback' }, ops);
    expect(created.status).toBe(201);
    const { entry } = await created.json() as any;
    expect(await (await request('/api/admin/blocklist', { kind: 'email', value: 'guest@example.com', reason: 'again' }, ops)).json()).toMatchObject({ created: false, entry: { id: entry.id } });
    for (const input of [{ kind: 'phone', value: '12345', reason: 'x' }, { kind: 'email', value: 'not-an-email', reason: 'x' }, { kind: 'ip', value: '<script>', reason: 'x' }, { kind: 'email', value: 'a@b.co' }]) expect((await request('/api/admin/blocklist', input, ops)).status).toBe(400);
    expect((await request('/api/admin/blocklist', undefined, { 'X-Test-Admin': 'catalog' })).status).toBe(403);
    const calls = turnstileCalls();
    const refused = await buy();
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'Pesanan tidak dapat diproses' });
    expect(turnstileCalls()).toBe(calls);
    const page = await (await request('/api/admin/blocklist', undefined, ops)).json() as any;
    expect(page.items).toEqual([{ id: entry.id, kind: 'email', reason: 'chargeback', actor: 'ops', createdAt: entry.createdAt }]);
    const stored = JSON.stringify([(await sql('SELECT * FROM blocklist').all()).results, (await sql('SELECT * FROM audit_logs').all()).results]);
    expect(stored).not.toMatch(/guest@example\.com/i);
    expect((await request(`/api/admin/blocklist/${entry.id}`, undefined, ops, 'DELETE')).status).toBe(200);
    expect((await request(`/api/admin/blocklist/${entry.id}`, undefined, ops, 'DELETE')).status).toBe(404);
    expect((await sql("SELECT action,details_json FROM audit_logs WHERE action LIKE 'blocklist.%' ORDER BY rowid").all()).results).toEqual([
      { action: 'blocklist.add', details_json: '{"kind":"email","reason":"chargeback"}' }, { action: 'blocklist.remove', details_json: '{"kind":"email","reason":"chargeback"}' }]);
    const ip = { 'CF-Connecting-IP': '203.0.113.50' };
    const { order } = await (await buy({ headers: ip })).json() as any;
    const blocked = await (await request(`/api/admin/orders/${order.id}/block`, { kinds: ['phone', 'ip'], reason: 'fraud ring' }, ops)).json() as any;
    expect(blocked.blocked).toEqual([{ kind: 'phone', created: true }, { kind: 'ip', created: true }]);
    expect((await buy({ headers: ip, contact: { email: 'new@example.com', phone: '0899999999' } })).status).toBe(403);
    expect((await buy({ contact: { email: 'new@example.com' } })).status).toBe(403);
    expect((await buy({ contact: { email: 'new@example.com', phone: '0899999999' } })).status).toBe(200);
    expect((await request('/api/admin/orders/missing/block', { kinds: ['email'], reason: 'x' }, ops)).status).toBe(404);
  });

  it('enforces per-order and per-customer purchase limits by SKU, with a trigger backstop', async () => {
    await stock();
    expect((await request('/api/admin/variants/a', { maxPerOrder: 2, maxPerCustomer: 3, version: 0 }, owner, 'PATCH')).status).toBe(200);
    expect(await sql("SELECT name,mode,price,max_per_order,max_per_customer FROM product_variants WHERE id='a'").first()).toEqual({ name: 'A', mode: 'stock', price: 1000, max_per_order: 2, max_per_customer: 3 });
    for (const value of [0, -1, 1.5, '2']) expect((await request('/api/admin/variants/a', { maxPerOrder: value, version: 1 }, owner, 'PATCH')).status).toBe(400);
    expect((await (await request('/api/catalog/product')).json() as any).product.variants.find((v: any) => v.id === 'a')).toMatchObject({ maxPerOrder: 2, maxPerCustomer: 3 });
    const tooMany = await buy({ quantity: 3 });
    expect(tooMany.status).toBe(409);
    expect(await tooMany.json()).toEqual({ error: 'Maksimal 2 per pesanan untuk SKU-A' });
    const { order } = await (await buy({ quantity: 2 })).json() as any;
    const over = await buy({ quantity: 2 });
    expect(over.status).toBe(409);
    expect(await over.json()).toEqual({ error: 'Batas pembelian SKU-A adalah 3 per pelanggan' });
    // Same phone, different email is the same customer; a cancelled order would no longer count.
    expect((await buy({ contact: { email: 'alias@example.com' } })).status).toBe(200);
    expect((await buy({ contact: { email: 'alias2@example.com' } })).status).toBe(409);
    expect((await buy({ contact: { email: 'stranger@example.com', phone: '0877777777' }, quantity: 2 })).status).toBe(200);
    await expect(sql("INSERT INTO order_items(id,order_id,variant_id,quantity,price,snapshot_json) VALUES('direct',?,'a',5,1000,'{}')", order.id).run()).rejects.toThrow('purchase_limit');
    expect((await request('/api/admin/variants/a', { maxPerOrder: null, maxPerCustomer: null, version: 1 }, owner, 'PATCH')).status).toBe(200);
    expect((await buy({ quantity: 3 })).status).toBe(200);
    const created = await (await request('/api/admin/products/p/variants', { sku: 'SKU-L', name: 'Limited', price: 10, weight: 10, maxPerOrder: 1 }, owner)).json() as any;
    expect(await sql('SELECT max_per_order,max_per_customer FROM product_variants WHERE id=?', created.variant.id).first()).toEqual({ max_per_order: 1, max_per_customer: null });
  });

  it('snapshots the server-side destination, ignoring client city and postal code', async () => {
    const { order } = await (await buy({ address: { city: 'Bogus', postalCode: '99999' } })).json() as any;
    expect(JSON.parse((await sql('SELECT address_json FROM orders WHERE id=?', order.id).first<string>('address_json'))!)).toMatchObject({ city: 'JAKARTA PUSAT', postalCode: '10310', district: 'MENTENG' });
    await sql("DELETE FROM shipping_destinations").run();
    const unknown = await buy();
    expect(unknown.status).toBe(409);
    expect(await unknown.json()).toEqual({ error: 'Wilayah tujuan tidak dikenal; cari ulang wilayah' });
  });

  it('records verified non-sale provider events as reviewed evidence and acknowledges them', async () => {
    const { order } = await (await place()).json() as any;
    const event = { reference: order.reference, status: 'provider_event', eventKey: 'refund-1', amount: 1100, currency: 'IDR', kind: 'REFUND:SUCCESS' };
    for (let i = 0; i < 2; i++) {
      const response = await request('/api/payments/webhook', event, { 'X-Test-Signature': 'valid' });
      expect(response.status).toBe(200);
    }
    expect(await sql("SELECT status,processed,kind,applied FROM payment_events WHERE event_key='refund-1'").first()).toEqual({ status: 'ignored', processed: 1, kind: 'REFUND:SUCCESS', applied: 0 });
    expect(await reviews(order.id)).toEqual(['provider_event']);
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first('status')).toBe('pending_payment');
    expect((await request('/api/payments/webhook', { ...event, reference: 'FL-unknown', eventKey: 'chargeback-1' }, { 'X-Test-Signature': 'valid' })).status).toBe(200);
    expect(await sql("SELECT reason,order_id FROM manual_review WHERE event_key='chargeback-1'").first()).toEqual({ reason: 'unknown_reference', order_id: null });
  });

  it('enforces the admin role matrix in routing', async () => {
    const as = (role: string) => ({ 'X-Test-Admin': role });
    const matrix: [string, string, string, unknown?][] = [
      ['ops', 'GET', '/api/admin/orders'], ['ops', 'GET', '/api/admin/review'], ['ops', 'GET', '/api/admin/blocklist'],
      ['catalog', 'GET', '/api/admin/products'], ['catalog', 'GET', '/api/admin/campaigns'], ['catalog', 'GET', '/api/admin/inventory?variantId=a'],
      ['admin', 'GET', '/api/admin/orders'], ['admin', 'GET', '/api/admin/products'],
    ];
    for (const [role, method, path] of matrix) expect((await request(path, undefined, as(role), method)).status, `${role} ${path}`).toBe(200);
    const denied: [string, string, string, unknown?][] = [
      ['ops', 'GET', '/api/admin/products'], ['ops', 'POST', '/api/admin/products', { slug: 'x', name: 'x', variants: [{ sku: 'x', name: 'x', price: 1, weight: 1 }] }], ['ops', 'POST', '/api/admin/inventory', { variantId: 'a', delta: 1, reason: 'x', key: crypto.randomUUID() }],
      ['catalog', 'GET', '/api/admin/orders'], ['catalog', 'GET', '/api/admin/review'], ['catalog', 'GET', '/api/admin/blocklist'], ['catalog', 'GET', '/api/admin/operations'],
      ['ops', 'GET', '/api/admin/unlisted'], ['catalog', 'GET', '/api/admin/unlisted'],
    ];
    for (const [role, method, path, body] of denied) expect((await request(path, body, as(role), method)).status, `${role} ${path}`).toBe(403);
    expect((await request('/api/admin/unlisted', undefined, owner)).status).toBe(404);
    expect(await sql('SELECT on_hand FROM inventory WHERE variant_id=?', 'a').first('on_hand')).toBe(1);
  });

  it('audits PII order reads and keeps every audit row immutable', async () => {
    const { order } = await (await place()).json() as any;
    await request(`/api/admin/orders/${order.id}`, undefined, { 'X-Test-Admin': 'ops' });
    expect(await sql("SELECT actor,target,details_json FROM audit_logs WHERE action='order.view'").first()).toEqual({ actor: 'ops', target: order.id, details_json: '{}' });
    expect((await request('/api/admin/orders/missing', undefined, owner)).status).toBe(404);
    expect(await sql("SELECT count(*) AS n FROM audit_logs WHERE action='order.view'").first('n')).toBe(1);
    await expect(sql("UPDATE audit_logs SET actor='someone-else'").run()).rejects.toThrow('audit_log_immutable');
    await expect(sql('DELETE FROM audit_logs').run()).rejects.toThrow('audit_log_immutable');
  });

  it('lets only an owner cancel an exhausted, unconfirmable attempt, audited, while late payment still reviews', async () => {
    const { order } = await (await place()).json() as any;
    provider.lookup = { status: 'unknown' };
    const cancel = (body: unknown, headers = owner) => request(`/api/admin/orders/${order.id}/cancel`, body, headers);
    expect((await cancel({})).status).toBe(503);
    expect((await cancel({ confirmNoPayment: true })).status).toBe(400);
    expect((await cancel({ confirmNoPayment: true, reason: 'DOKU has no record' }, { 'X-Test-Admin': 'ops' })).status).toBe(403);
    const early = await cancel({ confirmNoPayment: true, reason: 'DOKU has no record' });
    expect(early.status).toBe(409);
    expect(await early.json()).toEqual({ error: 'Pembatalan paksa memerlukan review reconciliation_exhausted' });
    await sql("INSERT INTO manual_review(id,event_key,order_id,reason,created_at) VALUES(?,?,?,'reconciliation_exhausted',?)", `recovery:${order.reference}`, `recovery:${order.reference}`, order.id, Date.now()).run();
    provider.lookupStatus = 404;
    const forced = await cancel({ confirmNoPayment: true, reason: 'DOKU has no record' });
    expect(forced.status).toBe(200);
    expect((await forced.json() as any).order.status).toBe('cancelled');
    expect(JSON.parse((await sql("SELECT details_json FROM audit_logs WHERE action='order.cancel' AND target=?", order.id).first<string>('details_json'))!)).toEqual({ reference: order.reference, reason: 'DOKU has no record', confirmNoPayment: true, forced: true });
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first('reserved')).toBe(0);
    await notify(order.reference, 'succeeded', 'late-success');
    expect(await reviews(order.id)).toEqual(['late_payment', 'reconciliation_exhausted']);
    // A success found during a forced cancel still wins.
    await stock(5);
    const second = (await (await place('second-order', 2)).json() as any).order;
    await sql("INSERT INTO manual_review(id,event_key,order_id,reason,created_at) VALUES(?,?,?,'reconciliation_exhausted',?)", `recovery:${second.reference}`, `recovery:${second.reference}`, second.id, Date.now()).run();
    provider.lookupStatus = 200; provider.lookup = { status: 'succeeded', amount: 1100, currency: 'IDR' };
    expect((await request(`/api/admin/orders/${second.id}/cancel`, { confirmNoPayment: true, reason: 'x' }, owner)).status).toBe(409);
    expect(await sql('SELECT status FROM orders WHERE id=?', second.id).first('status')).toBe('paid');
  });

  it('shows public stock as coarse levels while admins keep exact counts', async () => {
    const levels = async (target = e) => {
      await caches.default.delete(new Request('https://shop.test/api/catalog'));
      return Object.fromEntries(((await (await worker.fetch(new Request('https://shop.test/api/catalog'), target)).json() as any).products[0].variants).map((v: any) => [v.id, v]));
    };
    let variants = await levels();
    expect(variants.a).toMatchObject({ stockLevel: 'low' }); expect(variants.b).toMatchObject({ stockLevel: 'out' });
    expect(Object.keys(variants.a)).not.toContain('available');
    await stock(6);
    expect((await levels()).a.stockLevel).toBe('in_stock');
    expect((await levels({ ...e, LOW_STOCK_PUBLIC: '10' } as Env)).a.stockLevel).toBe('low');
    const admin = (await (await request('/api/admin/products', undefined, owner)).json() as any).products[0].variants.find((v: any) => v.id === 'a');
    expect(admin).toMatchObject({ available: 6, onHand: 6, reserved: 0 });
  });

  it('refuses checkout for a banned customer and treats them as signed out elsewhere', async () => {
    const banned = { 'X-Test-Customer': 'banned-user', 'X-Test-Banned': '1' };
    const response = await buy({ headers: banned });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Pesanan tidak dapat diproses' });
    expect((await request('/api/orders', undefined, banned)).status).toBe(401);
    expect(await count('orders')).toBe(0);
  });

  it('serves strict CSP and framing headers for the admin shell and SSR pages', async () => {
    const adminResponse = withAdminHeaders(new Response('<html></html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'no-cache' } }), 'https://media.test');
    const csp = adminResponse.headers.get('Content-Security-Policy')!;
    expect(csp).toContain("frame-ancestors 'none'"); expect(csp).toContain("script-src 'self';"); expect(csp).toContain('https://media.test');
    expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(adminResponse.headers.get('X-Frame-Options')).toBe('DENY');
    expect(adminResponse.headers.get('Permissions-Policy')).toContain('camera=()');
    expect(adminResponse.headers.get('Cache-Control')).toBe('no-cache');
    const script = '(function(){self.Astro={}})();';
    const { headers, body } = await withStorefrontHeaders(new Response(`<html><script>${script}</script><script type="module" src="/_astro/a.js"></script></html>`, { headers: { 'Content-Type': 'text/html' } }), 'https://media.test');
    const hash = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(script)))));
    const store = headers.get('Content-Security-Policy')!;
    expect(store).toContain(`'sha256-${hash}'`);
    expect(store).toContain("frame-ancestors 'none'");
    expect(store).toMatch(/script-src 'self' https:\/\/challenges\.cloudflare\.com/);
    expect(store).toContain('frame-src https://challenges.cloudflare.com');
    expect(store).toMatch(/img-src 'self' data: https:\/\/media\.test/);
    expect(store).not.toMatch(/script-src[^;]*unsafe-inline/);
    expect(headers.get('X-Frame-Options')).toBe('DENY');
    expect(body).toContain(script);
    const product = await request('/api/admin/products', { slug: 'remote-image', name: 'Remote', imageUrl: 'https://evil.test/x.png', variants: [{ sku: 'R', name: 'R', price: 1, weight: 1 }] }, owner);
    expect(product.status).toBe(400);
    expect((await request('/api/admin/products/p', { imageUrl: 'https://evil.test/y.png' }, owner, 'PATCH')).status).toBe(400);
  });
});

describe('ecommerce features', () => {
  const owner = { 'X-Test-Admin': 'admin' }, catalogRole = { 'X-Test-Admin': 'catalog' }, ops = { 'X-Test-Admin': 'ops' };
  const preview = (items: unknown, target = e) => worker.fetch(new Request('https://shop.test/api/cart/preview', { method: 'POST', headers: { Origin: e.PUBLIC_ORIGIN, 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }), target);

  it('filters the public catalog by category and bounded escaped name search with normalized cache keys', async () => {
    const created = await request('/api/admin/categories', { slug: 'strategi', name: 'Strategi', position: 1 }, catalogRole);
    expect(created.status).toBe(201);
    const { category } = await created.json() as any;
    expect(category).toMatchObject({ slug: 'strategi', name: 'Strategi', position: 1, active: true, version: 0 });
    expect((await request('/api/admin/categories', { slug: 'party', name: 'Party', position: 2 }, ops)).status).toBe(403);
    await request('/api/admin/products', { slug: 'catan', name: 'Catan 100%_Edition', categoryId: category.id, variants: [{ sku: 'CATAN', name: 'Base', price: 500000, weight: 1800 }] }, owner);
    expect((await request('/api/admin/products', { slug: 'ghost', name: 'Ghost', categoryId: 'missing', variants: [{ sku: 'GHOST', name: 'Base', price: 1, weight: 1 }] }, owner)).status).toBe(409);
    const slugs = async (query: string) => ((await (await request(`/api/catalog?${query}`)).json() as any).products as any[]).map(p => p.slug);
    expect(await slugs('category=strategi')).toEqual(['catan']);
    expect(await slugs('category=unknown')).toEqual([]);
    expect(await slugs('q=CATAN')).toEqual(['catan']);
    expect(await slugs('q=100%25_')).toEqual(['catan']);
    expect(await slugs('q=0%25')).toEqual(['catan']);
    expect(await slugs('q=_e')).toEqual(['catan']);
    expect(await slugs('q=%25%25')).toEqual([]);
    expect(await slugs('q=')).toEqual(['catan', 'product']);
    for (const query of ['q=a', `q=${'x'.repeat(61)}`, 'category=Bad_Slug']) expect((await request(`/api/catalog?${query}`)).status).toBe(400);
    const key = publicCacheKey(new URL('https://shop.test/api/catalog?q=%20%20Catan%20%20%20Base%20&category=strategi&utm_source=x'), catalogParams)!;
    expect(key.url).toBe('https://shop.test/api/catalog?category=strategi&q=catan+base');
    expect(publicCacheKey(new URL('https://shop.test/catalog?q=a'), catalogParams)).toBeNull();
    expect(publicCacheKey(new URL('https://shop.test/catalog?q=&category='), catalogParams)!.url).toBe('https://shop.test/catalog');
    const product = (await (await request('/api/catalog/catan')).json() as any).product;
    expect(product.category).toEqual({ slug: 'strategi', name: 'Strategi' });
    expect((await (await request('/api/categories')).json() as any).categories.map((c: any) => c.slug)).toEqual(['strategi']);
    const stale = await request(`/api/admin/categories/${category.id}`, { name: 'Strategi Berat', version: 1 }, catalogRole, 'PATCH');
    expect(stale.status).toBe(409);
    expect((await stale.json() as any).details.current).toMatchObject({ name: 'Strategi', version: 0 });
    expect((await (await request(`/api/admin/categories/${category.id}`, { name: 'Strategi Berat', version: 0 }, catalogRole, 'PATCH')).json() as any).category).toMatchObject({ name: 'Strategi Berat', version: 1 });
    expect((await request(`/api/admin/categories/${category.id}`, undefined, catalogRole, 'DELETE')).status).toBe(409);
    const catan = (await (await request('/api/admin/products?q=catan', undefined, owner)).json() as any).products[0];
    expect((await (await request(`/api/admin/products/${catan.id}`, { categoryId: null, version: catan.version }, owner, 'PATCH')).json() as any).product).toMatchObject({ categoryId: null, version: 1 });
    expect((await request(`/api/admin/categories/${category.id}`, undefined, catalogRole, 'DELETE')).status).toBe(200);
    expect(await sql("SELECT count(*) AS n FROM audit_logs WHERE action LIKE 'category.%'").first('n')).toBe(3);
  });

  it('filters admin products by active/archived status without changing the public catalog', async () => {
    await sql("INSERT INTO products(id,slug,name,active) VALUES('old','old-stock','Old stock',0),('new','new-stock','New stock',1)").run();
    const slugs = async (path: string, headers = catalogRole) => ((await (await request(path, undefined, headers)).json() as any).products as any[]).map(p => p.slug);
    expect(await slugs('/api/admin/products')).toEqual(['new-stock', 'old-stock', 'product']);
    expect(await slugs('/api/admin/products?status=all')).toEqual(['new-stock', 'old-stock', 'product']);
    expect(await slugs('/api/admin/products?status=active')).toEqual(['new-stock', 'product']);
    expect(await slugs('/api/admin/products?status=archived')).toEqual(['old-stock']);
    expect(await slugs('/api/admin/products?status=archived&q=stock&limit=1')).toEqual(['old-stock']);
    expect((await request('/api/admin/products?status=deleted', undefined, catalogRole)).status).toBe(400);
    // The public catalog never shows archived products and ignores the admin-only parameter.
    const publicSlugs = await slugs('/api/catalog', {});
    expect(publicSlugs).toEqual(['new-stock', 'product']);
    expect(await slugs('/api/catalog?status=archived', {})).toEqual(publicSlugs);
    expect(publicCacheKey(new URL('https://shop.test/api/catalog?status=archived'), catalogParams)!.url).toBe('https://shop.test/api/catalog');
  });

  it('counts products per category, archived ones included, for the admin list only', async () => {
    await sql("INSERT INTO categories(id,slug,name,position) VALUES('c1','satu','Satu',0),('c2','dua','Dua',1)").run();
    await sql("INSERT INTO products(id,slug,name,category_id,active) VALUES('x','x','X','c1',1),('y','y','Y','c1',0)").run();
    const { categories } = await (await request('/api/admin/categories', undefined, catalogRole)).json() as any;
    expect(categories.map((c: any) => [c.slug, c.productCount])).toEqual([['satu', 2], ['dua', 0]]);
    const open = await (await request('/api/categories')).json() as any;
    expect(open.categories[0]).not.toHaveProperty('productCount');
  });

  it('rejects variant search terms whose LIKE pattern exceeds D1 limits instead of failing in D1', async () => {
    expect((await request(`/api/admin/variants/search?q=${'x'.repeat(48)}`, undefined, catalogRole)).status).toBe(200);
    expect((await request(`/api/admin/variants/search?q=${'x'.repeat(49)}`, undefined, catalogRole)).status).toBe(400);
    expect((await request(`/api/admin/variants/search?q=${'_'.repeat(25)}`, undefined, catalogRole)).status).toBe(400);
  });

  it('previews the cart authoritatively without caching or reserving', async () => {
    await sql("UPDATE product_variants SET max_per_order=2 WHERE id='a'").run();
    await db().batch([
      sql("INSERT INTO products(id,slug,name) VALUES('po','preorder','PO Game')"),
      sql("INSERT INTO product_variants(id,product_id,sku,name,price,weight,mode) VALUES('c','po','SKU-C','C',5000,300,'preorder'),('d','po','SKU-D','D',5000,300,'preorder')"),
      sql("INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota) VALUES('camp','c',0,?,'2027-02-01','2027-02-20',null)", Date.now() + 100000),
    ]);
    const response = await preview([{ variantId: 'a', quantity: 3 }, { variantId: 'b', quantity: 1 }, { variantId: 'c', quantity: 2 }, { variantId: 'd', quantity: 1 }, { variantId: 'gone', quantity: 1 }]);
    expect(response.status).toBe(200);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    const body = await response.json() as any;
    expect(body.lines[0]).toMatchObject({ variantId: 'a', available: true, sku: 'SKU-A', productName: 'Product', price: 1000, lineTotal: 3000, mode: 'stock', enough: false, maxPerOrder: 2, campaign: null });
    expect(body.lines[2]).toMatchObject({ variantId: 'c', enough: true, stockLevel: 'in_stock', campaign: { id: 'camp', shipFrom: '2027-02-01', shipTo: '2027-02-20' } });
    expect(body.lines[4]).toEqual({ variantId: 'gone', quantity: 1, available: false });
    expect(body.lines[0]).not.toHaveProperty('onHand');
    expect(body.subtotal).toBe(3000 + 1000 + 10000 + 5000);
    expect(body.shipPromise).toEqual({ shipFrom: '2027-02-01', shipTo: '2027-02-20', policy: 'single-shipment-latest-item' });
    expect(body.problems.map((p: any) => [p.variantId, p.code])).toEqual([['a', 'insufficient'], ['a', 'max_per_order'], ['b', 'insufficient'], ['d', 'no_campaign'], ['gone', 'unavailable']]);
    expect(await sql("SELECT reserved FROM inventory WHERE variant_id='a'").first('reserved')).toBe(0);
    expect((await preview([{ variantId: 'a', quantity: 1 }, { variantId: 'a', quantity: 1 }])).status).toBe(400);
    expect((await preview(Array.from({ length: 31 }, (_, i) => ({ variantId: `v${i}`, quantity: 1 })))).status).toBe(400);
    expect((await preview([{ variantId: 'a', quantity: 1 }])).headers.get('X-Request-ID')).toBeTruthy();
    expect(((await (await preview([{ variantId: 'a', quantity: 1 }])).json()) as any).problems).toEqual([]);
  });

  it('returns the authoritative total on a price change and keeps idempotent retries intact', async () => {
    await sql("UPDATE product_variants SET price=1500 WHERE id='a'").run();
    const changed = await place('price-key');
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({ error: 'Total changed; confirm authoritative total', details: { total: 1600 } });
    expect(await count('orders')).toBe(0);
    const confirmed = await request('/api/checkout', { ...payload('price-key-2'), expectedTotal: 1600 }, { Cookie: cookie(1) });
    expect(confirmed.status).toBe(200);
    const body = await confirmed.json() as any;
    expect(body.order).toMatchObject({ total: 1600, shipPromise: { shipFrom: null, shipTo: null, policy: 'single-shipment-latest-item' }, shippingService: 'REG', shippingAmount: 100 });
    expect(await sql("SELECT created_at FROM checkout_requests WHERE key='price-key-2'").first('created_at')).toBeGreaterThan(0);
  });

  it('bills volumetric weight and refuses carts over the weight limit', async () => {
    expect(chargeableWeight({ weight: 100, length_cm: 30, width_cm: 30, height_cm: 10 }, 6000)).toBe(1500);
    expect(chargeableWeight({ weight: 2000, length_cm: 30, width_cm: 30, height_cm: 10 }, 6000)).toBe(2000);
    expect(chargeableWeight({ weight: 100, length_cm: 30, width_cm: null, height_cm: 10 }, 6000)).toBe(100);
    expect(chargeableWeight({ weight: 100, length_cm: 30, width_cm: 30, height_cm: 10 }, 5000)).toBe(1800);
    const variant = await (await request('/api/admin/products/p/variants', { sku: 'BOX', name: 'Box', price: 10, weight: 100, lengthCm: 30, widthCm: 30, heightCm: 10 }, owner)).json() as any;
    expect(variant.variant).toMatchObject({ lengthCm: 30, widthCm: 30, heightCm: 10, lowStockThreshold: null });
    for (const value of [0, 301, 1.5]) expect((await request(`/api/admin/variants/${variant.variant.id}`, { lengthCm: value, version: 0 }, owner, 'PATCH')).status).toBe(400);
    const patched = await (await request(`/api/admin/variants/${variant.variant.id}`, { heightCm: 20, version: 0 }, owner, 'PATCH')).json() as any;
    expect(patched.variant).toMatchObject({ lengthCm: 30, widthCm: 30, heightCm: 20, weight: 100, price: 10, version: 1 });
    expect(((await (await preview([{ variantId: variant.variant.id, quantity: 1 }])).json()) as any).weight).toBe(3000);
    await sql("UPDATE product_variants SET length_cm=30,width_cm=30,height_cm=10 WHERE id='a'").run();
    // The quote was priced for 100 g; the billed 1500 g no longer matches it.
    expect((await place('volumetric')).status).toBe(409);
    const heavy = await (await preview([{ variantId: 'a', quantity: 1 }], { ...e, MAX_CART_WEIGHT_G: '1000' } as Env)).json() as any;
    expect(heavy.problems).toEqual([{ variantId: null, code: 'weight_limit', message: 'Berat total melebihi batas 1 kg per pesanan' }]);
    const refused = await worker.fetch(new Request('https://shop.test/api/checkout', { method: 'POST', headers: { Origin: e.PUBLIC_ORIGIN, 'Content-Type': 'application/json', Cookie: cookie(1) }, body: JSON.stringify(payload('heavy-cart')) }), { ...e, MAX_CART_WEIGHT_G: '1000' } as Env);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: 'Berat total melebihi batas 1 kg per pesanan' });
  });

  it('compare-and-swaps catalog edits and returns the updated entity', async () => {
    const first = await request('/api/admin/variants/a', { price: 1200, version: 0 }, owner, 'PATCH');
    expect((await first.json() as any).variant).toMatchObject({ id: 'a', price: 1200, version: 1, onHand: 1 });
    const stale = await request('/api/admin/variants/a', { price: 1300, version: 0 }, owner, 'PATCH');
    expect(stale.status).toBe(409);
    expect((await stale.json() as any).details.current).toMatchObject({ price: 1200, version: 1 });
    expect((await request('/api/admin/variants/a', { price: 1300 }, owner, 'PATCH')).status).toBe(400);
    expect((await request('/api/admin/variants/missing', { price: 1300, version: 0 }, owner, 'PATCH')).status).toBe(404);
    expect((await (await request('/api/admin/products/p', { name: 'Baru', version: 0 }, owner, 'PATCH')).json() as any).product).toMatchObject({ name: 'Baru', version: 1, active: true });
    expect((await request('/api/admin/products/p', { name: 'Lama', version: 0 }, owner, 'PATCH')).status).toBe(409);
    expect(await sql("SELECT count(*) AS n FROM audit_logs WHERE action IN ('variants.update','products.update')").first('n')).toBe(2);
    await sql("UPDATE product_variants SET mode='preorder' WHERE id='b'").run();
    const { campaign } = await (await request('/api/admin/campaigns', { variantId: 'b', startsAt: 0, endsAt: Date.now() + 100000, shipFrom: '2027-01-01', shipTo: '2027-01-05', quota: 5 }, owner)).json() as any;
    expect(campaign).toMatchObject({ version: 0, sku: 'SKU-B', quota: 5, active: true });
    expect((await (await request(`/api/admin/campaigns/${campaign.id}`, { quota: 6, version: 0 }, owner, 'PATCH')).json() as any).campaign).toMatchObject({ quota: 6, version: 1 });
    const lost = await request(`/api/admin/campaigns/${campaign.id}`, { quota: 7, version: 0 }, owner, 'PATCH');
    expect(lost.status).toBe(409);
    expect((await lost.json() as any).details.current).toMatchObject({ quota: 6, version: 1 });
    const listed = (await (await request('/api/admin/products', undefined, owner)).json() as any).products[0];
    expect(listed).toMatchObject({ version: 1, categoryId: null });
    expect(listed.variants.find((v: any) => v.id === 'b').campaign.version).toBe(1);
  });

  it('searches variants for pickers and lists low stock against per-variant thresholds', async () => {
    await db().batch([
      sql("INSERT INTO product_variants(id,product_id,sku,name,price,weight,low_stock_threshold) VALUES('c','p','SKU-A2','Deluxe',1,1,0),('d','p','X-100%','Promo',1,1,null)"),
      sql("INSERT INTO inventory(variant_id,on_hand) VALUES('c',3),('d',50)"),
    ]);
    const found = async (q: string, extra = '') => ((await (await request(`/api/admin/variants/search?q=${encodeURIComponent(q)}${extra}`, undefined, catalogRole)).json() as any).variants as any[]).map(v => v.sku);
    expect(await found('sku-a2')).toEqual(['SKU-A2', ]);
    expect(await found('sku-a')).toEqual(['SKU-A', 'SKU-A2']);
    expect(await found('product')).toEqual(['SKU-A', 'SKU-A2', 'SKU-B', 'X-100%']);
    expect(await found('0%')).toEqual(['X-100%']);
    expect(await found('deluxe', '&mode=preorder')).toEqual([]);
    for (const q of ['', ' ', 'x'.repeat(61)]) expect((await request(`/api/admin/variants/search?q=${q}`, undefined, catalogRole)).status).toBe(400);
    const low = (await (await request('/api/admin/inventory?low=1', undefined, catalogRole)).json() as any).lowStock;
    expect(low.map((v: any) => [v.sku, v.available, v.threshold])).toEqual([['SKU-B', 0, 5], ['SKU-A', 1, 5]]);
    const lowered = (await (await request('/api/admin/inventory?low=1', undefined, catalogRole)).json() as any);
    expect(lowered.lowStock.some((v: any) => v.sku === 'SKU-A2')).toBe(false);
    expect((await request('/api/admin/inventory?low=1', undefined, ops)).status).toBe(403);
  });

  it('maps couriers to tracking pages and exposes tracking on the order API', async () => {
    expect(tracking('JP123', 'jne:REG')).toEqual({ number: 'JP123', courier: 'jne', courierName: 'JNE', url: 'https://www.jne.co.id/tracking-package' });
    expect(tracking('X1', 'SiCepat')).toMatchObject({ courierName: 'SiCepat', url: 'https://www.sicepat.com/checkAwb' });
    expect(tracking('X1', 'paxel:SAMEDAY')).toEqual({ number: 'X1', courier: 'paxel', courierName: 'PAXEL', url: null });
    expect(tracking(undefined, 'jne')).toBeNull();
    for (const code of ['jne', 'jnt', 'sicepat', 'anteraja', 'pos', 'tiki', 'ninja', 'lion', 'ide', 'sap', 'wahana']) expect(tracking('R', code)!.url).toMatch(/^https:\/\//);
    const { order } = await (await place()).json() as any;
    await notify(order.reference);
    const route = `/api/admin/orders/${order.id}/fulfillment`;
    await request(route, { status: 'processing' }, owner, 'PATCH');
    expect((await request(route, { status: 'shipped', tracking: 'AWB-1', courier: 'not valid!' }, owner, 'PATCH')).status).toBe(400);
    expect((await request(route, { status: 'shipped', tracking: 'AWB-1', courier: 'AnterAja' }, owner, 'PATCH')).status).toBe(200);
    const detail = await (await request(`/api/orders/${order.reference}`, undefined, { 'X-Order-Token': order.guestToken })).json() as any;
    expect(detail.order.tracking).toEqual({ number: 'AWB-1', courier: 'anteraja', courierName: 'AnterAja', url: 'https://anteraja.id/tracking' });
    expect((await (await request(`/api/admin/orders/${order.id}`, undefined, owner)).json() as any).order.tracking.number).toBe('AWB-1');
  });

  it('auto-completes long-shipped orders without open reviews, at most once', async () => {
    const shipped = async (key: string, scope: number) => {
      await stock();
      const { order } = await (await place(`auto-${key}-key`, scope)).json() as any;
      await notify(order.reference, 'succeeded', `paid-${key}`);
      for (const status of ['processing', 'shipped']) await request(`/api/admin/orders/${order.id}/fulfillment`, { status, tracking: 'R' }, owner, 'PATCH');
      return order;
    };
    const stock = () => sql("UPDATE inventory SET on_hand=on_hand+1 WHERE variant_id='a'").run();
    const old = await shipped('old', 1), held = await shipped('held', 2), recent = await shipped('recent', 3);
    await sql("UPDATE order_events SET created_at=? WHERE kind='shipped' AND order_id IN (?,?)", Date.now() - 15 * 86_400_000, old.id, held.id).run();
    await sql("INSERT INTO manual_review(id,event_key,order_id,reason,created_at) VALUES('hold','hold',?,'risk_velocity',0)", held.id).run();
    await scheduled();
    const state = async (id: string) => sql('SELECT status,fulfillment FROM orders WHERE id=?', id).first();
    expect(await state(old.id)).toEqual({ status: 'completed', fulfillment: 'delivered' });
    expect(await state(held.id)).toEqual({ status: 'paid', fulfillment: 'shipped' });
    expect(await state(recent.id)).toEqual({ status: 'paid', fulfillment: 'shipped' });
    const timeline = (await (await request(`/api/orders/${old.reference}`, undefined, { 'X-Order-Token': old.guestToken })).json() as any).order.timeline.map((t: any) => t.kind);
    expect(timeline.slice(-2).sort()).toEqual(['auto_completed', 'completed']);
    await scheduled();
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='auto_completed'").first('n')).toBe(1);
    expect(await sql("SELECT details_json FROM order_events WHERE kind='auto_completed'").first('details_json')).toBe('{"afterDays":14}');
  });

  it('retains idempotency records for seven days and redacts PII only on finished orders when configured', async () => {
    const old = Date.now() - 8 * 86_400_000;
    const statements = [];
    for (let i = 0; i < 205; i++) statements.push(sql("INSERT INTO orders(id,reference,guest_token_hash,total,contact_json,address_json,shipping_json,created_at,status) VALUES(?,?,'h',1,'{\"name\":\"x\"}','{\"line\":\"y\"}','{}',?,'cancelled')", `o${i}`, `R${i}`, old),
      sql('INSERT INTO checkout_requests(scope,key,fingerprint,order_id,created_at) VALUES(?,?,?,?,?)', 's', `k${i}`, 'f', `o${i}`, old));
    await db().batch(statements);
    await db().batch([
      sql("INSERT INTO orders(id,reference,guest_token_hash,total,contact_json,address_json,shipping_json,created_at) VALUES('pending','PENDING','h',1,'{\"name\":\"p\"}','{}','{}',?),('recent','RECENT','h',1,'{}','{}','{}',?)", old, Date.now()),
      sql("INSERT INTO checkout_requests(scope,key,fingerprint,order_id,created_at) VALUES('s','pending','f','pending',?),('s','fresh','f','recent',?)", old, Date.now()),
    ]);
    await scheduled();
    expect(await count('checkout_requests')).toBe(7);
    await scheduled();
    // The fresh record and the pending order's record survive.
    expect((await sql('SELECT key FROM checkout_requests ORDER BY key').all()).results.map((r: any) => r.key)).toEqual(['fresh', 'pending']);
    expect(await sql("SELECT count(*) AS n FROM orders WHERE pii_redacted_at IS NOT NULL").first('n')).toBe(0);
    const redact = (id: string, contact = '{"redacted":true}', extra = '') => sql(`UPDATE orders SET contact_json=?,address_json='{"redacted":true}',pii_redacted_at=1${extra} WHERE id=?`, contact, id).run();
    await expect(redact('pending')).rejects.toThrow('commercial_snapshot_immutable');
    await expect(redact('o1', '{"name":"other"}')).rejects.toThrow('commercial_snapshot_immutable');
    await expect(redact('o1', '{"redacted":true}', ',total=2')).rejects.toThrow('commercial_snapshot_immutable');
    await expect(sql("UPDATE orders SET contact_json='{\"name\":\"z\"}' WHERE id='o1'").run()).rejects.toThrow('commercial_snapshot_immutable');
    await redact('o1');
    await expect(redact('o1')).rejects.toThrow('commercial_snapshot_immutable');
    await expect(sql("UPDATE orders SET pii_redacted_at=NULL WHERE id='o1'").run()).rejects.toThrow('commercial_snapshot_immutable');
    const configured = { ...e, ORDER_PII_RETENTION_DAYS: '7' } as Env;
    await worker.scheduled({} as ScheduledController, configured);
    expect(await sql("SELECT count(*) AS n FROM orders WHERE pii_redacted_at IS NOT NULL").first('n')).toBe(101);
    expect(await sql("SELECT contact_json FROM orders WHERE id='pending'").first('contact_json')).toBe('{"name":"p"}');
    await worker.scheduled({} as ScheduledController, configured);
    await worker.scheduled({} as ScheduledController, configured);
    expect(await sql("SELECT count(*) AS n FROM orders WHERE pii_redacted_at IS NULL").first('n')).toBe(2);
  });

  it('counts sales on the WIB day they were paid and uses calendar-day ranges', async () => {
    const now = Date.now(), midnight = Math.floor((now + 7 * 3_600_000) / 86_400_000) * 86_400_000 - 7 * 3_600_000, day = 86_400_000;
    const order = (id: string, created: number, paid: number | null, total: number, status = 'paid') => [
      sql('INSERT INTO orders(id,reference,guest_token_hash,total,contact_json,address_json,shipping_json,created_at,status) VALUES(?,?,?,?,?,?,?,?,?)', id, `FL-${id}`, 'h', total, '{}', '{}', JSON.stringify({ amount: 500 }), created, status),
      ...(paid === null ? [] : [sql("INSERT INTO order_events(id,order_id,kind,created_at) VALUES(?,?,'paid',?)", `${id}:paid`, id, paid)]),
    ];
    await db().batch([
      // Created before midnight, paid after it: today's sale.
      ...order('overnight', midnight - 60_000, midnight + 60_000, 10_000),
      // Created today but never paid.
      ...order('unpaid', now - 1000, null, 99_000, 'pending_payment'),
      // First and last minute of the 7-day WIB window.
      ...order('week-start', midnight - 6 * day - 1, midnight - 6 * day, 20_000, 'completed'),
      ...order('week-before', midnight - 7 * day, midnight - 6 * day - 1, 40_000, 'completed'),
      ...order('month-start', midnight - 29 * day, midnight - 29 * day, 80_000, 'completed'),
      ...order('month-before', midnight - 30 * day, midnight - 29 * day - 1, 160_000, 'completed'),
    ]);
    const summary = async (range: string) => (await (await request(`/api/admin/summary?range=${range}`, undefined, ops)).json() as any);
    expect(await summary('today')).toMatchObject({ since: midnight, paidOrders: 1, revenue: 10_000, shipping: 500, itemsRevenue: 9_500 });
    expect(await summary('7d')).toMatchObject({ since: midnight - 6 * day, paidOrders: 2, revenue: 30_000, shipping: 1000, itemsRevenue: 29_000 });
    expect(await summary('30d')).toMatchObject({ since: midnight - 29 * day, paidOrders: 4, revenue: 150_000 });
    for (const range of ['constructor', '__proto__', '']) expect((await request(`/api/admin/summary?range=${range}`, undefined, ops)).status).toBe(400);
    const plan = (await sql("EXPLAIN QUERY PLAN SELECT count(*) FROM order_events e CROSS JOIN orders o ON o.id=e.order_id WHERE e.kind='paid' AND e.created_at>=? AND o.status IN ('paid','completed')", 0).all<{ detail: string }>()).results.map(r => r.detail).join('\n');
    expect(plan).toMatch(/SEARCH e USING INDEX order_events_paid \(created_at>\?\)/);
    expect(plan).toMatch(/SEARCH o USING INDEX sqlite_autoindex_orders_1 \(id=\?\)/);
  });

  it('summarizes sales, filters and exports orders with CSV injection protection and audit', async () => {
    const secret = e.RISK_HASH_SECRET!, now = Date.now();
    const insert = (id: string, status: string, fulfillment: string, total: number, created: number, contact: Record<string, string>) =>
      sql('INSERT INTO orders(id,reference,guest_token_hash,total,contact_json,address_json,shipping_json,created_at,status,fulfillment,email_hash,phone_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        id, `FL-${id}`, 'h', total, JSON.stringify(contact), JSON.stringify({ line: 'Jl. 1', city: 'Bandung' }), JSON.stringify({ service: 'jne:REG', amount: 100 }), created, status, fulfillment, null, null);
    await db().batch([
      insert('paid1', 'paid', 'unfulfilled', 10000, now - 1000, { name: '=HYPERLINK("http://evil")', email: 'a@example.com', phone: '+62811' }),
      insert('paid2', 'paid', 'shipped', 20000, now - 2000, { name: '@SUM(A1)', email: 'b@example.com', phone: '+62812' }),
      insert('done', 'completed', 'delivered', 30000, now - 10 * 86_400_000, { name: '-1+1', email: 'c@example.com', phone: '+62813' }),
      insert('wait', 'pending_payment', 'unfulfilled', 5000, now - 3000, { name: 'Plain "quoted"', email: 'd@example.com', phone: '+62814' }),
      insert('void', 'cancelled', 'unfulfilled', 5000, now - 4000, { name: 'x', email: 'e@example.com', phone: '+62815' }),
    ]);
    await sql("INSERT INTO orders(id,reference,guest_token_hash,total,contact_json,address_json,shipping_json,created_at,status,email_hash,phone_hash) VALUES('hashed','FL-hashed','h',7000,'{}','{}','{}',?,'paid',?,?)",
      now - 500, await riskHash(secret, 'email', 'find@example.com'), await riskHash(secret, 'phone', '+62812345678')).run();
    await sql("INSERT INTO manual_review(id,event_key,order_id,reason,created_at) VALUES('r','r','hashed','risk_velocity',0)").run();
    await sql("INSERT INTO inventory(variant_id,on_hand) VALUES('c',0)").run().catch(() => {});
    for (const [orderId, at] of [['paid1', now - 1000], ['paid2', now - 2000], ['done', now - 10 * 86_400_000], ['hashed', now - 500]] as const) await sql("INSERT INTO order_events(id,order_id,kind,created_at) VALUES(?,?,'paid',?)", `${orderId}:paid`, orderId, at).run();
    const summary = async (range: string) => (await (await request(`/api/admin/summary?range=${range}`, undefined, ops)).json() as any);
    expect(await summary('today')).toMatchObject({ paidOrders: 3, revenue: 37000, shipping: 200, itemsRevenue: 36800, averageOrderValue: 12333, pendingPayment: 1, toFulfill: 1, openReviews: 1, lowStock: 2 });
    expect(await summary('30d')).toMatchObject({ paidOrders: 4, revenue: 67000 });
    expect((await request('/api/admin/summary?range=1y', undefined, ops)).status).toBe(400);
    expect((await request('/api/admin/summary', undefined, catalogRole)).status).toBe(403);
    const ids = async (query: string) => ((await (await request(`/api/admin/orders?${query}`, undefined, ops)).json() as any).orders as any[]).map(o => o.id);
    expect(await ids('status=paid')).toEqual(['hashed', 'paid1', 'paid2']);
    // The unaudited list carries the name and shipping service only; email, phone and address stay in the audited detail.
    const listed = (await (await request('/api/admin/orders?status=paid', undefined, ops)).json() as any).orders as any[];
    expect(listed.find(o => o.id === 'paid1')).toEqual({ id: 'paid1', reference: 'FL-paid1', status: 'paid', fulfillment: 'unfulfilled', total: 10000, currency: 'IDR', createdAt: now - 1000, contact: { name: '=HYPERLINK("http://evil")' }, shipping: { service: 'jne:REG' }, hold: false, openReviewReasons: [] });
    expect(listed.find(o => o.id === 'hashed')).toMatchObject({ contact: { name: null }, shipping: { service: null }, hold: true });
    expect(JSON.stringify(listed)).not.toMatch(/example\.com|\+6281|Jl\. 1|Bandung/);
    expect(await sql("SELECT count(*) AS n FROM audit_logs WHERE action='order.view'").first('n')).toBe(0);
    expect(await ids('status=to_fulfill')).toEqual(['paid1']);
    expect(await ids('status=held')).toEqual(['hashed']);
    expect(await ids('status=shipped')).toEqual(['paid2']);
    expect(await ids('status=pending_payment')).toEqual(['wait']);
    expect(await ids('q=FL-done')).toEqual(['done']);
    expect(await ids('q=Find%40Example.com')).toEqual(['hashed']);
    expect(await ids('q=0812-345-678')).toEqual(['hashed']);
    expect(await ids('status=paid&limit=1&before=' + (now - 500) + '&beforeId=hashed')).toEqual(['paid1']);
    const day = (offset: number) => new Date(now + 7 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 10);
    expect(await ids(`from=${day(-11)}&to=${day(-9)}`)).toEqual(['done']);
    for (const query of ['status=refunded', 'from=2026-02-30', 'to=yesterday']) expect((await request(`/api/admin/orders?${query}`, undefined, ops)).status).toBe(400);
    const exported = await request('/api/admin/orders/export.csv?status=paid', undefined, ops);
    expect(exported.status).toBe(200);
    expect(exported.headers.get('Content-Type')).toBe('text/csv; charset=utf-8');
    expect(exported.headers.get('Cache-Control')).toBe('private, no-store');
    const csv = await exported.text(), rows = csv.trim().split('\r\n');
    expect(rows[0]).toBe('reference,created_at,status,fulfillment,hold,total,currency,name,email,phone,address,subdistrict,district,city,province,postal_code,shipping_service,shipping_amount');
    expect(rows).toHaveLength(4);
    expect(rows[1]).toMatch(/^"FL-hashed",.*"held"/);
    expect(rows[2]).toContain(`"'=HYPERLINK(""http://evil"")"`);
    expect(rows[3]).toContain(`"'@SUM(A1)"`);
    expect(csvCell('-1+1')).toBe(`"'-1+1"`);
    expect(csvCell('+62811')).toBe(`"'+62811"`);
    expect(csvCell('Plain "quoted"')).toBe('"Plain ""quoted"""');
    expect(csvCell(null)).toBe('""');
    expect(await sql("SELECT actor,details_json FROM audit_logs WHERE action='orders.export'").first()).toEqual({ actor: 'ops', details_json: JSON.stringify({ filters: { status: 'paid', from: null, to: null, q: null }, cap: 5000 }) });
    const capped = (await (await request('/api/admin/orders/export.csv?limit=2', undefined, ops)).text()).trim().split('\r\n');
    expect(capped).toHaveLength(3);
    expect((await request('/api/admin/orders/export.csv', undefined, catalogRole)).status).toBe(403);
  });

  it('serves a bounded cached sitemap and robots rules for public pages only', async () => {
    await sql("INSERT INTO products(id,slug,name,active) VALUES('hidden','hidden-game','Hidden',0)").run();
    await sql("INSERT INTO categories(id,slug,name) VALUES('cat','keluarga','Keluarga')").run();
    const response = await request('/sitemap.xml');
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8');
    const xml = await response.text();
    for (const path of ['/', '/catalog', '/privacy', '/terms', '/returns', '/about', '/policies', '/products/product', '/catalog?category=keluarga']) expect(xml).toContain(`<loc>https://shop.test${path}</loc>`);
    expect(xml).not.toContain('hidden-game');
    expect(xml).not.toMatch(/\/cart|\/order|\/admin/);
    await sql("UPDATE products SET slug='renamed' WHERE id='p'").run();
    expect(await (await request('/sitemap.xml')).text()).toBe(xml);
    const robots = await (await request('/robots.txt')).text();
    for (const rule of ['Disallow: /admin', 'Disallow: /cart', 'Disallow: /order', 'Disallow: /api', 'Sitemap: https://shop.test/sitemap.xml']) expect(robots).toContain(rule);
  });
});
