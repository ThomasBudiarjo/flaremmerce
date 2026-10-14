import { z } from 'zod';
import { createPayment, getCustomer, verifyTurnstile } from '../integrations/index';
import { cartWeightMessage, chargeableWeight, clientIp, digest, envCount, maxCartWeight, normalizeEmail, normalizePhone, riskHash, riskSecret, volumetricDivisor } from '../shared';
import { cartItems, shipPromise } from './cart';
import { disposableEmail } from './risk';
import { type CommerceEnv, hash, HttpError, id, json, statement as s } from './types';

export const checkoutInput = z.object({
  items: cartItems,
  shippingQuoteId: z.string().min(1).max(100),
  contact: z.object({ name: z.string().trim().min(1).max(200), email: z.string().email().max(254), phone: z.string().trim().min(3).max(40) }).strict(),
  // City/postal code are accepted for older clients but never trusted: the server destination row is snapshotted.
  address: z.object({ line: z.string().trim().min(1).max(500), city: z.string().trim().max(100).optional(), postalCode: z.string().trim().max(20).optional(), destination: z.string().min(1).max(100) }).strict(),
  expectedTotal: z.number().int().min(0).max(1_000_000_000), idempotencyKey: z.string().min(8).max(128), turnstileToken: z.string().min(1).max(4096),
}).strict();
type OrderRow = { id: string; reference: string; status: string; total: number; customer_id: string | null };
type AttemptRow = { status: string; url: string | null };
type VariantRow = { id: string; sku: string; name: string; product_name: string; price: number; weight: number; length_cm: number | null; width_cm: number | null; height_cm: number | null; mode: string; max_per_order: number | null; max_per_customer: number | null; campaign_id: string | null; ship_from: string | null; ship_to: string | null };
type DestinationRow = { id: string; label: string; province: string; city: string; district: string; subdistrict: string; postal_code: string };
type QuoteRow = { id: string; fingerprint: string; destination: string; weight: number; amount: number; service: string; expires_at: number; details_json: string };

async function retry(env: CommerceEnv, scope: string, key: string, fingerprint: string, guestSecret: string | null) {
  const record = await s(env, 'SELECT fingerprint, order_id FROM checkout_requests WHERE scope=? AND key=?', scope, key).first<{ fingerprint: string; order_id: string }>();
  if (!record) return null;
  if (record.fingerprint !== fingerprint) throw new HttpError(409, 'Idempotency key already used for different checkout');
  return checkoutResponse(env, record.order_id, guestSecret);
}
async function checkoutResponse(env: CommerceEnv, orderId: string, guestSecret: string | null) {
  const order = await s(env, 'SELECT id,reference,status,total,customer_id,shipping_json FROM orders WHERE id=?', orderId).first<OrderRow & { shipping_json: string }>();
  if (!order) throw new HttpError(503, 'Checkout unavailable');
  const attempt = await s(env, 'SELECT status,url FROM payment_attempts WHERE order_id=?', orderId).first<AttemptRow>();
  const shipping = JSON.parse(order.shipping_json);
  return json({ order: { id: order.id, reference: order.reference, status: order.status, total: order.total,
    shipPromise: { shipFrom: shipping.shipFrom ?? null, shipTo: shipping.shipTo ?? null, policy: shipping.policy ?? 'single-shipment-latest-item' }, shippingService: shipping.service ?? null, shippingAmount: shipping.amount ?? null,
    ...(!order.customer_id && guestSecret ? { guestToken: await hash(`order-access:${guestSecret}:${order.id}`) } : {}) },
    ...(attempt?.url && order.status === 'pending_payment' ? { paymentUrl: attempt.url } : {}), paymentState: attempt?.status ?? 'unknown' });
}

