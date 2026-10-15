import { and, asc, eq, gt, inArray, lte, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { campaigns, categories, inventory, products, variants } from './schema';
import { type CommerceEnv, HttpError, json } from './types';
import { catalogQuery, DEFAULT_PAGE_SIZE, envCount, likePattern, validSlug } from '../shared';

/** Public shoppers see a coarse level; exact counts would expose sales velocity and stock to scrapers. */
export function stockLevel(available: number | null, low: number) {
  return available === null ? 'in_stock' : available <= 0 ? 'out' : available <= low ? 'low' : 'in_stock';
}
const publicCache = { 'Cache-Control': 'public, max-age=0, s-maxage=60' };

export async function categoryList(env: CommerceEnv, includeInactive = false) {
  const rows = await drizzle(env.DB).select().from(categories).where(includeInactive ? undefined : eq(categories.active, 1)).orderBy(asc(categories.position), asc(categories.slug)).limit(200);
  return rows.map(({ active, version, ...c }) => ({ ...c, ...(includeInactive ? { active: !!active, version } : {}) }));
}
export async function publicCategories(env: CommerceEnv) {
  return json({ categories: await categoryList(env) }, 200, publicCache);
}

/** `active` narrows the admin list (includeInactive) to active or archived products; the public catalog ignores it. */
export async function catalog(env: CommerceEnv, slug?: string, query = new URLSearchParams(), includeInactive = false, active?: boolean) {
  const db = drizzle(env.DB);
  if (slug !== undefined && !validSlug(slug)) throw new HttpError(404, 'Product not found');
  // Same normalizers as the shared cache key, so every cacheable query is exactly what is served.
  const params = slug ? {} : catalogQuery(query);
  if (!params) throw new HttpError(400, 'Invalid catalog query');
  const limit = slug ? 1 : Number(params.limit ?? DEFAULT_PAGE_SIZE), after = params.after;
  // Without a slug cursor the list is a numbered page with a total; `after` keeps the cheaper keyset path for old links.
  const numbered = !slug && !after, pageNo = numbered ? Number(params.page ?? 1) : 1;
  // An unknown or inactive category is an empty page, not an error: links may outlive the category.
  const category = params.category ? eq(products.categoryId, sql`(SELECT id FROM categories WHERE slug=${params.category}${includeInactive ? sql`` : sql` AND active=1`})`) : undefined;
  // Bounded LIKE: the term is at most 60 escaped characters and the slug-ordered page stops at limit+1 matches.
  const search = params.q ? sql`${products.name} LIKE ${likePattern(params.q)} ESCAPE '\\'` : undefined;
  // Keep IN parameters below D1's 100-bind limit and avoid one query per product.
  const filter = and(includeInactive ? (active === undefined ? undefined : eq(products.active, active ? 1 : 0)) : eq(products.active, 1), slug ? eq(products.slug, slug) : undefined, category, search);
  const [page, counted] = await Promise.all([
    db.select({ product: products, category: { slug: categories.slug, name: categories.name } }).from(products).leftJoin(categories, eq(categories.id, products.categoryId))
      .where(and(filter, after ? gt(products.slug, after) : undefined)).orderBy(products.slug).limit(limit + 1).offset((pageNo - 1) * limit),
    numbered ? db.select({ n: sql<number>`count(*)` }).from(products).where(filter) : undefined,
  ]);
  const rows = page.slice(0, limit);
  if (slug && !rows.length) throw new HttpError(404, 'Product not found');
  const now = Date.now(), low = envCount(env.LOW_STOCK_PUBLIC, 5);
  const vv = rows.length ? await db.select({ variant: variants, inventory, campaign: campaigns }).from(variants)
    .leftJoin(inventory, eq(inventory.variantId, variants.id))
    .leftJoin(campaigns, and(eq(campaigns.variantId, variants.id), eq(campaigns.active, 1), lte(campaigns.startsAt, now), gt(campaigns.endsAt, now)))
    .where(and(inArray(variants.productId, rows.map(p => p.product.id)), includeInactive ? undefined : eq(variants.active, 1))).orderBy(variants.sku).limit(2700) : [];
  const result = rows.map(({ product: p, category: c }) => {
    return { id: p.id, slug: p.slug, name: p.name, description: p.description, imageUrl: p.imageUrl, category: c?.slug ? { slug: c.slug, name: c.name } : null,
      ...(includeInactive ? { active: !!p.active, categoryId: p.categoryId, version: p.version } : {}),
      variants: vv.filter(v => v.variant.productId === p.id).map(({ variant: v, inventory: stock, campaign: c }) => {
        const available = v.mode === 'stock' ? (stock ? stock.onHand - stock.reserved : 0) : (c ? (c.quota === null ? null : c.quota - c.reserved - c.sold) : 0);
        const campaign = c && { id: c.id, startsAt: c.startsAt, endsAt: c.endsAt, shipFrom: c.shipFrom, shipTo: c.shipTo };
        return { id: v.id, sku: v.sku, name: v.name, price: v.price, weight: v.weight, mode: v.mode, maxPerOrder: v.maxPerOrder, maxPerCustomer: v.maxPerCustomer,
          ...(includeInactive
            ? { active: !!v.active, onHand: stock?.onHand ?? 0, reserved: stock?.reserved ?? 0, available, lengthCm: v.lengthCm, widthCm: v.widthCm, heightCm: v.heightCm, lowStockThreshold: v.lowStockThreshold, version: v.version,
              ...(v.mode === 'preorder' && c ? { campaign: { ...campaign, quota: c.quota, available, version: c.version } } : {}) }
            : { stockLevel: stockLevel(available, low), ...(v.mode === 'preorder' && campaign ? { campaign } : {}) }),
        };
      }),
    };
  });
  return json(slug ? { product: result[0] } : { products: result, nextCursor: page.length > limit ? rows.at(-1)!.product.slug : null, ...(counted ? { page: pageNo, total: counted[0]?.n ?? 0 } : {}) }, 200, publicCache);
}
