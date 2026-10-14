import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import migration from '../migrations/0001_commerce.sql?raw';
import reviewMigration from '../migrations/0004_manual_review.sql?raw';
import historyMigration from '../migrations/0005_customer_orders.sql?raw';
import pagesMigration from '../migrations/0006_admin_pages.sql?raw';
import lifecycleMigration from '../migrations/0008_lifecycle.sql?raw';
import worker, { type Env } from '../src/worker';

const provider = vi.hoisted(() => ({ failCreate: false, createStatus: 200, lookupStatus: 200, lookups: 0, lookup: {status:'unknown'} as Record<string, unknown>, beforeResponse: null as null | ((input: { reference: string }) => Promise<void>) }));

// Commerce contract fixture: replace only integration boundary, never D1 or commerce logic.
// Provider calls traverse native fetch with Vitest's supported workerd outbound mock.
vi.mock('../src/integrations/index', () => ({
  handleIntegrationRequest: async () => null,
  getCustomer: async (request: Request) => request.headers.get('X-Test-Customer') ? { id: request.headers.get('X-Test-Customer') } : null,
  requireAdmin: async (request: Request) => {
    if (request.headers.get('X-Test-Admin') !== 'admin') throw Object.assign(new Error('Admin required'), { status: 403 });
    return { id: 'admin' };
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

const e = { ...env, PUBLIC_ORIGIN: 'https://shop.test', RAJAONGKIR_ORIGIN:'1', ASSETS: { fetch: async () => new Response('asset') } } as unknown as Env;
const db = () => e.DB;
const sql = (query: string, ...values: (string | number | null)[]) => db().prepare(query).bind(...values);
const count = async (table: string) => (await sql(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>())!.n;
async function request(path: string, payload?: unknown, headers: Record<string, string> = {}, method?: string) {
  return worker.fetch(new Request(`https://shop.test${path}`, { method: method ?? (payload ? 'POST' : 'GET'), headers: { Origin: e.PUBLIC_ORIGIN, ...(payload ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(payload ? { body: JSON.stringify(payload) } : {}) }), e);
}
const cookie = (n: number) => `__Host-checkout_scope=${n.toString(16).padStart(64, '0')}`;
function payload(key = 'checkout-key', items = [{ variantId: 'a', quantity: 1 }]) {
  return { items, shippingQuoteId: items.length > 1 ? 'q2' : 'q1', expectedTotal: items.reduce((total, item) => total + item.quantity * 1000, 100), contact: { name: 'Customer', email: 'guest@example.com', phone: '0812345' }, address: { line: 'Street 1', city: 'Jakarta', postalCode: '12345', destination: '42' }, idempotencyKey: key, turnstileToken: 'fresh-token' };
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
  // Shipping-owned quote contract. Real integration migration is applied by the integration suite.
  await sql('CREATE TABLE IF NOT EXISTS shipping_quotes(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,destination TEXT NOT NULL,service TEXT NOT NULL,amount INTEGER NOT NULL,weight INTEGER NOT NULL,expires_at INTEGER NOT NULL,details_json TEXT NOT NULL)').run();
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
  await sql('DROP TRIGGER review_audit_no_delete').run();
  for (const table of ['audit_logs','outbox_events','order_events','manual_review','payment_events','payment_attempts','inventory_movements','stock_reservations','order_items','checkout_requests','orders','preorder_campaigns','inventory','product_variants','products','shipping_quotes']) await sql(`DELETE FROM ${table}`).run();
  await sql(statements(reviewMigration).find(q => q.startsWith('CREATE TRIGGER review_audit_no_delete'))!).run();
  for (const path of ['/api/catalog','/api/catalog/product','/api/catalog/new-product','/api/catalog/preorder','/api/catalog?limit=1','/api/catalog?limit=2','/api/catalog?after=product&limit=1','/api/catalog?limit=1&after=product']) await caches.default.delete(new Request(`https://shop.test${path}`));
  await db().batch([
    sql("INSERT INTO products(id,slug,name) VALUES('p','product','Product')"),
    sql("INSERT INTO product_variants(id,product_id,sku,name,price,weight) VALUES('a','p','SKU-A','A',1000,100),('b','p','SKU-B','B',1000,100)"),
    sql("INSERT INTO inventory(variant_id,on_hand) VALUES('a',1),('b',0)"),
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
    await expect(sql("UPDATE audit_logs SET details_json='{}' WHERE action='review.update'").run()).rejects.toThrow('review_audit_immutable');
    await expect(sql("DELETE FROM audit_logs WHERE action='review.update'").run()).rejects.toThrow('review_audit_immutable');
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
    const dev = {...e,APP_ENV:'development',DEV_LOGIN_ENABLED:'true'};
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
    expect((await catalog.json() as any).products[0].variants[0].available).toBe(1);
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
    expect((await catalog.json() as any).product.variants[0].campaign.available).toBeNull();
    expect((await request('/api/admin/inventory', { variantId: 'b', delta: 2, reason: 'receipt' }, headers)).status).toBe(200);
    const { order } = await (await place()).json() as any;
    expect((await request('/api/admin/inventory', { variantId: 'a', delta: -1, reason: 'shrinkage' }, headers)).status).toBe(409);
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
    expect((await request('/api/admin/inventory', { variantId: 'a', delta: 1, reason: 'restock' })).status).toBe(403);
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
    expect((await request('/api/admin/products/p',{active:false},headers,'PATCH')).status).toBe(200);
    expect((await request('/api/admin/variants/a',{price:9000},headers,'PATCH')).status).toBe(200);
    const fresh = await (await request('/api/admin/products',undefined,headers)).json() as any;
    expect(fresh.products[0].active).toBe(false);
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
    expect(created.variant).toMatchObject({...variant,mode:'stock',productId:'p'});
    const ledger=await (await request(`/api/admin/inventory?variantId=${created.variant.id}`,undefined,headers)).json() as any;
    expect(ledger.inventory).toEqual({variantId:created.variant.id,onHand:3,reserved:0,available:3});
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
  it('uses immutable snapshots and projects payment metadata and sale ledger only',async()=>{
    const placed=await (await place()).json() as any;
    const order=placed.order;
    await request('/api/admin/variants/a',{name:'Renamed',price:9999},headers,'PATCH');
    await notify(order.reference);
    const detail=await (await request(`/api/admin/orders/${order.id}`,undefined,headers)).json() as any;
    expect(Object.keys(detail.order).sort()).toEqual(['id','reference','status','fulfillment','total','currency','createdAt','contact','address','shipping','items','timeline'].sort());
    expect(detail.order.items[0]).toMatchObject({name:'A',price:1000,sku:'SKU-A'});
    expect(Object.keys(detail.payment).sort()).toEqual(['status','checks','nextCheck','createdAt'].sort());
    const ledger=await (await request('/api/admin/inventory?variantId=a',undefined,headers)).json() as any;
    expect(ledger.movements[0]).toMatchObject({reason:'sale',delta:-1,orderId:order.id,actor:null});
    expect((await request('/api/admin/orders/missing',undefined,headers)).status).toBe(404);
    expect((await (await request('/api/admin/orders?limit=1',undefined,headers)).json() as any).nextCursor).toBeNull();
  });
  it('lists every campaign and preserves historical shipping promises on edits',async()=>{
    await request('/api/admin/variants/a',{mode:'preorder'},headers,'PATCH');
    const now=Date.now();
    const input={variantId:'a',startsAt:now-10000,endsAt:now+100000,shipFrom:'2026-11-01',shipTo:'2026-11-10',quota:3};
    const campaign=(await (await request('/api/admin/campaigns',input,headers)).json() as any).campaign;
    const order=(await (await place()).json() as any).order;
    const route=`/api/admin/campaigns/${campaign.id}`;
    expect((await request(route,{reserved:0},headers,'PATCH')).status).toBe(400);
    expect((await request(route,{sold:0},headers,'PATCH')).status).toBe(400);
    expect((await request(route,{quota:0},headers,'PATCH')).status).toBe(409);
    expect((await request(route,{endsAt:input.startsAt},headers,'PATCH')).status).toBe(409);
    expect(await count('audit_logs')).toBe(2);
    expect((await request(route,{shipFrom:'2026-12-01',shipTo:'2026-12-10',active:false},headers,'PATCH')).status).toBe(200);
    const detail=await (await request(`/api/admin/orders/${order.id}`,undefined,headers)).json() as any;
    expect(detail.order.items[0].campaign).toEqual({id:campaign.id,shipFrom:input.shipFrom,shipTo:input.shipTo});
    for(const [id,start,active] of [['z',now+200000,0],['b',now+200000,0],['y',1,1]] as const) await sql('INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota,active) VALUES(?,?,?,?,?,?,?,?)',id,'a',start,start+100,'2026-11-01','2026-11-10',3,active).run();
    const first=await (await request('/api/admin/campaigns?limit=2',undefined,headers)).json() as any;
    expect(first.campaigns.map((c:any)=>c.id)).toEqual(['z','b']);
    const last=await (await request(`/api/admin/campaigns?limit=2&before=${first.nextCursor.before}&beforeId=b`,undefined,headers)).json() as any;
    expect(last.campaigns.map((c:any)=>c.id)).toEqual([campaign.id,'y']);
    expect(last.nextCursor).toBeNull();
    expect(last.campaigns[0]).toMatchObject({sku:'SKU-A',productName:'Product',reserved:1,sold:0,active:false});
    expect((await request(route,{active:true,startsAt:1},headers,'PATCH')).status).toBe(409);
  });
  it('patches only supplied catalog fields, never creation defaults', async () => {
    await sql("UPDATE products SET description='Deskripsi yang harus tetap' WHERE id='p'").run();
    await sql("UPDATE product_variants SET mode='preorder' WHERE id='a'").run();
    expect((await request('/api/admin/products/p', { name: 'Nama baru' }, headers, 'PATCH')).status).toBe(200);
    expect((await request('/api/admin/variants/a', { price: 2700 }, headers, 'PATCH')).status).toBe(200);
    const page = await (await request('/api/admin/products', undefined, headers)).json() as any;
    expect(page.products[0]).toMatchObject({ name: 'Nama baru', description: 'Deskripsi yang harus tetap' });
    expect(page.products[0].variants.find((v: any) => v.id === 'a')).toMatchObject({ price: 2700, mode: 'preorder' });
    for (const path of ['/api/admin/products/p', '/api/admin/variants/a']) {
      expect((await request(path, {}, headers, 'PATCH')).status).toBe(400);
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
    expect((await request(route, { quota: 10 }, admin, 'PATCH')).status).toBe(200);
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='campaign_updated'").first('n')).toBe(0);
    expect((await request(route, { shipTo: '2027-01-10' }, admin, 'PATCH')).status).toBe(200);
    const history = await (await request(`/api/orders/${kept.reference}`, undefined, { 'X-Order-Token': kept.guestToken })).json() as any;
    expect(history.order.timeline.find((event: any) => event.kind === 'campaign_updated').details).toEqual({ campaignId: campaign.id, shipFrom: '2026-12-01', shipTo: '2027-01-10' });
    expect(history.order.items[0].campaign.shipTo).toBe('2026-12-15');
    expect(await sql("SELECT count(*) AS n FROM order_events WHERE kind='campaign_updated' AND order_id=?", dropped.id).first('n')).toBe(0);
    expect((await request('/api/admin/campaigns/missing', { shipTo: '2027-01-10' }, admin, 'PATCH')).status).toBe(404);
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