export async function checkout(request: Request, env: CommerceEnv, body: unknown) {
  const parsed = checkoutInput.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Invalid checkout', parsed.error.flatten());
  const input = parsed.data;
  if (new Set(input.items.map(i => i.variantId)).size !== input.items.length) throw new HttpError(400, 'Duplicate variants');
  input.items.sort((a, b) => a.variantId.localeCompare(b.variantId));
  const phone = normalizePhone(input.contact.phone);
  if (!phone) throw new HttpError(400, 'Nomor HP tidak valid');
  const customer = await getCustomer(request, env, { includeBanned: true });
  if (customer?.banned) throw new HttpError(403, 'Pesanan tidak dapat diproses');
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
  // Risk checks come after idempotency (a retry always returns its order) and before Turnstile is consumed.
  const secret = riskSecret(env), ip = clientIp(request), email = normalizeEmail(input.contact.email);
  // A missing client IP (local tooling) is no identity at all rather than one shared by every such request.
  const [emailHash, phoneHash, ipHash] = await Promise.all([riskHash(secret, 'email', email), riskHash(secret, 'phone', phone), ip === 'unknown' ? null : riskHash(secret, 'ip', ip)]);
  if (await s(env, "SELECT 1 AS blocked FROM blocklist WHERE (kind='email' AND value_hash=?) OR (kind='phone' AND value_hash=?) OR (kind='ip' AND value_hash=?) LIMIT 1", emailHash, phoneHash, ipHash).first('blocked')) throw new HttpError(403, 'Pesanan tidak dapat diproses');
  // Indonesian mobile carriers put many shoppers behind one CGNAT address, so the IP gets its own, higher limit.
  const maxPending = envCount(env.MAX_PENDING_PER_IDENTITY, 3), maxPendingIp = envCount(env.MAX_PENDING_PER_IP, 10);
  // `+status` keeps the planner on the per-identity hash indexes instead of range-scanning every pending order.
  const pendingIdentity = "(SELECT count(*) FROM orders WHERE +status='pending_payment' AND (email_hash=? OR phone_hash=?))", pendingIp = "(SELECT count(*) FROM orders WHERE +status='pending_payment' AND ip_hash=?)";
  const overPending = async () => !!await s(env, `SELECT ${pendingIdentity}>=? OR ${pendingIp}>=? AS over`, emailHash, phoneHash, maxPending, ipHash, maxPendingIp).first<number>('over');
  if (await overPending()) throw new HttpError(429, 'Terlalu banyak pesanan belum dibayar');
  await verifyTurnstile(input.turnstileToken, env);
  const now = Date.now();
  // At most 30 distinct variants plus two timestamps: one query stays below D1's 100-bind limit.
  const { results: rows } = await s(env, `SELECT v.*, p.name AS product_name, c.id AS campaign_id, c.ship_from, c.ship_to FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN preorder_campaigns c ON c.variant_id=v.id AND c.active=1 AND c.starts_at<=? AND c.ends_at>? WHERE v.id IN (${input.items.map(() => '?').join(',')}) AND v.active=1 AND p.active=1`, now, now, ...input.items.map(i => i.variantId)).all<VariantRow>();
  const variants = new Map(rows.map(v => [v.id, v]));
  const vv: { variant: VariantRow; quantity: number }[] = [];
  let subtotal = 0, weight = 0;
  const divisor = volumetricDivisor(env);
  for (const item of input.items) {
    const v = variants.get(item.variantId);
    if (!v || (v.mode === 'preorder' && !v.campaign_id)) throw new HttpError(409, 'Variant unavailable');
    if (v.max_per_order !== null && item.quantity > v.max_per_order) throw new HttpError(409, `Maksimal ${v.max_per_order} per pesanan untuk ${v.sku}`);
    subtotal += v.price * item.quantity; weight += chargeableWeight(v, divisor) * item.quantity;
    vv.push({ variant: v, quantity: item.quantity });
  }
  const limited = vv.filter(i => i.variant.max_per_customer !== null);
  if (limited.length) {
    const { results: bought } = await s(env, `SELECT i.variant_id AS variantId,sum(i.quantity) AS n FROM orders o JOIN order_items i ON i.order_id=o.id WHERE o.status<>'cancelled' AND (o.email_hash=? OR o.phone_hash=? OR o.customer_id=?) AND i.variant_id IN (${limited.map(() => '?').join(',')}) GROUP BY i.variant_id`,
      emailHash, phoneHash, customer?.id ?? null, ...limited.map(i => i.variant.id)).all<{ variantId: string; n: number }>();
    for (const { variant: v, quantity } of limited) {
      if ((bought.find(row => row.variantId === v.id)?.n ?? 0) + quantity > v.max_per_customer!) throw new HttpError(409, `Batas pembelian ${v.sku} adalah ${v.max_per_customer} per pelanggan`);
    }
  }
  if (weight > maxCartWeight(env)) throw new HttpError(400, cartWeightMessage(maxCartWeight(env)));
  const destination = await s(env, 'SELECT id,label,province,city,district,subdistrict,postal_code FROM shipping_destinations WHERE id=?', input.address.destination).first<DestinationRow>();
  if (!destination) throw new HttpError(409, 'Wilayah tujuan tidak dikenal; cari ulang wilayah');
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
    ...shipPromise(vv.map(i => ({ mode: i.variant.mode, shipFrom: i.variant.ship_from, shipTo: i.variant.ship_to }))) };
  const contact = { name: input.contact.name, email: input.contact.email.trim(), phone };
  const address = { line: input.address.line, destination: destination.id, label: destination.label, province: destination.province, city: destination.city, district: destination.district, subdistrict: destination.subdistrict, postalCode: destination.postal_code };
  // The pending limit is re-checked inside the batch: a losing concurrent insert leaves no order row, so the
  // dependent inserts below fail and the whole batch rolls back.
  const batch = [s(env, `INSERT INTO orders(id,reference,customer_id,guest_token_hash,total,contact_json,address_json,shipping_json,created_at,email_hash,phone_hash,ip_hash)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,? WHERE ${pendingIdentity}<? AND ${pendingIp}<?`,
      orderId, reference, customer?.id ?? null, guestToken ? await hash(guestToken) : null, total, JSON.stringify(contact), JSON.stringify(address), JSON.stringify(shipping), now, emailHash, phoneHash, ipHash, emailHash, phoneHash, maxPending, ipHash, maxPendingIp),
    s(env, 'INSERT INTO checkout_requests(scope,key,fingerprint,order_id,created_at) VALUES(?,?,?,?,?)', scope, input.idempotencyKey, fingerprint, orderId, now)];
  for (const { variant: v, quantity } of vv) {
    const itemId = id(), campaignId = v.mode === 'preorder' ? v.campaign_id : null;
    batch.push(s(env, 'INSERT INTO order_items(id,order_id,variant_id,campaign_id,quantity,price,snapshot_json) VALUES(?,?,?,?,?,?,?)', itemId, orderId, v.id, campaignId, quantity, v.price,
      JSON.stringify({ sku: v.sku, name: v.name, productName: v.product_name, mode: v.mode, weight: v.weight, billedWeight: chargeableWeight(v, divisor), ...(campaignId ? { campaign: { id: campaignId, shipFrom: v.ship_from, shipTo: v.ship_to } } : {}) })),
      s(env, 'INSERT INTO stock_reservations(item_id,order_id,variant_id,campaign_id,quantity) VALUES(?,?,?,?,?)', itemId, orderId, v.id, campaignId, quantity));
  }
  batch.push(s(env, 'INSERT INTO payment_attempts(id,order_id,reference,next_check,created_at) VALUES(?,?,?,?,?)', attemptId, orderId, reference, now + 60_000, now));
  // Soft signals: the order is accepted, but an open review holds fulfillment until an operator resolves it.
  // Velocity counts include this order and are evaluated inside the same serialized batch.
  const since = now - 86_400_000;
  batch.push(s(env, `INSERT OR IGNORE INTO manual_review(id,event_key,order_id,reason,created_at) SELECT ?,?,?,'risk_velocity',?
    WHERE max((SELECT count(*) FROM orders WHERE email_hash=? AND created_at>?),(SELECT count(*) FROM orders WHERE phone_hash=? AND created_at>?))>? OR (SELECT count(*) FROM orders WHERE ip_hash=? AND created_at>?)>?`,
    id(), `risk_velocity:${orderId}`, orderId, now, emailHash, since, phoneHash, since, envCount(env.VELOCITY_LIMIT, 5), ipHash, since, envCount(env.VELOCITY_LIMIT_IP, 20)));
  if (disposableEmail(email)) batch.push(s(env, "INSERT INTO manual_review(id,event_key,order_id,reason,created_at) VALUES(?,?,?,'risk_disposable_email',?)", id(), `risk_disposable_email:${orderId}`, orderId, now));
  try { await env.DB.batch(batch); }
  catch (error) {
    const concurrent = await retry(env, scope, input.idempotencyKey, fingerprint, cookie);
    if (concurrent) return concurrent;
    if (await overPending()) throw new HttpError(429, 'Terlalu banyak pesanan belum dibayar');
    if (/purchase_limit/.test(String(error))) throw new HttpError(409, 'Batas pembelian per pelanggan terlampaui');
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
