import { readFile } from 'node:fs/promises';

// Generated deploy config must never ship the provider-less dev login to a public HTTPS origin.
// --deploy additionally refuses placeholders that are fine in a build but not on a live Worker.
const args = process.argv.slice(2), deploying = args.includes('--deploy');
const path = args.find(arg => !arg.startsWith('--')) ?? 'apps/storefront/dist/server/wrangler.json';
const config = JSON.parse(await readFile(path, 'utf8'));
const scopes = [config, ...Object.values(config.env ?? {})];
const refuse = message => { console.error(`Refusing deploy config ${path}: ${message}`); process.exit(1); };
// Deploying a plain (local) build under the staging script would publish the wrong Worker and bindings.
if (args.includes('--staging') && (config.vars?.APP_ENV !== 'staging' || config.targetEnvironment !== 'staging')) refuse('not a staging build; run npm run build:staging.');
for (const scope of scopes) {
  const vars = scope.vars ?? {};
  if (vars.APP_ENV !== undefined && !['production', 'staging', 'development'].includes(vars.APP_ENV)) refuse(`unknown APP_ENV ${JSON.stringify(vars.APP_ENV)}.`);
  if (vars.STAGING_LOGIN_SECRET !== undefined) refuse('STAGING_LOGIN_SECRET must be a Worker secret, not a plain var.');
  const raw = vars.PUBLIC_ORIGIN ?? config.vars?.PUBLIC_ORIGIN ?? '';
  if (deploying && raw.includes('REPLACE')) refuse(`PUBLIC_ORIGIN ${raw} is still a placeholder.`);
  let origin;
  try { origin = new URL(raw); } catch { continue; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (String(vars.DEV_LOGIN_ENABLED) === 'true' && origin.protocol === 'https:' && !local) refuse(`DEV_LOGIN_ENABLED=true with public origin ${origin.origin}.`);
}
console.log(`Deploy guard: no development login on a public HTTPS origin${deploying ? ', no placeholder origin' : ''}.`);
