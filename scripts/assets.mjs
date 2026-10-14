import { cp, writeFile } from 'node:fs/promises';
await cp('apps/admin/dist', 'apps/storefront/dist/client/admin', {recursive:true});
// _headers rules that match the same path are merged, so a /admin/* no-cache rule would also
// attach to hashed /admin/assets/*. Only the SPA shell (served for every client route) is no-cache.
await writeFile('apps/storefront/dist/client/_headers', '/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n/admin/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/admin/\n  Cache-Control: no-cache\n/admin/index.html\n  Cache-Control: no-cache\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n');
