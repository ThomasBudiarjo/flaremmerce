import { z } from 'zod';
import { createPayment, getCustomer, verifyTurnstile } from '../integrations/index';
import { digest } from '../shared';
import { type CommerceEnv, hash, HttpError, id, json, statement as s } from './types';

export const checkoutInput = z.object({
  items: z.array(z.object({ variantId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(100) }).strict()).min(1).max(30),
  shippingQuoteId: z.string().min(1).max(100),
  contact: z.object({ name: z.string().trim().min(1).max(200), email: z.string().email().max(254), phone: z.string().trim().min(3).max(40) }).strict(),
  address: z.object({ line: z.string().trim().min(1).max(500), city: z.string().trim().min(1).max(100), postalCode: z.string().trim().min(1).max(20), destination: z.string().min(1).max(100) }).strict(),
  expectedTotal: z.number().int().min(0).max(1_000_000_000), idempotencyKey: z.string().min(8).max(128), turnstileToken: z.string().min(1).max(4096),
}).strict();
type OrderRow = { id: string; reference: string; status: string; total: number; customer_id: string | null };
type AttemptRow = { status: string; url: string | null };
type VariantRow = { id: string; sku: string; name: string; product_name: string; price: number; weight: number; mode: string; campaign_id: string | null; ship_from: string | null; ship_to: string | null };
type QuoteRow = { id: string; fingerprint: string; destination: string; weight: number; amount: number; service: string; expires_at: number; details_json: string };

async function retry(env: CommerceEnv, scope: string, key: string, fingerprint: string, guestSecret: string | null) {
  const record = await s(env, 'SELECT fingerprint, order_id FROM checkout_requests WHERE scope=? AND key=?', scope, key).first<{ fingerprint: string; order_id: string }>();
  if (!record) return null;
  if (record.fingerprint !== fingerprint) throw new HttpError(409, 'Idempotency key already used for different checkout');
  return checkoutResponse(env, record.order_id, guestSecret);
}
async function checkoutResponse(env: CommerceEnv, orderId: string, guestSecret: string | null) {
  const order = await s(env, 'SELECT id,reference,status,total,customer_id FROM orders WHERE id=?', orderId).first<OrderRow>();
  if (!order) throw new HttpError(503, 'Checkout unavailable');
  const attempt = await s(env, 'SELECT status,url FROM payment_attempts WHERE order_id=?', orderId).first<AttemptRow>();
  return json({ order: { id: order.id, reference: order.reference, status: order.status, total: order.total,
    ...(!order.customer_id && guestSecret ? { guestToken: await hash(`order-access:${guestSecret}:${order.id}`) } : {}) },
    ...(attempt?.url && order.status === 'pending_payment' ? { paymentUrl: attempt.url } : {}), paymentState: attempt?.status ?? 'unknown' });
}

