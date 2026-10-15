import { z } from 'zod';
import { type CommerceEnv, HttpError, id, json, numberedPage, page, statement as s } from './types';
import { catalog } from './catalog';
import { operations } from './operations';
import { cancelOrder } from './cancel';
import { EXHAUSTED } from './payments';
import { type AdminRole, envCount, likeFits, likePattern, orderTracking, validSlug, normalizeEmail, normalizePhone, riskHash, riskSecret } from '../shared';
import { categoryList } from './catalog';
import { exportOrders, LOW_STOCK, orderFilter, orderPage, summary } from './reports';

const purchaseLimit = z.number().int().min(1).max(1_000_000).nullable().optional();
const dimension = z.number().int().min(1).max(300).nullable().optional();
const variantInput = z.object({ sku: z.string().min(1).max(100), name: z.string().min(1).max(200), price: z.number().int().min(0).max(1_000_000_000), weight: z.number().int().min(1).max(1_000_000), mode: z.enum(['stock', 'preorder']).default('stock'), stock: z.number().int().min(0).max(1_000_000).default(0), maxPerOrder: purchaseLimit, maxPerCustomer: purchaseLimit,
  lengthCm: dimension, widthCm: dimension, heightCm: dimension, lowStockThreshold: z.number().int().min(0).max(1_000_000).nullable().optional() }).strict();
const productInput = z.object({ slug: z.string().refine(validSlug), name: z.string().min(1).max(200), description: z.string().max(10000).default(''), imageUrl: z.string().url().max(2000).optional(), categoryId: z.string().min(1).max(100).nullable().optional(), variants: z.array(variantInput).min(1).max(30) }).strict();
const version = z.number().int().min(0);
const categoryInput = z.object({ slug: z.string().refine(validSlug), name: z.string().trim().min(1).max(100), position: z.number().int().min(0).max(100_000).default(0), active: z.boolean().default(true) }).strict();
const categoryUpdate = z.object({ slug: z.string().refine(validSlug), name: z.string().trim().min(1).max(100), position: z.number().int().min(0).max(100_000), active: z.boolean() }).strict().partial().extend({ version });
const inventoryInput = z.object({ variantId: z.string().min(1).max(100), delta: z.number().int().min(-1_000_000).max(1_000_000).refine(v => v !== 0), reason: z.string().min(1).max(500) }).strict();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v);
const campaignInput = z.object({ variantId: z.string().min(1).max(100), startsAt: z.number().int().min(0), endsAt: z.number().int().min(0), shipFrom: date, shipTo: date, quota: z.number().int().min(0).max(1_000_000).nullable() }).strict().refine(v => v.endsAt > v.startsAt && v.shipTo >= v.shipFrom);
const fulfillmentInput = z.object({ status: z.enum(['processing', 'shipped', 'delivered']), tracking: z.string().trim().min(1).max(200).optional(), courier: z.string().trim().toLowerCase().regex(/^[a-z0-9-]{1,30}$/).optional(), note: z.string().max(2000).optional() }).strict();
// Zod 4 applies defaults even inside optional fields: PATCH must not inherit create defaults.
// Every PATCH carries the version it was edited from (compare-and-swap) plus at least one field.
const changed = (v: object) => Object.keys(v).some(key => key !== 'version');
const productUpdate = productInput.omit({variants:true}).extend({description:productInput.shape.description.unwrap(),active:z.boolean()}).partial().extend({version}).refine(changed);
const variantUpdate = variantInput.omit({stock:true}).extend({mode:variantInput.shape.mode.unwrap(),active:z.boolean()}).partial().extend({version}).refine(changed);
const campaignUpdate = z.object({startsAt:z.number().int().min(0),endsAt:z.number().int().min(0),shipFrom:date,shipTo:date,quota:z.number().int().min(0).max(1_000_000).nullable(),active:z.boolean()}).strict().partial().extend({version}).refine(changed);
const timelineInput = z.object({kind:z.enum(['preparing','production','ready_to_ship']),note:z.string().min(1).max(2000),estimatedDate:date.optional()}).strict();
const reviewUpdate = z.object({ version: z.number().int().min(0), status: z.enum(['open','resolved']), note: z.string().trim().min(1).max(2000), action: z.literal('cancel_order').optional() }).strict();
const cancelInput = z.object({ reason: z.string().trim().min(1).max(500).optional(), confirmNoPayment: z.literal(true).optional() }).strict().refine(v => !v.confirmNoPayment || v.reason, { message: 'reason required with confirmNoPayment' });
const blockInput = z.object({ kind: z.enum(['email', 'phone', 'ip']), value: z.string().trim().min(1).max(254), reason: z.string().trim().min(1).max(500) }).strict();
const blockOrderInput = z.object({ kinds: z.array(z.enum(['email', 'phone', 'ip'])).min(1).max(3), reason: z.string().trim().min(1).max(500) }).strict();
const columns: Record<string, string> = { imageUrl: 'image_url', maxPerOrder: 'max_per_order', maxPerCustomer: 'max_per_customer', categoryId: 'category_id', lengthCm: 'length_cm', widthCm: 'width_cm', heightCm: 'height_cm', lowStockThreshold: 'low_stock_threshold' };
const openReasons = "(SELECT group_concat(reason) FROM manual_review r WHERE r.order_id=orders.id AND r.status='open') AS openReasons";
const hold = <T extends Record<string, unknown>>({ openReasons: reasons, ...row }: T) => ({ ...row, hold: !!reasons, openReviewReasons: reasons ? [...new Set(String(reasons).split(','))] : [] });
/** Product images must be objects served from the configured public media origin. */
function mediaUrl(env: CommerceEnv, value: string | undefined) {
  if (value === undefined) return;
  let media: URL;
  try { media = new URL(env.MEDIA_ORIGIN ?? ''); } catch { throw new HttpError(400, 'imageUrl must use MEDIA_ORIGIN'); }
  const url = new URL(value);
  if (url.origin !== media.origin || url.username || url.password) throw new HttpError(400, 'imageUrl must use MEDIA_ORIGIN');
}
function blockValue(kind: 'email' | 'phone' | 'ip', value: string) {
  if (kind === 'email') {
    if (!z.string().email().safeParse(value).success) throw new HttpError(400, 'Invalid email');
    return normalizeEmail(value);
  }
  if (kind === 'phone') {
    const phone = normalizePhone(value);
    if (!phone) throw new HttpError(400, 'Nomor HP tidak valid');
    return phone;
  }
  if (!/^[0-9a-fA-F:.]{2,45}$/.test(value)) throw new HttpError(400, 'Invalid IP address');
  return value.toLowerCase();
}
// The exhaustion sentinel is a scan-range device, not a schedule.
const nextCheck = `CASE WHEN next_check>=${EXHAUSTED} THEN NULL ELSE next_check END AS nextCheck`;
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, 'Invalid input', result.error.flatten());
  return result.data;
}
function audit(env: CommerceEnv, actor: string, action: string, target: string, details: unknown) {
  return s(env, 'INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) VALUES(?,?,?,?,?,?)', id(), actor, action, target, JSON.stringify(details), Date.now());
}
const bool = (row: Record<string, unknown> | null, ...keys: string[]) => row && Object.fromEntries(Object.entries(row).map(([k, v]) => [k, keys.includes(k) ? !!v : v]));
export const productEntity = async (env: CommerceEnv, target: string) => bool(await s(env, 'SELECT id,slug,name,description,image_url AS imageUrl,active,category_id AS categoryId,version FROM products WHERE id=?', target).first(), 'active');
export const variantEntity = async (env: CommerceEnv, target: string) => bool(await s(env, `SELECT v.id,v.product_id AS productId,v.sku,v.name,v.price,v.weight,v.mode,v.active,v.max_per_order AS maxPerOrder,v.max_per_customer AS maxPerCustomer,
  v.length_cm AS lengthCm,v.width_cm AS widthCm,v.height_cm AS heightCm,v.low_stock_threshold AS lowStockThreshold,v.version,i.on_hand AS onHand,i.reserved FROM product_variants v LEFT JOIN inventory i ON i.variant_id=v.id WHERE v.id=?`, target).first(), 'active');
