import { z } from 'zod';
import { cartWeightMessage, chargeableWeight, envCount, MAX_CART_LINES, MAX_LINE_QUANTITY, maxCartWeight, volumetricDivisor } from '../shared';
import { stockLevel } from './catalog';
import { type CommerceEnv, HttpError, json, statement as s } from './types';

export const cartItems = z.array(z.object({ variantId: z.string().min(1).max(100), quantity: z.number().int().min(1).max(MAX_LINE_QUANTITY) }).strict()).min(1).max(MAX_CART_LINES);
const previewInput = z.object({ items: cartItems }).strict();
type PreviewRow = { id: string; sku: string; name: string; product_name: string; product_slug: string; price: number; weight: number; length_cm: number | null; width_cm: number | null; height_cm: number | null;
  mode: string; max_per_order: number | null; max_per_customer: number | null; on_hand: number | null; reserved: number | null; campaign_id: string | null; quota: number | null; c_reserved: number | null; sold: number | null; ship_from: string | null; ship_to: string | null; ends_at: number | null };

/** One shipment follows the latest pre-order item; null when the cart is ready stock only. */
export function shipPromise(lines: { mode: string; shipFrom?: string | null; shipTo?: string | null }[]) {
  const latest = (key: 'shipFrom' | 'shipTo') => lines.reduce<string | null>((date, l) => l.mode === 'preorder' && l[key] && (!date || l[key]! > date) ? l[key]! : date, null);
  return { shipFrom: latest('shipFrom'), shipTo: latest('shipTo'), policy: 'single-shipment-latest-item' as const };
}

// Authoritative, uncached cart view: what checkout would charge right now, without reserving anything.
export async function preview(env: CommerceEnv, body: unknown) {
  const parsed = previewInput.safeParse(body);
  if (!parsed.success) throw new HttpError(400, 'Invalid cart', parsed.error.flatten());
  const items = parsed.data.items;
  if (new Set(items.map(i => i.variantId)).size !== items.length) throw new HttpError(400, 'Duplicate variants');
  const now = Date.now(), low = envCount(env.LOW_STOCK_PUBLIC, 5), divisor = volumetricDivisor(env);
  const { results } = await s(env, `SELECT v.id,v.sku,v.name,v.price,v.weight,v.length_cm,v.width_cm,v.height_cm,v.mode,v.max_per_order,v.max_per_customer,p.name AS product_name,p.slug AS product_slug,
    i.on_hand,i.reserved,c.id AS campaign_id,c.quota,c.reserved AS c_reserved,c.sold,c.ship_from,c.ship_to,c.ends_at
    FROM product_variants v JOIN products p ON p.id=v.product_id LEFT JOIN inventory i ON i.variant_id=v.id
    LEFT JOIN preorder_campaigns c ON c.variant_id=v.id AND c.active=1 AND c.starts_at<=? AND c.ends_at>?
    WHERE v.id IN (${items.map(() => '?').join(',')}) AND v.active=1 AND p.active=1`, now, now, ...items.map(i => i.variantId)).all<PreviewRow>();
  const rows = new Map(results.map(r => [r.id, r]));
  const problems: { variantId: string | null; code: string; message: string }[] = [];
  let subtotal = 0, weight = 0;
  const lines = items.map(({ variantId, quantity }) => {
    const v = rows.get(variantId);
    if (!v) { problems.push({ variantId, code: 'unavailable', message: 'Produk tidak lagi tersedia' }); return { variantId, quantity, available: false as const }; }
    const preorder = v.mode === 'preorder';
    const available = preorder ? (v.campaign_id ? (v.quota === null ? null : v.quota - (v.c_reserved ?? 0) - (v.sold ?? 0)) : 0) : (v.on_hand ?? 0) - (v.reserved ?? 0);
    const enough = available === null || available >= quantity;
    if (preorder && !v.campaign_id) problems.push({ variantId, code: 'no_campaign', message: `Periode pre-order ${v.sku} belum dibuka atau sudah berakhir` });
    else if (!enough) problems.push({ variantId, code: 'insufficient', message: available! > 0 ? `Stok ${v.sku} tidak cukup untuk jumlah ini` : `${v.sku} sedang habis` });
    if (v.max_per_order !== null && quantity > v.max_per_order) problems.push({ variantId, code: 'max_per_order', message: `Maksimal ${v.max_per_order} per pesanan untuk ${v.sku}` });
    const billed = chargeableWeight(v, divisor);
    subtotal += v.price * quantity; weight += billed * quantity;
    return { variantId, quantity, available: true as const, sku: v.sku, name: v.name, productName: v.product_name, productSlug: v.product_slug, price: v.price, lineTotal: v.price * quantity,
      mode: v.mode, stockLevel: stockLevel(available, low), enough, maxPerOrder: v.max_per_order, maxPerCustomer: v.max_per_customer, weight: billed,
      campaign: preorder && v.campaign_id ? { id: v.campaign_id, shipFrom: v.ship_from, shipTo: v.ship_to, endsAt: v.ends_at } : null };
  });
  const limit = maxCartWeight(env);
  if (weight > limit) problems.push({ variantId: null, code: 'weight_limit', message: cartWeightMessage(limit) });
  const promise = shipPromise(lines.map(l => ({ mode: l.available ? l.mode : 'stock', shipFrom: l.available ? l.campaign?.shipFrom : null, shipTo: l.available ? l.campaign?.shipTo : null })));
  return json({ lines, subtotal, weight, shipPromise: promise, problems, checkedAt: now });
}
