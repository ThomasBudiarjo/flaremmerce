import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { campaigns, inventory, products, variants } from './schema';
import { type CommerceEnv, HttpError, json } from './types';
import { catalogParams, envCount, validSlug } from '../shared';

/** Public shoppers see a coarse level; exact counts would expose sales velocity and stock to scrapers. */
function stockLevel(available: number | null, low: number) {
  return available === null ? 'in_stock' : available <= 0 ? 'out' : available <= low ? 'low' : 'in_stock';
}

export async function catalog(env: CommerceEnv, slug?: string, query = new URLSearchParams(), includeInactive = false) {
  const db = drizzle(env.DB);
  if (slug !== undefined && !validSlug(slug)) throw new HttpError(404, 'Product not found');
  // Same normalizers as the shared cache key, so every cacheable query is exactly what is served.
  const rawLimit = slug ? null : query.get('limit'), after = slug ? null : query.get('after');
  const limit = slug ? 1 : rawLimit === null ? 30 : Number(catalogParams.limit(rawLimit));
  if (!limit || (after !== null && catalogParams.after(after) === null)) throw new HttpError(400, 'Invalid catalog pagination');
  // Keep IN parameters below D1's 100-bind limit and avoid one query per product.
  const page = await db.select().from(products).where(and(includeInactive ? undefined : eq(products.active, 1), slug ? eq(products.slug, slug) : undefined, after ? gt(products.slug, after) : undefined)).orderBy(products.slug).limit(limit + 1);
  const rows = page.slice(0, limit);
  if (slug && !rows.length) throw new HttpError(404, 'Product not found');
  const now = Date.now(), low = envCount(env.LOW_STOCK_PUBLIC, 5);
  const vv = rows.length ? await db.select({ variant: variants, inventory, campaign: campaigns }).from(variants)
    .leftJoin(inventory, eq(inventory.variantId, variants.id))
    .leftJoin(campaigns, and(eq(campaigns.variantId, variants.id), eq(campaigns.active, 1), lte(campaigns.startsAt, now), gt(campaigns.endsAt, now)))
    .where(and(inArray(variants.productId, rows.map(p => p.id)), includeInactive ? undefined : eq(variants.active, 1))).orderBy(variants.sku).limit(2700) : [];
  const result = rows.map(p => {
    return { id: p.id, slug: p.slug, name: p.name, description: p.description, imageUrl: p.imageUrl,
      ...(includeInactive ? {active:!!p.active}:{}),
      variants: vv.filter(v => v.variant.productId === p.id).map(({ variant: v, inventory: stock, campaign: c }) => {
        const available = v.mode === 'stock' ? (stock ? stock.onHand - stock.reserved : 0) : (c ? (c.quota === null ? null : c.quota - c.reserved - c.sold) : 0);
        const campaign = c && { id: c.id, startsAt: c.startsAt, endsAt: c.endsAt, shipFrom: c.shipFrom, shipTo: c.shipTo };
        return { id: v.id, sku: v.sku, name: v.name, price: v.price, weight: v.weight, mode: v.mode, maxPerOrder: v.maxPerOrder, maxPerCustomer: v.maxPerCustomer,
          ...(includeInactive
            ? { active: !!v.active, onHand: stock?.onHand ?? 0, reserved: stock?.reserved ?? 0, available, ...(v.mode === 'preorder' && c ? { campaign: { ...campaign, quota: c.quota, available } } : {}) }
            : { stockLevel: stockLevel(available, low), ...(v.mode === 'preorder' && campaign ? { campaign } : {}) }),
        };
      }),
    };
  });
  return json(slug ? { product: result[0] } : { products: result, nextCursor: page.length > limit ? rows.at(-1)!.slug : null }, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=60' });
}
