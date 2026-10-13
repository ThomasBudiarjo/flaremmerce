import { z } from 'zod';
import { type CommerceEnv, HttpError, id, json, statement as s } from './types';
import { catalog } from './catalog';
import { operations } from './operations';

const variantInput = z.object({ sku: z.string().min(1).max(100), name: z.string().min(1).max(200), price: z.number().int().min(0).max(1_000_000_000), weight: z.number().int().min(1).max(1_000_000), mode: z.enum(['stock', 'preorder']).default('stock'), stock: z.number().int().min(0).max(1_000_000).default(0) }).strict();
const productInput = z.object({ slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100), name: z.string().min(1).max(200), description: z.string().max(10000).default(''), imageUrl: z.string().url().max(2000).optional(), variants: z.array(variantInput).min(1).max(30) }).strict();
const inventoryInput = z.object({ variantId: z.string().min(1).max(100), delta: z.number().int().min(-1_000_000).max(1_000_000).refine(v => v !== 0), reason: z.string().min(1).max(500) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const campaignInput = z.object({ variantId: z.string().min(1).max(100), startsAt: z.number().int().min(0), endsAt: z.number().int().min(0), shipFrom: date, shipTo: date, quota: z.number().int().min(0).max(1_000_000).nullable() }).strict().refine(v => v.endsAt > v.startsAt && v.shipTo >= v.shipFrom);
const fulfillmentInput = z.object({ status: z.enum(['processing', 'shipped', 'delivered']), tracking: z.string().trim().min(1).max(200).optional(), note: z.string().max(2000).optional() }).strict();
// Zod 4 applies defaults even inside optional fields: PATCH must not inherit create defaults.
const productUpdate = productInput.omit({variants:true}).extend({description:productInput.shape.description.unwrap(),active:z.boolean()}).partial().refine(v=>Object.keys(v).length>0);
const variantUpdate = variantInput.omit({stock:true}).extend({mode:variantInput.shape.mode.unwrap(),active:z.boolean()}).partial().refine(v=>Object.keys(v).length>0);
const campaignUpdate = z.object({startsAt:z.number().int().min(0),endsAt:z.number().int().min(0),shipFrom:date,shipTo:date,quota:z.number().int().min(0).max(1_000_000).nullable(),active:z.boolean()}).strict().partial().refine(v=>Object.keys(v).length>0);
const timelineInput = z.object({kind:z.enum(['preparing','production','ready_to_ship']),note:z.string().min(1).max(2000),estimatedDate:date.optional()}).strict();
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
  if (path === '/api/admin/operations' && request.method === 'GET') return operations(env);
  const before = Number(url.searchParams.get('before') ?? Date.now() + 1);
  const beforeId = url.searchParams.get('beforeId') ?? '';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(limit) || beforeId.length > 100) throw new HttpError(400, 'Invalid pagination');
  if (path === '/api/admin/products' && request.method === 'GET') {
    const response = await catalog(env,undefined,url.searchParams,true);
    response.headers.set('Cache-Control','private, no-store');
    return response;
  }
  const detail = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (detail && request.method === 'GET') {
    const target = decodeURIComponent(detail[1]);
    const row = await s(env,'SELECT id,reference,status,fulfillment,total,currency,created_at AS createdAt,contact_json,address_json,shipping_json FROM orders WHERE id=?',target).first();
    if (!row) throw new HttpError(404,'Order not found');
    const {contact_json,address_json,shipping_json,...summary} = row;
    const items = await s(env,'SELECT id,variant_id AS variantId,campaign_id AS campaignId,quantity,price,snapshot_json FROM order_items WHERE order_id=? ORDER BY id',target).all();
    const events = await s(env,'SELECT kind,details_json,created_at AS createdAt FROM order_events WHERE order_id=? ORDER BY created_at,id',target).all();
    const payment = await s(env,'SELECT status,checks,next_check AS nextCheck,created_at AS createdAt FROM payment_attempts WHERE order_id=?',target).first();
    return json({order:{...summary,contact:JSON.parse(String(contact_json)),address:JSON.parse(String(address_json)),shipping:JSON.parse(String(shipping_json)),items:items.results.map(({snapshot_json,...item})=>({...item,...JSON.parse(String(snapshot_json))})),timeline:events.results.map(({details_json,...event})=>({...event,details:JSON.parse(String(details_json))}))},payment});
  }
  if (path === '/api/admin/inventory' && request.method === 'GET') {
    const target = url.searchParams.get('variantId');
    if (!target || target.length>100) throw new HttpError(400,'variantId required');
    const inventory = await s(env,'SELECT variant_id AS variantId,on_hand AS onHand,reserved,on_hand-reserved AS available FROM inventory WHERE variant_id=?',target).first();
    if (!inventory) throw new HttpError(404,'Variant not found');
    const page = await s(env,'SELECT id,variant_id AS variantId,delta,reason,order_id AS orderId,actor,created_at AS createdAt FROM inventory_movements WHERE variant_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?',target,before,beforeId,limit+1).all();
    const movements = page.results.slice(0,limit), last=movements.at(-1);
    return json({inventory,movements,nextCursor:page.results.length>limit && last ? {before:last.createdAt,beforeId:last.id}:null});
  }
  if (path === '/api/admin/campaigns' && request.method === 'GET') {
    // Campaigns have no creation timestamp; paginate deterministically by start time and ID.
    const cutoff = url.searchParams.has('before') ? before : Number.MAX_SAFE_INTEGER;
    const page = await s(env,'SELECT c.id,c.variant_id AS variantId,v.sku,p.name AS productName,c.starts_at AS startsAt,c.ends_at AS endsAt,c.ship_from AS shipFrom,c.ship_to AS shipTo,c.quota,c.reserved,c.sold,c.active FROM preorder_campaigns c JOIN product_variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE (c.starts_at,c.id)<(?,?) ORDER BY c.starts_at DESC,c.id DESC LIMIT ?',cutoff,beforeId,limit+1).all();
    const rows=page.results.slice(0,limit),last=rows.at(-1);
    const campaigns=rows.map(row=>({...row,active:!!row.active}));
    return json({campaigns,nextCursor:page.results.length>limit && last ? {before:last.startsAt,beforeId:last.id}:null});
  }
  const campaignMatch = path.match(/^\/api\/admin\/campaigns\/([^/]+)$/);
  if (campaignMatch && request.method === 'PATCH') {
    const input=parse(campaignUpdate,body),target=decodeURIComponent(campaignMatch[1]);
    const columns:Record<string,string>={startsAt:'starts_at',endsAt:'ends_at',shipFrom:'ship_from',shipTo:'ship_to',quota:'quota',active:'active'};
    const fields=Object.entries(input);
    // DB CHECKs and overlap triggers validate the merged row, including concurrent counter changes.
    const result=await env.DB.batch([
      s(env,`UPDATE preorder_campaigns SET ${fields.map(([key])=>`${columns[key]}=?`).join(',')} WHERE id=?`,...fields.map(([,value])=>typeof value==='boolean'?Number(value):value as string|number|null),target),
      s(env,"INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'campaign.update',?,?,? WHERE changes()=1",id(),actor,target,JSON.stringify(input),Date.now()),
    ]);
    if (!result[0].meta.changes) throw new HttpError(404,'Campaign not found');
    return json({updated:true});
  }
  const addVariant=path.match(/^\/api\/admin\/products\/([^/]+)\/variants$/);
  if (addVariant && request.method === 'POST') {
    const input=parse(variantInput,body),target=decodeURIComponent(addVariant[1]),variantId=id();
    const result=await env.DB.batch([
      s(env,'INSERT INTO product_variants(id,product_id,sku,name,price,weight,mode) SELECT ?,id,?,?,?,?,? FROM products WHERE id=? AND (SELECT count(*) FROM product_variants WHERE product_id=products.id)<30',variantId,input.sku,input.name,input.price,input.weight,input.mode,target),
      s(env,'INSERT INTO inventory(variant_id,on_hand) SELECT id,? FROM product_variants WHERE id=?',input.stock,variantId),
      s(env,"INSERT INTO inventory_movements(id,variant_id,delta,reason,actor,created_at) SELECT ?,id,?,'initial stock',?,? FROM product_variants WHERE id=?",id(),input.stock,actor,Date.now(),variantId),
      s(env,"INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'variant.create',id,?,? FROM product_variants WHERE id=?",id(),actor,JSON.stringify(input),Date.now(),variantId),
    ]);
    if (!result[0].meta.changes) {
      if (!await s(env,'SELECT id FROM products WHERE id=?',target).first()) throw new HttpError(404,'Product not found');
      throw new HttpError(409,'Product variant limit reached');
    }
    return json({variant:{id:variantId,productId:target,...input}},201);
  }
  const update = path.match(/^\/api\/admin\/(products|variants)\/([^/]+)$/);
  if (update && request.method === 'PATCH') {
    const input = update[1] === 'products' ? parse(productUpdate,body) : parse(variantUpdate,body);
    const target = decodeURIComponent(update[2]), table = update[1] === 'products' ? 'products' : 'product_variants';
    const fields = Object.entries(input);
    const result = await env.DB.batch([
      s(env,`UPDATE ${table} SET ${fields.map(([name])=>`${name==='imageUrl' ? 'image_url':name}=?`).join(',')} WHERE id=?`,...fields.map(([,value])=>typeof value==='boolean' ? Number(value) : value as string|number),target),
      s(env,`INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1`,id(),actor,`${update[1]}.update`,target,JSON.stringify(input),Date.now()),
    ]);
    if (!result[0].meta.changes) throw new HttpError(404,'Catalog entry not found');
    return json({updated:true});
  }
  const milestone = path.match(/^\/api\/admin\/orders\/([^/]+)\/timeline$/);
  if (milestone && request.method === 'POST') {
    const input = parse(timelineInput,body), target = decodeURIComponent(milestone[1]), eventId=id();
    const result = await env.DB.batch([
      s(env,`INSERT INTO order_events(id,order_id,kind,details_json,created_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND status='paid'`,eventId,input.kind,JSON.stringify({note:input.note,estimatedDate:input.estimatedDate}),Date.now(),target),
      s(env,`INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'timeline.append',?,?,? WHERE EXISTS(SELECT 1 FROM order_events WHERE id=?)`,id(),actor,target,JSON.stringify(input),Date.now(),eventId),
    ]);
    if (!result[0].meta.changes) throw new HttpError(409,'Only paid orders accept preparation milestones');
    return json({recorded:true});
  }
  if (path === '/api/admin/orders' && request.method === 'GET') {
    const orders = await s(env, 'SELECT id,reference,status,fulfillment,total,currency,created_at AS createdAt,contact_json,address_json,shipping_json FROM orders WHERE created_at<? OR (created_at=? AND id<?) ORDER BY created_at DESC,id DESC LIMIT ?', before, before, beforeId, limit+1).all();
    const more = orders.results.length>limit;
    orders.results = orders.results.slice(0,limit);
    const last = orders.results.at(-1);
    return json({ orders: orders.results.map(({ contact_json, address_json, shipping_json, ...row }) => ({ ...row, contact: JSON.parse(String(contact_json)), address: JSON.parse(String(address_json)), shipping: JSON.parse(String(shipping_json)) })), nextCursor: more && last ? { before: last.createdAt, beforeId: last.id } : null });
  }
  if (path === '/api/admin/review' && request.method === 'GET') {
    const rows = await s(env, 'SELECT r.id,r.order_id AS orderId,r.reason,r.event_key AS eventKey,r.created_at AS createdAt,r.status,r.note,r.version,r.updated_at AS updatedAt,r.updated_by AS updatedBy,o.reference FROM manual_review r LEFT JOIN orders o ON o.id=r.order_id WHERE r.created_at<? OR (r.created_at=? AND r.id<?) ORDER BY r.created_at DESC,r.id DESC LIMIT ?', before, before, beforeId, limit+1).all();
    const more = rows.results.length>limit;
    rows.results = rows.results.slice(0,limit);
    const last = rows.results.at(-1);
    return json({ items: rows.results, nextCursor: more && last ? { before: last.createdAt, beforeId: last.id } : null });
  }
  const reviewMatch = path.match(/^\/api\/admin\/review\/([^/]+)$/);
  if (reviewMatch && (request.method === 'GET' || request.method === 'PATCH')) {
    const target = decodeURIComponent(reviewMatch[1]);
    const item = await s(env, 'SELECT id,order_id AS orderId,event_key AS eventKey,reason,created_at AS createdAt,status,note,version,updated_at AS updatedAt,updated_by AS updatedBy FROM manual_review WHERE id=?', target).first();
    if (!item) throw new HttpError(404, 'Review case not found');
    if (request.method === 'PATCH') {
      const input = parse(z.object({ version: z.number().int().min(0), status: z.enum(['open','resolved']), note: z.string().trim().min(1).max(2000) }).strict(), body);
      if (item.version !== input.version) throw new HttpError(409, 'Review changed; reload evidence before retrying');
      const now = Date.now();
      // The compare-and-swap and its append-only audit are one atomic D1 batch.
      // No payment/order/reservation/outbox tables are modified by operator review.
      const result = await env.DB.batch([
        s(env, 'UPDATE manual_review SET status=?,note=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?', input.status,input.note,now,actor,target,input.version),
        s(env, `INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'review.update',?,?,? WHERE changes()=1`,id(),actor,target,JSON.stringify({fromStatus:item.status,fromVersion:input.version,...input}),now),
      ]);
      if (!result[0].meta.changes) throw new HttpError(409, 'Review changed; reload evidence before retrying');
      return json({ updated: true, version: input.version + 1 });
    }
    const order = item.orderId ? await s(env, 'SELECT id,reference,status,fulfillment,total,currency,created_at AS createdAt FROM orders WHERE id=?', String(item.orderId)).first() : null;
    const attempt = item.orderId ? await s(env, 'SELECT id,reference,status,checks,next_check AS nextCheck,created_at AS createdAt FROM payment_attempts WHERE order_id=?', String(item.orderId)).first() : null;
    const triggeringEvent = item.eventKey ? await s(env, 'SELECT event_key AS eventKey,reference,amount,currency,status,processed,created_at AS createdAt FROM payment_events WHERE event_key=?', String(item.eventKey)).first() : null;
    const reference = attempt?.reference ?? triggeringEvent?.reference;
    const events = reference ? await s(env, 'SELECT event_key AS eventKey,reference,amount,currency,status,processed,created_at AS createdAt FROM payment_events WHERE reference=? AND event_key<>? ORDER BY created_at DESC,event_key DESC LIMIT 100', String(reference), String(item.eventKey ?? '')).all() : { results: [] };
    const history = await s(env, "SELECT actor,details_json,created_at AS createdAt FROM audit_logs WHERE target=? AND action='review.update' ORDER BY created_at DESC,id DESC LIMIT 100",target).all();
    return json({ item, order, attempt, triggeringEvent, events: events.results, history: history.results.map(({details_json,...row})=>({...row,details:JSON.parse(String(details_json))})) });
  }
  if (path === '/api/admin/products' && request.method === 'POST') {
    const p = parse(productInput, body), productId = id();
    const batch = [s(env, 'INSERT INTO products(id,slug,name,description,image_url) VALUES(?,?,?,?,?)', productId, p.slug, p.name, p.description, p.imageUrl ?? null)];
    // Bind a detached upload in the same transaction as creation, never steal another product's media.
    if (p.imageUrl) batch.push(s(env, 'UPDATE product_media SET product_id=? WHERE url=? AND product_id IS NULL', productId, p.imageUrl));
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
