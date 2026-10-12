import { z } from 'zod';
import { type CommerceEnv, HttpError, id, json, statement as s } from './types';

const variantInput = z.object({ sku: z.string().min(1).max(100), name: z.string().min(1).max(200), price: z.number().int().min(0).max(1_000_000_000), weight: z.number().int().min(1).max(1_000_000), mode: z.enum(['stock', 'preorder']).default('stock'), stock: z.number().int().min(0).max(1_000_000).default(0) }).strict();
const productInput = z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), name: z.string().min(1).max(200), description: z.string().max(10000).default(''), imageUrl: z.string().url().max(2000).optional(), variants: z.array(variantInput).min(1).max(30) }).strict();
const inventoryInput = z.object({ variantId: z.string().min(1).max(100), delta: z.number().int().min(-1_000_000).max(1_000_000).refine(v => v !== 0), reason: z.string().min(1).max(500) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const campaignInput = z.object({ variantId: z.string().min(1).max(100), startsAt: z.number().int().min(0), endsAt: z.number().int().min(0), shipFrom: date, shipTo: date, quota: z.number().int().min(0).max(1_000_000).nullable() }).strict().refine(v => v.endsAt > v.startsAt && v.shipTo >= v.shipFrom);
const fulfillmentInput = z.object({ status: z.enum(['processing', 'shipped', 'delivered']), tracking: z.string().trim().min(1).max(200).optional(), note: z.string().max(2000).optional() }).strict();
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, 'Invalid input', result.error.flatten());
  return result.data;
}
function audit(env: CommerceEnv, actor: string, action: string, target: string, details: unknown) {
  return s(env, 'INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) VALUES(?,?,?,?,?,?)', id(), actor, action, target, JSON.stringify(details), Date.now());
}
export async function admin(request: Request, env: CommerceEnv, actor: string, body: unknown) {
  const url = new URL(request.url), path = url.pathname;
  const before = Number(url.searchParams.get('before') ?? Date.now() + 1);
  const beforeId = url.searchParams.get('beforeId') ?? '';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(limit) || beforeId.length > 100) throw new HttpError(400, 'Invalid pagination');
  if (path === '/api/admin/orders' && request.method === 'GET') {
    const orders = await s(env, 'SELECT id,reference,status,fulfillment,total,currency,created_at AS createdAt,contact_json,address_json,shipping_json FROM orders WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT ?', before, before, beforeId, limit).all();
    const last = orders.results.at(-1);
    return json({ orders: orders.results.map(({ contact_json, address_json, shipping_json, ...row }) => ({ ...row, contact: JSON.parse(String(contact_json)), address: JSON.parse(String(address_json)), shipping: JSON.parse(String(shipping_json)) })), nextCursor: last ? { before: last.createdAt, beforeId: last.id } : null });
  }
  if (path === '/api/admin/review' && request.method === 'GET') {
    const rows = await s(env, 'SELECT r.id,r.order_id AS orderId,r.reason,r.event_key AS eventKey,r.created_at AS createdAt,o.reference FROM manual_review r LEFT JOIN orders o ON o.id=r.order_id WHERE r.created_at<? OR (r.created_at=? AND r.id<?) ORDER BY r.created_at DESC,r.id DESC LIMIT ?', before, before, beforeId, limit).all();
    const last = rows.results.at(-1);
    return json({ items: rows.results, nextCursor: last ? { before: last.createdAt, beforeId: last.id } : null });
  }
  if (path === '/api/admin/products' && request.method === 'POST') {
    const p = parse(productInput, body), productId = id();
    const batch = [s(env, 'INSERT INTO products(id,slug,name,description,image_url) VALUES(?,?,?,?,?)', productId, p.slug, p.name, p.description, p.imageUrl ?? null)];
    const variants = p.variants.map(v => ({ ...v, id: id() }));
    for (const v of variants) {
      batch.push(s(env, 'INSERT INTO product_variants(id,product_id,sku,name,price,weight,mode) VALUES(?,?,?,?,?,?,?)', v.id, productId, v.sku, v.name, v.price, v.weight, v.mode),
        s(env, 'INSERT INTO inventory(variant_id,on_hand) VALUES(?,?)', v.id, v.stock));
      if (v.stock) batch.push(s(env, 'INSERT INTO inventory_movements(id,variant_id,delta,reason,actor,created_at) VALUES(?,?,?,?,?,?)', id(), v.id, v.stock, 'initial stock', actor, Date.now()));
    }
    batch.push(audit(env, actor, 'product.create', productId, { variants: variants.map(v => v.id) }));
    await env.DB.batch(batch);
    return json({ product: { id: productId, ...p, variants } }, 201);
  }
  if (path === '/api/admin/inventory' && request.method === 'POST') {
    const v = parse(inventoryInput, body);
    // CHECK(on_hand >= reserved) aborts subtraction below held stock; missing variant aborts via ledger FK.
    await env.DB.batch([
      s(env, 'UPDATE inventory SET on_hand=on_hand+? WHERE variant_id=?', v.delta, v.variantId),
      s(env, 'INSERT INTO inventory_movements(id,variant_id,delta,reason,actor,created_at) VALUES(?,?,?,?,?,?)', id(), v.variantId, v.delta, v.reason, actor, Date.now()),
      audit(env, actor, 'inventory.adjust', v.variantId, v),
    ]);
    return json({ inventory: await s(env, 'SELECT variant_id AS variantId,on_hand AS onHand,reserved FROM inventory WHERE variant_id=?', v.variantId).first() });
  }
  if (path === '/api/admin/campaigns' && request.method === 'POST') {
    const c = parse(campaignInput, body), campaignId = id();
    const variant = await s(env, "SELECT id FROM product_variants WHERE id=? AND mode='preorder' AND active=1", c.variantId).first();
    if (!variant) throw new HttpError(409, 'Campaign requires active preorder variant');
    await env.DB.batch([
      s(env, 'INSERT INTO preorder_campaigns(id,variant_id,starts_at,ends_at,ship_from,ship_to,quota) VALUES(?,?,?,?,?,?,?)', campaignId, c.variantId, c.startsAt, c.endsAt, c.shipFrom, c.shipTo, c.quota),
      audit(env, actor, 'campaign.create', campaignId, c),
    ]);
    return json({ campaign: { id: campaignId, ...c } }, 201);
  }
  const match = path.match(/^\/api\/admin\/orders\/([^/]+)\/fulfillment$/);
  if (match && request.method === 'PATCH') {
    const f = parse(fulfillmentInput, body), orderId = decodeURIComponent(match[1]);
    if (f.status === 'shipped' && !f.tracking) throw new HttpError(400, 'Tracking required for shipped');
    const previous = f.status === 'processing' ? 'unfulfilled' : f.status === 'shipped' ? 'processing' : 'shipped';
    const eventId = id(), now = Date.now();
    // changes() is the previous conditional UPDATE's affected rows. Only its winner appends
    // the timeline+audit, inside the same atomic batch. Repeating a stale transition is a no-op.
    const results = await env.DB.batch([
      s(env, `UPDATE orders SET fulfillment=?,status=CASE WHEN ?='delivered' THEN 'completed' ELSE status END WHERE id=? AND status='paid' AND fulfillment=? RETURNING id`, f.status, f.status, orderId, previous),
      s(env, `INSERT INTO order_events(id,order_id,kind,details_json,created_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND fulfillment=? AND changes()=1`, eventId, f.status, JSON.stringify({ tracking: f.tracking, note: f.note }), now, orderId, f.status),
      s(env, `INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'fulfillment.update',?,?,? WHERE EXISTS(SELECT 1 FROM order_events WHERE id=?)`, id(), actor, orderId, JSON.stringify(f), now, eventId),
    ]);
    if (!results[0].meta.changes) throw new HttpError(409, 'Order not paid or invalid fulfillment transition');
    return json({ order: { id: orderId, fulfillment: f.status, status: f.status === 'delivered' ? 'completed' : 'paid' } });
  }
  throw new HttpError(404, 'Endpoint not found');
}
