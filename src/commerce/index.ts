import { getCustomer, requireAdmin } from '../integrations/index';
import { origin } from '../integrations/security';
import { admin } from './admin';
import { catalog } from './catalog';
import { checkout } from './checkout';
import { webhook } from './payments';
import { type CommerceEnv, hash, HttpError, json, statement as s } from './types';

async function body(request: Request) {
  if (!request.headers.get('Content-Type')?.includes('application/json')) throw new HttpError(415, 'JSON required');
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, 'JSON body required');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 65_536) { await reader.cancel(); throw new HttpError(413, 'Request too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new HttpError(400, 'Invalid JSON'); }
}

async function orders(request: Request, env: CommerceEnv, url: URL) {
  const customer = await getCustomer(request, env);
  if (!customer) throw new HttpError(401, 'Sign in required');
  const rawLimit = url.searchParams.get('limit') ?? '20';
  if (!/^[1-9]\d?$/.test(rawLimit) || Number(rawLimit) > 50) throw new HttpError(400, 'Invalid limit');
  const limit = Number(rawLimit);
  let cursor: [number, string] | undefined;
  const rawCursor = url.searchParams.get('cursor');
  if (rawCursor !== null) {
    try {
      if (rawCursor.length > 500) throw new Error();
      const parsed = JSON.parse(atob(rawCursor));
      if (!Array.isArray(parsed) || parsed.length !== 2 || !Number.isSafeInteger(parsed[0]) || parsed[0] < 0 || typeof parsed[1] !== 'string' || !parsed[1].length || parsed[1].length > 200) throw new Error();
      cursor = parsed as [number, string];
    } catch { throw new HttpError(400, 'Invalid cursor'); }
  }
  const rows = await s(env, `SELECT reference,status,fulfillment,total,currency,created_at AS createdAt,id FROM orders WHERE customer_id=?${cursor ? ' AND (created_at < ? OR (created_at = ? AND id < ?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`,
    customer.id, ...(cursor ? [cursor[0], cursor[0], cursor[1]] : []), limit + 1).all<{ reference: string; status: string; fulfillment: string; total: number; currency: string; createdAt: number; id: string }>();
  const page = rows.results.slice(0, limit), last = page.at(-1);
  return json({ ownerId: customer.id, orders: page.map(({ id, ...summary }) => summary), nextCursor: rows.results.length > limit && last ? btoa(JSON.stringify([last.createdAt, last.id])) : null });
}

async function order(request: Request, env: CommerceEnv, reference: string) {
  const row = await s(env, 'SELECT * FROM orders WHERE reference=?', reference).first<Record<string, unknown>>();
  if (!row) throw new HttpError(404, 'Order not found');
  const token = request.headers.get('X-Order-Token');
  const guestAuthorized = !!token && token.length <= 200 && await hash(token) === row.guest_token_hash;
  if (!guestAuthorized) {
    const owner = await getCustomer(request, env);
    if (!owner || owner.id !== row.customer_id) throw new HttpError(404, 'Order not found');
  }
  const items = await s(env, 'SELECT id,variant_id AS variantId,campaign_id AS campaignId,quantity,price,snapshot_json FROM order_items WHERE order_id=?', String(row.id)).all();
  const events = await s(env, 'SELECT kind,details_json,created_at AS createdAt FROM order_events WHERE order_id=? ORDER BY created_at,id LIMIT 100', String(row.id)).all();
  const payment = await s(env, 'SELECT status,url FROM payment_attempts WHERE order_id=?', String(row.id)).first<{ status: string; url: string | null }>();
  return json({ order: { id: row.id, reference: row.reference, status: row.status, fulfillment: row.fulfillment, total: row.total, currency: row.currency, createdAt: row.created_at,
    contact: JSON.parse(String(row.contact_json)), address: JSON.parse(String(row.address_json)), shipping: JSON.parse(String(row.shipping_json)),
    items: items.results.map(({ snapshot_json, ...item }) => ({ ...item, ...JSON.parse(String(snapshot_json)) })),
    timeline: events.results.map(({ details_json, ...event }) => ({ ...event, details: JSON.parse(String(details_json)) })) },
    paymentState: payment?.status, ...(payment?.url && row.status === 'pending_payment' ? { paymentUrl: payment.url } : {}) });
}

export async function commerceRequest(request: Request, env: CommerceEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (!path.startsWith('/api/')) return null;
  if (path === '/api/payments/webhook' && request.method === 'POST') return webhook(request, env);
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    origin(request, env);
  }
  if (request.method === 'GET' && path === '/api/catalog') return catalog(env, undefined, url.searchParams);
  if (request.method === 'GET' && path.startsWith('/api/catalog/')) return catalog(env, decodeURIComponent(path.slice('/api/catalog/'.length)));
  if (path === '/api/checkout' && request.method === 'POST') return checkout(request, env, await body(request));
  if (path === '/api/orders' && request.method === 'GET') return orders(request, env, url);
  if (path.startsWith('/api/orders/') && request.method === 'GET') return order(request, env, decodeURIComponent(path.slice('/api/orders/'.length)));
  if (path.startsWith('/api/admin/')) {
    const actor = await requireAdmin(request, env);
    return admin(request, env, actor.id, request.method === 'GET' ? null : await body(request));
  }
  throw new HttpError(404, 'Endpoint not found');
}