export async function checkout(request: Request, env: CommerceEnv, body: unknown) {
  const parsed = checkoutInput.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Invalid checkout', parsed.error.flatten());
  const input = parsed.data;
  if (new Set(input.items.map(i => i.variantId)).size !== input.items.length) throw new HttpError(400, 'Duplicate variants');
  input.items.sort((a, b) => a.variantId.localeCompare(b.variantId));
  const customer = await getCustomer(request, env);
  const cookie = request.headers.get('Cookie')?.match(/(?:^|;\s*)__Host-checkout_scope=([a-f0-9]{64})(?:;|$)/)?.[1] ?? null;
  // Establish scope before doing any work: two first requests without cookies cannot share a key or expose tokens.
  // Caller retries unchanged payload after accepting this HttpOnly cookie. Turnstile is not consumed yet.
  if (!customer && !cookie) {
    const secret = await hash(`${id()}:${id()}`);
    return json({ error: 'checkout_scope_required', retry: true }, 428, {
      'Set-Cookie': `__Host-checkout_scope=${secret}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
    });
  }
  const scope = customer ? `customer:${customer.id}` : `guest:${await hash(cookie!)}`;
  const { turnstileToken: _token, idempotencyKey: _key, ...payload } = input;
  const fingerprint = await hash(JSON.stringify(payload));
  const existing = await retry(env, scope, input.idempotencyKey, fingerprint, cookie);
  if (existing) return existing;
  await verifyTurnstile(input.turnstileToken, env);
  const now = Date.now();
  // At most 30 distinct variants plus two timestamps: one query stays below D1's 100-bind limit.
  const { results: rows } = await s(env, `SELECT v.*, p.name AS product_name, c.id AS campaign_id, c.ship_from, c.ship_to FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN preorder_campaigns c ON c.variant_id=v.id AND c.active=1 AND c.starts_at<=? AND c.ends_at>? WHERE v.id IN (${input.items.map(() => '?').join(',')}) AND v.active=1 AND p.active=1`, now, now, ...input.items.map(i => i.variantId)).all<VariantRow>();
  const variants = new Map(rows.map(v => [v.id, v]));
  const vv: { variant: VariantRow; quantity: number }[] = [];
  let subtotal = 0, weight = 0;
  for (const item of input.items) {
    const v = variants.get(item.variantId);
    if (!v || (v.mode === 'preorder' && !v.campaign_id)) throw new HttpError(409, 'Variant unavailable');
    subtotal += v.price * item.quantity; weight += v.weight * item.quantity;
    vv.push({ variant: v, quantity: item.quantity });
  }
  const quote = await s(env, 'SELECT * FROM shipping_quotes WHERE id=?', input.shippingQuoteId).first<QuoteRow>();
  if (!quote || quote.expires_at <= now || quote.destination !== input.address.destination || quote.weight !== weight || !Number.isSafeInteger(quote.amount) || quote.amount < 0) throw new HttpError(409, 'Shipping quote expired or does not match cart and destination');
  const quoteFingerprint = await digest(JSON.stringify({origin:env.RAJAONGKIR_ORIGIN,destination:input.address.destination,weight,items:input.items.map(i => [i.variantId,i.quantity])}));
  if (quote.fingerprint !== quoteFingerprint) throw new HttpError(409, 'Cart or shipping origin changed; request a fresh quote');
  const total = subtotal + quote.amount;
  if (!Number.isSafeInteger(total) || total > 1_000_000_000 || !Number.isSafeInteger(weight)) throw new HttpError(400, 'Cart exceeds limits');
  if (total !== input.expectedTotal) throw new HttpError(409, 'Total changed; confirm authoritative total', { total });
  // DOKU Checkout invoice_number is at most 30 characters; reference is public, never a credential.
  const orderId = id(), reference = `FL-${id().replaceAll('-', '').slice(0, 24)}`, attemptId = id();
  const guestToken = customer ? null : await hash(`order-access:${cookie!}:${orderId}`);
  const shipping = { quoteId: quote.id, service: quote.service, amount: quote.amount, origin: env.RAJAONGKIR_ORIGIN ?? null, destination: quote.destination, weight, expiresAt: quote.expires_at, details: JSON.parse(quote.details_json),
    shipFrom: vv.reduce<string | null>((date, i) => i.variant.mode === 'preorder' && i.variant.ship_from && (!date || i.variant.ship_from > date) ? i.variant.ship_from : date, null),
    shipTo: vv.reduce<string | null>((date, i) => i.variant.mode === 'preorder' && i.variant.ship_to && (!date || i.variant.ship_to > date) ? i.variant.ship_to : date, null), policy: 'single-shipment-latest-item' };
  const batch = [s(env, `INSERT INTO orders(id,reference,customer_id,guest_token_hash,total,contact_json,address_json,shipping_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)`, orderId, reference, customer?.id ?? null, guestToken ? await hash(guestToken) : null, total, JSON.stringify(input.contact), JSON.stringify(input.address), JSON.stringify(shipping), now),
    s(env, 'INSERT INTO checkout_requests(scope,key,fingerprint,order_id) VALUES(?,?,?,?)', scope, input.idempotencyKey, fingerprint, orderId)];
  for (const { variant: v, quantity } of vv) {
    const itemId = id(), campaignId = v.mode === 'preorder' ? v.campaign_id : null;
    batch.push(s(env, 'INSERT INTO order_items(id,order_id,variant_id,campaign_id,quantity,price,snapshot_json) VALUES(?,?,?,?,?,?,?)', itemId, orderId, v.id, campaignId, quantity, v.price,
      JSON.stringify({ sku: v.sku, name: v.name, productName: v.product_name, mode: v.mode, weight: v.weight, ...(campaignId ? { campaign: { id: campaignId, shipFrom: v.ship_from, shipTo: v.ship_to } } : {}) })),
      s(env, 'INSERT INTO stock_reservations(item_id,order_id,variant_id,campaign_id,quantity) VALUES(?,?,?,?,?)', itemId, orderId, v.id, campaignId, quantity));
  }
  batch.push(s(env, 'INSERT INTO payment_attempts(id,order_id,reference,next_check,created_at) VALUES(?,?,?,?,?)', attemptId, orderId, reference, now + 60_000, now));
  try { await env.DB.batch(batch); }
  catch (error) {
    const concurrent = await retry(env, scope, input.idempotencyKey, fingerprint, cookie);
    if (concurrent) return concurrent;
    if (/stock_unavailable|quota_unavailable|order_not_pending/.test(String(error))) throw new HttpError(409, 'Insufficient stock or preorder capacity');
    throw error;
  }
  // Only the winning insert calls provider. Retries never issue another create after ambiguous timeout.
  try {
    const payment = await createPayment({ reference, amount: total, returnUrl: `${env.PUBLIC_ORIGIN}/order?reference=${encodeURIComponent(reference)}` }, env);
    if ('rejected' in payment) {
      // Definite provider refusal: no payment can arrive, so release the hold now. order_effects releases reservations.
      await env.DB.batch([
        s(env, "UPDATE payment_attempts SET status='failed' WHERE id=? AND status IN ('created','unknown')", attemptId),
        s(env, "UPDATE orders SET status='cancelled' WHERE id=? AND status='pending_payment' AND EXISTS(SELECT 1 FROM payment_attempts WHERE id=? AND status='failed')", orderId, attemptId),
      ]);
    } else await s(env, `UPDATE payment_attempts SET url=?,provider_id=?,status=CASE WHEN status IN ('created','unknown') THEN 'pending' ELSE status END WHERE id=?`, payment.url, payment.providerId ?? null, attemptId).run();
  } catch {
    await s(env, "UPDATE payment_attempts SET status='unknown' WHERE id=? AND status='created'", attemptId).run();
  }
  return checkoutResponse(env, orderId, cookie);
}
