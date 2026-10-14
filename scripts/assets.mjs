import { cp, readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
await cp('apps/admin/dist', 'apps/storefront/dist/client/admin', {recursive:true});

// Prerendered pages not routed through the Worker get their CSP from _headers, so their inline
// Astro scripts are hashed here; Worker-served HTML is hashed at runtime by src/entry.ts.
async function html(dir) {
  const files = [];
  for (const entry of await readdir(dir, {withFileTypes:true})) {
    const path = join(dir, entry.name);
    if (entry.isDirectory() && !(dir.endsWith('client') && entry.name === 'admin')) files.push(...await html(path));
    else if (entry.name.endsWith('.html')) files.push(path);
  }
  return files;
}
const hashes = new Set();
for (const file of await html('apps/storefront/dist/client')) {
  for (const [, attributes, body] of (await readFile(file, 'utf8')).matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (!/\ssrc\s*=/i.test(attributes) && body) hashes.add(`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  }
}
// Static assets bypass the Worker, so the staging noindex header must also be in _headers.
const { vars = {} } = JSON.parse(await readFile('apps/storefront/dist/server/wrangler.json', 'utf8'));
const common = (vars.APP_ENV === 'staging' ? "  X-Robots-Tag: noindex, nofollow\n" : "") + "  X-Frame-Options: DENY\n  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=()\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n";
const base = "default-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";
const storefront = `${base}; img-src 'self' data: https:; script-src 'self' https://challenges.cloudflare.com ${[...hashes].join(' ')}; frame-src https://challenges.cloudflare.com`;
const admin = `${base}; img-src 'self' data: blob: https:; script-src 'self'; frame-src 'none'`;
// _headers rules that match the same path are merged, so a /admin/* no-cache rule would also
// attach to hashed /admin/assets/*. Only the SPA shell (served for every client route) is no-cache.
// Merged CSP headers are both enforced; the admin shell itself is served by the Worker with one policy.
await writeFile('apps/storefront/dist/client/_headers', `/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n/admin/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/admin/\n  Cache-Control: no-cache\n/admin/index.html\n  Cache-Control: no-cache\n/admin/*\n  Content-Security-Policy: ${admin}\n/*\n${common}  Content-Security-Policy: ${storefront}\n`);
