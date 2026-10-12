import { cp, writeFile } from 'node:fs/promises';
await cp('apps/admin/dist', 'apps/storefront/dist/client/admin', {recursive:true});
await writeFile('apps/storefront/dist/client/_headers', '/_astro/*\n  Cache-Control: public, max-age=31536000, immutable\n/admin/assets/*\n  Cache-Control: public, max-age=31536000, immutable\n/admin/*\n  Cache-Control: no-cache\n/*\n  X-Content-Type-Options: nosniff\n  Referrer-Policy: no-referrer\n');
