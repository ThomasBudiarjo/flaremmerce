import { readFile } from 'node:fs/promises';

// Generated deploy config must never ship the provider-less dev login to a public HTTPS origin.
const path = process.argv[2] ?? 'apps/storefront/dist/server/wrangler.json';
const config = JSON.parse(await readFile(path, 'utf8'));
const scopes = [config, ...Object.values(config.env ?? {})];
for (const scope of scopes) {
  const vars = scope.vars ?? {};
  let origin;
  try { origin = new URL(vars.PUBLIC_ORIGIN ?? config.vars?.PUBLIC_ORIGIN ?? ''); } catch { continue; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (String(vars.DEV_LOGIN_ENABLED) === 'true' && origin.protocol === 'https:' && !local) {
    console.error(`Refusing deploy config ${path}: DEV_LOGIN_ENABLED=true with public origin ${origin.origin}.`);
    process.exit(1);
  }
}
console.log('Deploy guard: no development login on a public HTTPS origin.');
