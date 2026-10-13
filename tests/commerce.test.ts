import { applyD1Migrations, env } from 'cloudflare:test';
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import migration from '../migrations/0001_commerce.sql?raw';
import worker, { type Env } from '../src/worker';

const provider = vi.hoisted(() => ({ failCreate: false, lookup: {status:'unknown'} as Record<string, unknown>, beforeResponse: null as null | ((input: { reference: string }) => Promise<void>) }));

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
    if (!response.ok) throw new Error('Provider timeout');
    if (provider.beforeResponse) await provider.beforeResponse(input as { reference: string });
    return response.json();
  },
  verifyPaymentWebhook: async (request: Request) => {
    if (request.headers.get('X-Test-Signature') !== 'valid') throw Object.assign(new Error('Invalid signature'), { status: 401 });
    return request.json();
  },
  lookupPayment: async (reference: string) => (await fetch(`https://boundary.test/lookup/${reference}`)).json(),
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
async function notify(reference: string, status = 'succeeded', eventKey = 'event-1', amount = 1100, currency = 'IDR') {
  return request('/api/payments/webhook', { reference, status, eventKey, amount, currency }, { 'X-Test-Signature': 'valid' });
}
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
  await applyD1Migrations(db(), [{ name: '0001_commerce.sql', queries: statements(migration) }]);
  // Shipping-owned quote contract. Real integration migration is applied by the integration suite.
  await sql('CREATE TABLE IF NOT EXISTS shipping_quotes(id TEXT PRIMARY KEY,fingerprint TEXT NOT NULL,destination TEXT NOT NULL,service TEXT NOT NULL,amount INTEGER NOT NULL,weight INTEGER NOT NULL,expires_at INTEGER NOT NULL,details_json TEXT NOT NULL)').run();
});
beforeEach(async () => {
  provider.failCreate = false; provider.beforeResponse = null; provider.lookup = {status:'unknown'};
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const req = new Request(input, init), url = new URL(req.url);
    if (url.origin !== 'https://boundary.test') throw new Error('Unexpected outbound request');
    if (url.pathname === '/turnstile') return new Response('{}', {status:await req.text() === 'invalid' ? 400 : 200});
    if (url.pathname === '/create') return Response.json({url:'https://pay.test/checkout',providerId:(await req.json() as any).reference}, {status:provider.failCreate ? 504 : 200});
    if (url.pathname.startsWith('/lookup/')) return Response.json(provider.lookup);
    throw new Error('Unexpected provider route');
  });
  // Vitest 4 no longer rolls storage back between tests. Reset only the test database.
  for (const table of ['audit_logs','outbox_events','order_events','manual_review','payment_events','payment_attempts','inventory_movements','stock_reservations','order_items','checkout_requests','orders','preorder_campaigns','inventory','product_variants','products','shipping_quotes']) await sql(`DELETE FROM ${table}`).run();
  for (const path of ['/api/catalog','/api/catalog/product','/api/catalog/new-product','/api/catalog/preorder','/api/catalog?limit=1','/api/catalog?after=product&limit=1','/api/catalog?limit=1&after=product']) await caches.default.delete(new Request(`https://shop.test${path}`));
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
    expect((await read.json() as any).order.items[0].sku).toBe('SKU-A');
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
    const replies = await Promise.all([notify(order.reference), notify(order.reference)]);
    expect(replies.every(r => r.status === 200)).toBe(true);
    await notify(order.reference, 'expired', 'older-expiry');
    expect(await sql('SELECT status FROM orders WHERE id=?', order.id).first()).toEqual({ status: 'paid' });
    expect(await sql('SELECT status FROM payment_attempts WHERE order_id=?', order.id).first()).toEqual({ status: 'succeeded' });
    expect(await sql("SELECT on_hand,reserved FROM inventory WHERE variant_id='a'").first()).toEqual({ on_hand: 0, reserved: 0 });
    expect(await count('outbox_events')).toBe(1); expect(await count('inventory_movements')).toBe(1);
    await notify(order.reference, 'succeeded', 'another-confirmation');
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
    await sql('UPDATE payment_attempts SET checks=0,next_check=0').run();
    provider.lookup = {status:'expired',amount:1100,currency:'IDR'};
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
    expect((await request(`/api/orders/${order.reference}`, undefined, { 'X-Test-Customer': 'owner' })).status).toBe(200);
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
