import { randomBytes } from 'node:crypto';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, parseEnv } from 'node:util';

// Run from the repository root, or use --cwd for an isolated development setup.
const { values } = parseArgs({
  options: { cwd: { type: 'string' }, origin: { type: 'string' } },
});
let origin;
if (values.origin !== undefined) {
  const url = new URL(values.origin);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('--origin must be an HTTP(S) origin without credentials, path, query, or fragment');
  }
  origin = url.origin;
}

const path = resolve(values.cwd ?? process.cwd(), '.dev.vars');
let source = '';
try {
  source = await readFile(path, 'utf8');
  await chmod(path, 0o600);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const existing = parseEnv(source);
const newline = source.includes('\r\n') ? '\r\n' : '\n';
function set(key, value) {
  // Append overrides rather than rewriting existing entries or comments. Both
  // Node and Wrangler's dotenv parser use the last assignment for a key.
  if (existing[key] === value) return;
  if (source && !source.endsWith('\n')) source += newline;
  source += `${key}=${JSON.stringify(value)}${newline}`;
  existing[key] = value;
}

for (const key of ['BETTER_AUTH_SECRET', 'BOOTSTRAP_SECRET', 'RISK_HASH_SECRET']) {
  if (!existing[key]) set(key, randomBytes(32).toString('hex'));
}
set('DEV_LOGIN_ENABLED', 'true');
set('APP_ENV', 'development');
set('PUBLIC_ORIGIN', origin ?? existing.PUBLIC_ORIGIN ?? 'http://localhost:8787');
// An HTTPS dev portal (--origin) is a non-local origin; the runtime only allows dev login there on explicit opt-in.
if (origin) {
  const url = new URL(origin);
  if (url.protocol === 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) set('DEV_LOGIN_ALLOW_REMOTE', 'true');
}
await writeFile(path, source, { mode: 0o600 });
await chmod(path, 0o600);
console.log('Local development variables prepared in .dev.vars (secrets hidden).');
