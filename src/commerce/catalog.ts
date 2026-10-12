import { and, eq, gt, inArray, lte } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { campaigns, inventory, products, variants } from './schema';
import { type CommerceEnv, HttpError, json } from './types';

export async function catalog(env: CommerceEnv, slug?: string, query = new URLSearchParams(), includeInactive = false) {
  const db = drizzle(env.DB);
  if (slug && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new HttpError(404, 'Product not found');
  if (slug && slug.length > 100) throw new HttpError(404, 'Product not found');
  const limit = slug ? 1 : Number(query.get('limit') ?? 30), after = slug ? null : query.get('after');
  if (!Number.isInteger(limit) || limit < 1 || limit > 90 || (after && (after.length > 100 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(after)))) throw new HttpError(400, 'Invalid catalog pagination');
  // Keep IN parameters below D1's 100-bind limit and avoid one query per product.
  const page = await db.select().from(products).where(and(includeInactive ? undefined : eq(products.active, 1), slug ? eq(products.slug, slug) : undefined, after ? gt(products.slug, after) : undefined)).orderBy(products.slug).limit(limit + 1);
  const rows = page.slice(0, limit);
  if (slug && !rows.length) throw new HttpError(404, 'Product not found');
  const now = Date.now();
  const vv = rows.length ? await db.select({ variant: variants, inventory, campaign: campaigns }).from(variants)
    .leftJoin(inventory, eq(inventory.variantId, variants.id))
    .leftJoin(campaigns, and(eq(campaigns.variantId, variants.id), eq(campaigns.active, 1), lte(campaigns.startsAt, now), gt(campaigns.endsAt, now)))
    .where(and(inArray(variants.productId, rows.map(p => p.id)), includeInactive ? undefined : eq(variants.active, 1))).orderBy(variants.sku).limit(2700) : [];
  const result = rows.map(p => {
    return { id: p.id, slug: p.slug, name: p.name, description: p.description, imageUrl: p.imageUrl,
      ...(includeInactive ? {active:!!p.active}:{}),
      variants: vv.filter(v => v.variant.productId === p.id).map(({ variant: v, inventory: stock, campaign: c }) => ({
        id: v.id, sku: v.sku, name: v.name, price: v.price, weight: v.weight, mode: v.mode,
        ...(includeInactive ? {active:!!v.active}:{}),
        available: v.mode === 'stock' ? (stock ? stock.onHand - stock.reserved : 0) : (c ? (c.quota === null ? null : c.quota - c.reserved - c.sold) : 0),
        ...(v.mode === 'preorder' && c ? { campaign: { id: c.id, startsAt: c.startsAt, endsAt: c.endsAt, shipFrom: c.shipFrom, shipTo: c.shipTo, quota: c.quota, available: c.quota === null ? null : c.quota - c.reserved - c.sold } } : {}),
      })),
    };
  });
  return json(slug ? { product: result[0] } : { products: result, nextCursor: page.length > limit ? rows.at(-1)!.slug : null }, 200, { 'Cache-Control': 'public, max-age=0, s-maxage=60' });
}