const campaignColumns = 'c.id,c.variant_id AS variantId,v.sku,p.id AS productId,p.name AS productName,c.starts_at AS startsAt,c.ends_at AS endsAt,c.ship_from AS shipFrom,c.ship_to AS shipTo,c.quota,c.reserved,c.sold,c.active,c.version';
export const campaignEntity = async (env: CommerceEnv, target: string) => bool(await s(env, `SELECT ${campaignColumns} FROM preorder_campaigns c JOIN product_variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE c.id=?`, target).first(), 'active');
const categoryEntity = async (env: CommerceEnv, target: string) => bool(await s(env, 'SELECT id,slug,name,position,active,version FROM categories WHERE id=?', target).first(), 'active');
/** Compare-and-swap UPDATE plus audit in one batch; a lost race returns the current entity so the editor can rebase. */
async function casUpdate(env: CommerceEnv, actor: string, table: string, action: string, target: string, input: Record<string, unknown>, map: Record<string, string>, entity: (env: CommerceEnv, id: string) => Promise<unknown>) {
  const { version: expected, ...changes } = input, fields = Object.entries(changes);
  const [result] = await env.DB.batch([
    s(env, `UPDATE ${table} SET ${fields.map(([name]) => `${map[name] ?? name}=?`).join(',')},version=version+1 WHERE id=? AND version=?`, ...fields.map(([, value]) => typeof value === 'boolean' ? Number(value) : value as string | number | null), target, expected as number),
    s(env, 'INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,?,?,?,? WHERE changes()=1', id(), actor, action, target, JSON.stringify(input), Date.now()),
  ]);
  const current = await entity(env, target);
  if (!current) throw new HttpError(404, 'Catalog entry not found');
  if (!result.meta.changes) throw new HttpError(409, 'Data sudah diubah oleh admin lain; muat ulang sebelum menyimpan', { current });
  return current;
}
export async function admin(request: Request, env: CommerceEnv, actor: string, body: unknown, role: AdminRole = 'owner') {
  const url = new URL(request.url), path = url.pathname;
  if (path === '/api/admin/operations' && request.method === 'GET') return operations(env);
  if (path === '/api/admin/summary' && request.method === 'GET') return summary(env, url);
  if (path === '/api/admin/orders/export.csv' && request.method === 'GET') return exportOrders(env, actor, url.searchParams);
  if (path === '/api/admin/categories' && request.method === 'GET') {
    // Counts include archived products: they still block deleting the category.
    const [list, used] = await Promise.all([categoryList(env, true), s(env, 'SELECT category_id AS id,count(*) AS n FROM products WHERE category_id IS NOT NULL GROUP BY category_id').all<{ id: string; n: number }>()]);
    const counts = new Map(used.results.map(row => [row.id, row.n]));
    return json({ categories: list.map(category => ({ ...category, productCount: counts.get(category.id) ?? 0 })) });
  }
  if (path === '/api/admin/categories' && request.method === 'POST') {
    const input = parse(categoryInput, body), categoryId = id();
    await env.DB.batch([
      s(env, 'INSERT INTO categories(id,slug,name,position,active) VALUES(?,?,?,?,?)', categoryId, input.slug, input.name, input.position, Number(input.active)),
      audit(env, actor, 'category.create', categoryId, input),
    ]);
    return json({ category: await categoryEntity(env, categoryId) }, 201);
  }
  const categoryMatch = path.match(/^\/api\/admin\/categories\/([^/]+)$/);
  if (categoryMatch && request.method === 'PATCH') {
    const target = decodeURIComponent(categoryMatch[1]);
    return json({ category: await casUpdate(env, actor, 'categories', 'category.update', target, parse(categoryUpdate.refine(changed), body), {}, categoryEntity) });
  }
  if (categoryMatch && request.method === 'DELETE') {
    const target = decodeURIComponent(categoryMatch[1]);
    if (await s(env, 'SELECT 1 AS used FROM products WHERE category_id=? LIMIT 1', target).first('used')) throw new HttpError(409, 'Kategori masih dipakai produk; pindahkan produk terlebih dahulu');
    // Audit first while the row exists; the guarded DELETE in the same batch removes exactly that row.
    const [audited] = await env.DB.batch([
      s(env, "INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'category.delete',id,json_object('slug',slug,'name',name),? FROM categories WHERE id=?", id(), actor, Date.now(), target),
      s(env, 'DELETE FROM categories WHERE id=? AND NOT EXISTS(SELECT 1 FROM products WHERE category_id=?)', target, target),
    ]);
    if (!audited.meta.changes) throw new HttpError(404, 'Category not found');
    return json({ deleted: true });
  }
  if (path === '/api/admin/variants/search' && request.method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim(), mode = url.searchParams.get('mode');
    if (!q || q.length > 60 || !likeFits(q.toLowerCase())) throw new HttpError(400, 'Search term must be 1–60 characters and fit a 50-byte pattern');
    if (mode !== null && mode !== 'stock' && mode !== 'preorder') throw new HttpError(400, 'Invalid mode');
    const like = likePattern(q.toLowerCase());
    // Exact SKU first; bounded scan otherwise (LIMIT 20) over a catalog capped at 30 variants per product.
    const { results } = await s(env, `SELECT v.id,v.sku,v.name,v.mode,v.price,v.active,p.id AS productId,p.name AS productName FROM product_variants v JOIN products p ON p.id=v.product_id
      WHERE (v.sku=? COLLATE NOCASE OR v.sku LIKE ? ESCAPE '\\' OR v.name LIKE ? ESCAPE '\\' OR p.name LIKE ? ESCAPE '\\')${mode ? ' AND v.mode=?' : ''} ORDER BY v.sku=? COLLATE NOCASE DESC,v.sku LIMIT 20`,
      q, like, like, like, ...(mode ? [mode] : []), q).all();
    return json({ variants: results.map(row => bool(row, 'active')) });
  }
  if (path === '/api/admin/inventory' && request.method === 'GET' && url.searchParams.get('low') === '1') {
    const { results } = await s(env, `SELECT v.id AS variantId,v.sku,v.name,p.id AS productId,p.name AS productName,i.on_hand AS onHand,i.reserved,i.on_hand-i.reserved AS available,coalesce(v.low_stock_threshold,?1) AS threshold
      FROM product_variants v JOIN inventory i ON i.variant_id=v.id JOIN products p ON p.id=v.product_id WHERE ${LOW_STOCK.replace('?', '?1')} ORDER BY available,v.sku LIMIT 100`, envCount(env.LOW_STOCK_DEFAULT, 5)).all();
    return json({ lowStock: results });
  }
  const before = Number(url.searchParams.get('before') ?? Date.now() + 1);
  const beforeId = url.searchParams.get('beforeId') ?? '';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(limit) || beforeId.length > 100) throw new HttpError(400, 'Invalid pagination');
  if (path === '/api/admin/products' && request.method === 'GET') {
    // Parsed here, outside catalogQuery, so public catalog cache keys never vary by it.
    const status = url.searchParams.get('status') || 'all';
    if (!['all', 'active', 'archived'].includes(status)) throw new HttpError(400, 'Invalid status filter');
    const response = await catalog(env,undefined,url.searchParams,true,status === 'all' ? undefined : status === 'active');
    response.headers.set('Cache-Control','private, no-store');
    return response;
  }
  const productDetail = path.match(/^\/api\/admin\/products\/([^/]+)$/);
  if (productDetail && request.method === 'GET') {
    // The editor deep-links by ID; the catalog reader is keyed by slug and already includes inactive data for admins.
    const slug = await s(env,'SELECT slug FROM products WHERE id=?',decodeURIComponent(productDetail[1])).first<string>('slug');
    if (!slug) throw new HttpError(404,'Product not found');
    const response = await catalog(env,slug,undefined,true);
    response.headers.set('Cache-Control','private, no-store');
    return response;
  }
  const detail = path.match(/^\/api\/admin\/orders\/([^/]+)$/);
  if (detail && request.method === 'GET') {
    const target = decodeURIComponent(detail[1]);
    const row = await s(env,`SELECT id,reference,status,fulfillment,total,currency,created_at AS createdAt,contact_json,address_json,shipping_json,${openReasons} FROM orders WHERE id=?`,target).first();
    if (!row) throw new HttpError(404,'Order not found');
    // Contact and address are PII: every admin read is recorded before it is returned.
    await audit(env, actor, 'order.view', target, {}).run();
    const {contact_json,address_json,shipping_json,...summary} = hold(row);
    const items = await s(env,'SELECT id,variant_id AS variantId,campaign_id AS campaignId,quantity,price,snapshot_json FROM order_items WHERE order_id=? ORDER BY id',target).all();
    const events = await s(env,'SELECT kind,details_json,created_at AS createdAt FROM order_events WHERE order_id=? ORDER BY created_at,id',target).all();
    const payment = await s(env,`SELECT status,checks,${nextCheck},created_at AS createdAt FROM payment_attempts WHERE order_id=?`,target).first();
    const shipping = JSON.parse(String(shipping_json));
    return json({order:{...summary,contact:JSON.parse(String(contact_json)),address:JSON.parse(String(address_json)),shipping,tracking:orderTracking(events.results,shipping),items:items.results.map(({snapshot_json,...item})=>({...item,...JSON.parse(String(snapshot_json))})),timeline:events.results.map(({details_json,...event})=>({...event,details:JSON.parse(String(details_json))}))},payment});
  }
  if (path === '/api/admin/inventory' && request.method === 'GET') {
    const target = url.searchParams.get('variantId');
    if (!target || target.length>100) throw new HttpError(400,'variantId required');
    const inventory = await s(env,'SELECT variant_id AS variantId,on_hand AS onHand,reserved,on_hand-reserved AS available FROM inventory WHERE variant_id=?',target).first();
    if (!inventory) throw new HttpError(404,'Variant not found');
    const rows = await s(env,'SELECT id,variant_id AS variantId,delta,reason,order_id AS orderId,actor,created_at AS createdAt FROM inventory_movements WHERE variant_id=? AND (created_at,id)<(?,?) ORDER BY created_at DESC,id DESC LIMIT ?',target,before,beforeId,limit+1).all();
    const { items: movements, nextCursor } = page(rows.results,limit,last=>({before:last.createdAt,beforeId:last.id}));
    return json({inventory,movements,nextCursor});
  }
  if (path === '/api/admin/campaigns' && request.method === 'GET') {
    // Campaigns have no creation timestamp; paginate deterministically by start time and ID.
    // Phases mirror the admin badge: inactive campaigns only appear under "all".
    const phase = url.searchParams.get('phase') || 'all', now = Date.now();
    const phases: Record<string, [string, number[]]> = { all: ['1=1', []], running: ['c.active=1 AND c.starts_at<=? AND c.ends_at>?', [now, now]], upcoming: ['c.active=1 AND c.starts_at>?', [now]], ended: ['c.active=1 AND c.ends_at<=?', [now]] };
    if (!Object.hasOwn(phases, phase)) throw new HttpError(400, 'Invalid phase filter');
    const [filter, values] = phases[phase], numbered = numberedPage(url.searchParams);
    const from = `FROM preorder_campaigns c JOIN product_variants v ON v.id=c.variant_id JOIN products p ON p.id=v.product_id WHERE ${filter}`;
    const [rows, total] = await Promise.all([
      numbered
        ? s(env,`SELECT ${campaignColumns} ${from} ORDER BY c.starts_at DESC,c.id DESC LIMIT ? OFFSET ?`,...values,limit+1,(numbered-1)*limit).all()
        : s(env,`SELECT ${campaignColumns} ${from} AND (c.starts_at,c.id)<(?,?) ORDER BY c.starts_at DESC,c.id DESC LIMIT ?`,...values,before,beforeId,limit+1).all(),
      numbered ? s(env,`SELECT count(*) AS n FROM preorder_campaigns c WHERE ${filter}`,...values).first<number>('n') : null,
    ]);
    const { items, nextCursor } = page(rows.results,limit,last=>({before:last.startsAt,beforeId:last.id}));
    return json({campaigns:items.map(row=>({...row,active:!!row.active})),nextCursor,...(numbered ? {page:numbered,total} : {})});
  }
  const campaignMatch = path.match(/^\/api\/admin\/campaigns\/([^/]+)$/);
  if (campaignMatch && request.method === 'PATCH') {
    const input=parse(campaignUpdate,body),target=decodeURIComponent(campaignMatch[1]);
    const columns:Record<string,string>={startsAt:'starts_at',endsAt:'ends_at',shipFrom:'ship_from',shipTo:'ship_to',quota:'quota',active:'active'};
    const {version:expected,...changes}=input, fields=Object.entries(changes), auditId=id(), now=Date.now();
    // DB CHECKs and overlap triggers validate the merged row, including concurrent counter changes.
    // Snapshots keep the original promise; a changed estimate is announced on each affected order.
    const result=await env.DB.batch([
      s(env,`UPDATE preorder_campaigns SET ${fields.map(([key])=>`${columns[key]}=?`).join(',')},version=version+1 WHERE id=? AND version=?`,...fields.map(([,value])=>typeof value==='boolean'?Number(value):value as string|number|null),target,expected),
      s(env,"INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'campaign.update',?,?,? WHERE changes()=1",auditId,actor,target,JSON.stringify(input),now),
      ...(input.shipFrom !== undefined || input.shipTo !== undefined ? [s(env,`INSERT INTO order_events(id,order_id,kind,details_json,created_at)
        SELECT ? || ':' || o.id,o.id,'campaign_updated',json_object('campaignId',c.id,'shipFrom',c.ship_from,'shipTo',c.ship_to),? FROM preorder_campaigns c JOIN orders o ON o.id IN (SELECT order_id FROM order_items WHERE campaign_id=c.id)
        WHERE c.id=? AND o.status<>'cancelled' AND EXISTS(SELECT 1 FROM audit_logs WHERE id=?)`,auditId,now,target,auditId)] : []),
    ]);
    const current=await campaignEntity(env,target);
    if (!current) throw new HttpError(404,'Campaign not found');
    if (!result[0].meta.changes) throw new HttpError(409,'Data sudah diubah oleh admin lain; muat ulang sebelum menyimpan',{current});
    return json({updated:true,campaign:current});
  }
  const addVariant=path.match(/^\/api\/admin\/products\/([^/]+)\/variants$/);
  if (addVariant && request.method === 'POST') {
    const input=parse(variantInput,body),target=decodeURIComponent(addVariant[1]),variantId=id();
    const result=await env.DB.batch([
      s(env,'INSERT INTO product_variants(id,product_id,sku,name,price,weight,mode,max_per_order,max_per_customer,length_cm,width_cm,height_cm,low_stock_threshold) SELECT ?,id,?,?,?,?,?,?,?,?,?,?,? FROM products WHERE id=? AND (SELECT count(*) FROM product_variants WHERE product_id=products.id)<30',variantId,input.sku,input.name,input.price,input.weight,input.mode,input.maxPerOrder ?? null,input.maxPerCustomer ?? null,input.lengthCm ?? null,input.widthCm ?? null,input.heightCm ?? null,input.lowStockThreshold ?? null,target),
      s(env,'INSERT INTO inventory(variant_id,on_hand) SELECT id,? FROM product_variants WHERE id=?',input.stock,variantId),
      s(env,"INSERT INTO inventory_movements(id,variant_id,delta,reason,actor,created_at) SELECT ?,id,?,'initial stock',?,? FROM product_variants WHERE id=?",id(),input.stock,actor,Date.now(),variantId),
      s(env,"INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'variant.create',id,?,? FROM product_variants WHERE id=?",id(),actor,JSON.stringify(input),Date.now(),variantId),
    ]);
    if (!result[0].meta.changes) {
      if (!await s(env,'SELECT id FROM products WHERE id=?',target).first()) throw new HttpError(404,'Product not found');
      throw new HttpError(409,'Product variant limit reached');
    }
    return json({variant:await variantEntity(env,variantId)},201);
  }
  const update = path.match(/^\/api\/admin\/(products|variants)\/([^/]+)$/);
  if (update && request.method === 'PATCH') {
    const input = update[1] === 'products' ? parse(productUpdate,body) : parse(variantUpdate,body);
    if ('imageUrl' in input) mediaUrl(env, input.imageUrl);
    const target = decodeURIComponent(update[2]), products = update[1] === 'products';
    const current = await casUpdate(env, actor, products ? 'products' : 'product_variants', `${update[1]}.update`, target, input, columns, products ? productEntity : variantEntity);
    return json({updated:true, [products ? 'product' : 'variant']:current});
  }
  const cancelMatch = path.match(/^\/api\/admin\/orders\/([^/]+)\/cancel$/);
  if (cancelMatch && request.method === 'POST') {
    const input = parse(cancelInput, body), target = decodeURIComponent(cancelMatch[1]);
    if (input.confirmNoPayment && role !== 'owner') throw new HttpError(403, 'Only an owner may cancel without provider confirmation');
    const outcome = await cancelOrder(env, target, {kind:'admin', actor, reason:input.reason, force:!!input.confirmNoPayment});
    if (outcome.order.status !== 'cancelled') throw new HttpError(409, 'Payment already succeeded; order cannot be cancelled');
    return json({order:outcome.order, cancelled:outcome.changed});
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
    const rows = await orderPage(env, await orderFilter(env, url.searchParams), `id,reference,status,fulfillment,total,currency,created_at AS createdAt,contact_json,address_json,shipping_json,${openReasons}`, before, beforeId, limit+1);
    const { items, nextCursor } = page(rows.results, limit, last => ({ before: last.createdAt, beforeId: last.id }));
    return json({ orders: items.map(hold).map(({ contact_json, address_json, shipping_json, ...row }) => ({ ...row, contact: JSON.parse(String(contact_json)), address: JSON.parse(String(address_json)), shipping: JSON.parse(String(shipping_json)) })), nextCursor });
  }
  if (path === '/api/admin/review' && request.method === 'GET') {
    const status = url.searchParams.get('status') || null;
    if (status !== null && status !== 'open' && status !== 'resolved') throw new HttpError(400, 'Invalid status filter');
    const rows = await s(env, `SELECT r.id,r.order_id AS orderId,r.reason,r.event_key AS eventKey,r.created_at AS createdAt,r.status,r.note,r.version,r.updated_at AS updatedAt,r.updated_by AS updatedBy,o.reference FROM manual_review r LEFT JOIN orders o ON o.id=r.order_id WHERE ${status ? 'r.status=? AND ' : ''}(r.created_at<? OR (r.created_at=? AND r.id<?)) ORDER BY r.created_at DESC,r.id DESC LIMIT ?`, ...(status ? [status] : []), before, before, beforeId, limit+1).all();
    return json(page(rows.results, limit, last => ({ before: last.createdAt, beforeId: last.id })));
  }
  const reviewMatch = path.match(/^\/api\/admin\/review\/([^/]+)$/);
  if (reviewMatch && (request.method === 'GET' || request.method === 'PATCH')) {
    const target = decodeURIComponent(reviewMatch[1]);
    const item = await s(env, 'SELECT id,order_id AS orderId,event_key AS eventKey,reason,created_at AS createdAt,status,note,version,updated_at AS updatedAt,updated_by AS updatedBy FROM manual_review WHERE id=?', target).first();
    if (!item) throw new HttpError(404, 'Review case not found');
    if (request.method === 'PATCH') {
      const input = parse(reviewUpdate, body);
      if (item.version !== input.version) throw new HttpError(409, 'Review changed; reload evidence before retrying');
      const now = Date.now(), { action, ...change } = input;
      // The compare-and-swap and its append-only audit are one atomic D1 batch.
      const statements = [
        s(env, `UPDATE manual_review SET status=?,note=?,version=version+1,updated_at=?,updated_by=? WHERE id=? AND version=?${action ? " AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status IN ('pending_payment','cancelled'))" : ''}`, change.status,change.note,now,actor,target,change.version,...(action ? [String(item.orderId)] : [])),
        s(env, `INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'review.update',?,?,? WHERE changes()=1`,id(),actor,target,JSON.stringify({fromStatus:item.status,fromVersion:input.version,...input}),now),
      ];
      // Without an action no payment/order/reservation/outbox table is touched. cancel_order runs the
      // admin cancel path in the same batch, gated on this CAS winning: both happen or neither.
      if (action === 'cancel_order') {
        if (!item.orderId) throw new HttpError(409, 'Review case has no order to cancel');
        const outcome = await cancelOrder(env, String(item.orderId), { kind: 'admin', actor, reason: `review:${target}` },
          { before: statements, condition: ' AND EXISTS(SELECT 1 FROM manual_review WHERE id=? AND version=? AND updated_at=? AND updated_by=?)', values: [target, input.version + 1, now, actor] });
        if (!outcome.results[0].meta.changes) throw new HttpError(409, 'Review or order changed; reload evidence before retrying');
        return json({ updated: true, version: input.version + 1, order: outcome.order });
      }
      const result = await env.DB.batch(statements);
      if (!result[0].meta.changes) throw new HttpError(409, 'Review changed; reload evidence before retrying');
      return json({ updated: true, version: input.version + 1 });
    }
    const order = item.orderId ? await s(env, 'SELECT id,reference,status,fulfillment,total,currency,created_at AS createdAt FROM orders WHERE id=?', String(item.orderId)).first() : null;
    const attempt = item.orderId ? await s(env, `SELECT id,reference,status,checks,${nextCheck},created_at AS createdAt FROM payment_attempts WHERE order_id=?`, String(item.orderId)).first() : null;
    const triggeringEvent = item.eventKey ? await s(env, 'SELECT event_key AS eventKey,reference,amount,currency,status,processed,created_at AS createdAt FROM payment_events WHERE event_key=?', String(item.eventKey)).first() : null;
    const reference = attempt?.reference ?? triggeringEvent?.reference;
    const events = reference ? await s(env, 'SELECT event_key AS eventKey,reference,amount,currency,status,processed,created_at AS createdAt FROM payment_events WHERE reference=? AND event_key<>? ORDER BY created_at DESC,event_key DESC LIMIT 100', String(reference), String(item.eventKey ?? '')).all() : { results: [] };
    const history = await s(env, "SELECT actor,details_json,created_at AS createdAt FROM audit_logs WHERE target=? AND action='review.update' ORDER BY created_at DESC,id DESC LIMIT 100",target).all();
    return json({ item, order, attempt, triggeringEvent, events: events.results, history: history.results.map(({details_json,...row})=>({...row,details:JSON.parse(String(details_json))})) });
  }
  if (path === '/api/admin/products' && request.method === 'POST') {
    const p = parse(productInput, body), productId = id();
    mediaUrl(env, p.imageUrl);
    const batch = [s(env, 'INSERT INTO products(id,slug,name,description,image_url,category_id) VALUES(?,?,?,?,?,?)', productId, p.slug, p.name, p.description, p.imageUrl ?? null, p.categoryId ?? null)];
    // Bind a detached upload in the same transaction as creation, never steal another product's media.
    if (p.imageUrl) batch.push(s(env, 'UPDATE product_media SET product_id=? WHERE url=? AND product_id IS NULL', productId, p.imageUrl));
    const variants = p.variants.map(v => ({ ...v, id: id() }));
    for (const v of variants) {
      batch.push(s(env, 'INSERT INTO product_variants(id,product_id,sku,name,price,weight,mode,max_per_order,max_per_customer,length_cm,width_cm,height_cm,low_stock_threshold) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)', v.id, productId, v.sku, v.name, v.price, v.weight, v.mode, v.maxPerOrder ?? null, v.maxPerCustomer ?? null, v.lengthCm ?? null, v.widthCm ?? null, v.heightCm ?? null, v.lowStockThreshold ?? null),
        s(env, 'INSERT INTO inventory(variant_id,on_hand) VALUES(?,?)', v.id, v.stock));
      if (v.stock) batch.push(s(env, 'INSERT INTO inventory_movements(id,variant_id,delta,reason,actor,created_at) VALUES(?,?,?,?,?,?)', id(), v.id, v.stock, 'initial stock', actor, Date.now()));
    }
    batch.push(audit(env, actor, 'product.create', productId, { variants: variants.map(v => v.id) }));
    await env.DB.batch(batch);
    return json({ product: { ...await productEntity(env, productId), variants: await Promise.all(variants.map(v => variantEntity(env, v.id))) } }, 201);
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
    return json({ campaign: await campaignEntity(env, campaignId) }, 201);
  }
  const match = path.match(/^\/api\/admin\/orders\/([^/]+)\/fulfillment$/);
  if (match && request.method === 'PATCH') {
    const f = parse(fulfillmentInput, body), orderId = decodeURIComponent(match[1]);
    if (f.status === 'shipped' && !f.tracking) throw new HttpError(400, 'Tracking required for shipped');
    const previous = f.status === 'processing' ? 'unfulfilled' : f.status === 'shipped' ? 'processing' : 'shipped';
    const eventId = id(), now = Date.now();
    // changes() is the previous conditional UPDATE's affected rows. Only its winner appends
    // the timeline+audit, inside the same atomic batch. Repeating a stale transition is a no-op.
    // Any open review on the order (risk, payment or provider event) holds fulfillment in the same statement.
    const results = await env.DB.batch([
      s(env, `UPDATE orders SET fulfillment=?,status=CASE WHEN ?='delivered' THEN 'completed' ELSE status END WHERE id=? AND status='paid' AND fulfillment=? AND NOT EXISTS(SELECT 1 FROM manual_review WHERE order_id=? AND status='open') RETURNING id`, f.status, f.status, orderId, previous, orderId),
      s(env, `INSERT INTO order_events(id,order_id,kind,details_json,created_at) SELECT ?,id,?,?,? FROM orders WHERE id=? AND fulfillment=? AND changes()=1`, eventId, f.status, JSON.stringify({ tracking: f.tracking, courier: f.courier, note: f.note }), now, orderId, f.status),
      s(env, `INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'fulfillment.update',?,?,? WHERE EXISTS(SELECT 1 FROM order_events WHERE id=?)`, id(), actor, orderId, JSON.stringify(f), now, eventId),
    ]);
    if (!results[0].meta.changes) {
      if (await s(env, "SELECT 1 AS held FROM manual_review WHERE order_id=? AND status='open' LIMIT 1", orderId).first('held')) throw new HttpError(409, 'Pesanan ditahan: review risiko terbuka');
      throw new HttpError(409, 'Order not paid or invalid fulfillment transition');
    }
    return json({ order: { id: orderId, fulfillment: f.status, status: f.status === 'delivered' ? 'completed' : 'paid' } });
  }
  if (path === '/api/admin/blocklist' && request.method === 'GET') {
    const kind = url.searchParams.get('kind') || null;
    if (kind !== null && !['email', 'phone', 'ip'].includes(kind)) throw new HttpError(400, 'Invalid kind filter');
    const numbered = numberedPage(url.searchParams), filter = kind ? 'kind=?' : '1=1', values = kind ? [kind] : [];
    const [rows, total] = await Promise.all([
      numbered
        ? s(env, `SELECT id,kind,reason,actor,created_at AS createdAt FROM blocklist WHERE ${filter} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`, ...values, limit+1, (numbered-1)*limit).all()
        : s(env, `SELECT id,kind,reason,actor,created_at AS createdAt FROM blocklist WHERE ${filter} AND (created_at<? OR (created_at=? AND id<?)) ORDER BY created_at DESC,id DESC LIMIT ?`, ...values, before, before, beforeId, limit+1).all(),
      numbered ? s(env, `SELECT count(*) AS n FROM blocklist WHERE ${filter}`, ...values).first<number>('n') : null,
    ]);
    return json({ ...page(rows.results, limit, last => ({ before: last.createdAt, beforeId: last.id })), ...(numbered ? { page: numbered, total } : {}) });
  }
  if (path === '/api/admin/blocklist' && request.method === 'POST') {
    // Only the keyed hash is stored; the raw value never reaches D1 or the audit log.
    const input = parse(blockInput, body), entryId = id(), now = Date.now();
    const valueHash = await riskHash(riskSecret(env), input.kind, blockValue(input.kind, input.value));
    const [inserted] = await env.DB.batch([
      s(env, 'INSERT INTO blocklist(id,kind,value_hash,reason,actor,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,value_hash) DO NOTHING', entryId, input.kind, valueHash, input.reason, actor, now),
      s(env, "INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'blocklist.add',?,?,? WHERE changes()=1", id(), actor, entryId, JSON.stringify({ kind: input.kind, reason: input.reason }), now),
    ]);
    if (!inserted.meta.changes) return json({ created: false, entry: await s(env, 'SELECT id,kind,reason,actor,created_at AS createdAt FROM blocklist WHERE kind=? AND value_hash=?', input.kind, valueHash).first() });
    return json({ created: true, entry: { id: entryId, kind: input.kind, reason: input.reason, actor, createdAt: now } }, 201);
  }
  const unblock = path.match(/^\/api\/admin\/blocklist\/([^/]+)$/);
  if (unblock && request.method === 'DELETE') {
    const target = decodeURIComponent(unblock[1]);
    // Audit first while the entry still exists; the DELETE in the same batch removes exactly that row.
    const [audited] = await env.DB.batch([
      s(env, "INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'blocklist.remove',id,json_object('kind',kind,'reason',reason),? FROM blocklist WHERE id=?", id(), actor, Date.now(), target),
      s(env, 'DELETE FROM blocklist WHERE id=?', target),
    ]);
    if (!audited.meta.changes) throw new HttpError(404, 'Blocklist entry not found');
    return json({ deleted: true });
  }
  const blockOrder = path.match(/^\/api\/admin\/orders\/([^/]+)\/block$/);
  if (blockOrder && request.method === 'POST') {
    const input = parse(blockOrderInput, body), target = decodeURIComponent(blockOrder[1]), now = Date.now();
    const order = await s(env, 'SELECT email_hash,phone_hash,ip_hash FROM orders WHERE id=?', target).first<Record<string, string | null>>();
    if (!order) throw new HttpError(404, 'Order not found');
    const kinds = [...new Set(input.kinds)].filter(kind => order[`${kind}_hash`]);
    if (!kinds.length) throw new HttpError(409, 'Order has no stored risk identity for the requested kinds');
    const entries = kinds.map(kind => ({ kind, id: id() }));
    const results = await env.DB.batch(entries.flatMap(entry => [
      s(env, 'INSERT INTO blocklist(id,kind,value_hash,reason,actor,created_at) VALUES(?,?,?,?,?,?) ON CONFLICT(kind,value_hash) DO NOTHING', entry.id, entry.kind, order[`${entry.kind}_hash`], input.reason, actor, now),
      s(env, "INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'blocklist.add',?,?,? WHERE changes()=1", id(), actor, entry.id, JSON.stringify({ kind: entry.kind, reason: input.reason, orderId: target }), now),
    ]));
    return json({ blocked: entries.map((entry, i) => ({ kind: entry.kind, created: results[i * 2].meta.changes === 1 })) });
  }
  throw new HttpError(404, 'Endpoint not found');
}
