const STATIC_PAGES = ['/', '/catalog', '/policies', '/privacy', '/terms', '/returns', '/about'];
const PAGE = 500, MAX_PRODUCTS = 5000;
const xml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Public pages only; products are read in slug-keyset pages so the sitemap stays bounded at 5000 entries. */
export async function sitemap(env: { DB: D1Database }, origin: string) {
  const urls = STATIC_PAGES.map(path => `${origin}${path}`);
  const { results: categories } = await env.DB.prepare('SELECT slug FROM categories WHERE active=1 ORDER BY position,slug LIMIT 200').all<{ slug: string }>();
  for (const c of categories) urls.push(`${origin}/catalog?category=${encodeURIComponent(c.slug)}`);
  let after = '';
  for (let read = 0; read < MAX_PRODUCTS;) {
    const { results } = await env.DB.prepare('SELECT slug FROM products WHERE active=1 AND slug>? ORDER BY slug LIMIT ?').bind(after, PAGE).all<{ slug: string }>();
    for (const p of results) urls.push(`${origin}/products/${encodeURIComponent(p.slug)}`);
    read += results.length;
    if (results.length < PAGE) break;
    after = results.at(-1)!.slug;
  }
  const body = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${xml(u)}</loc></url>`).join('\n')}\n</urlset>\n`;
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=0, s-maxage=3600' } });
}

export function robots(origin: string) {
  const body = ['User-agent: *', 'Disallow: /admin', 'Disallow: /cart', 'Disallow: /order', 'Disallow: /api', '', `Sitemap: ${origin}/sitemap.xml`, ''].join('\n');
  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
}
