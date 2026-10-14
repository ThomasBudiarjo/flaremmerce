import type { IntegrationEnv } from './index';
import { HttpError, encode, readBounded, turnstileSkipped } from '../shared';

export function demand(ok: unknown, status = 400, message = 'Invalid request'): asserts ok {
  if (!ok) throw new HttpError(status, message);
}
/** Dev login never runs outside development, and an HTTPS non-local origin also needs an explicit opt-in (dev portals). */
export function devLoginEnabled(env: IntegrationEnv) {
  if (env.APP_ENV !== 'development' || env.DEV_LOGIN_ENABLED !== 'true') return false;
  let url: URL;
  try { url = new URL(env.PUBLIC_ORIGIN); } catch { return false; }
  return url.protocol !== 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || env.DEV_LOGIN_ALLOW_REMOTE === 'true';
}
export function origin(request: Request, env: IntegrationEnv) {
  const expected = new URL(env.PUBLIC_ORIGIN);
  const received = request.headers.get('Origin');
  // Local portal/Wrangler terminates TLS and rewrites Origin to HTTP.
  // Accept only the exact canonical host/port, only in explicit development.
  const localPortal = devLoginEnabled(env)
    && expected.protocol === 'https:' && received === `http://${expected.host}`
    && new URL(request.url).origin === received;
  demand(received === expected.origin || localPortal, 403, 'Origin rejected');
}
export async function body(request: Request, limit = 16384): Promise<string> {
  demand(Number(request.headers.get('content-length') || 0) <= limit, 413, 'Body too large');
  if (!request.body) return '';
  // Preserve a BOM rather than silently removing bytes before webhook hashing.
  return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(await readBounded(request.body, limit));
}
export async function json(request: Request): Promise<any> {
  try { return JSON.parse(await body(request)); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, 'Invalid JSON'); }
}
export async function equal(a: string, b: string) {
  const [x,y] = await Promise.all([crypto.subtle.digest('SHA-256', encode(a)), crypto.subtle.digest('SHA-256', encode(b))]);
  const left = new Uint8Array(x), right = new Uint8Array(y); let diff = 0;
  for (let i=0;i<left.length;i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
/** Staging-only passphrase login replacing Google until OAuth credentials exist. */
export function stagingLoginEnabled(env: IntegrationEnv) {
  return env.APP_ENV === 'staging' && typeof env.STAGING_LOGIN_SECRET === 'string' && env.STAGING_LOGIN_SECRET.length >= 32;
}
export async function verifyTurnstile(token: string, env: IntegrationEnv): Promise<void> {
  if (turnstileSkipped(env)) return;
  demand(env.TURNSTILE_SECRET_KEY, 503, 'Turnstile unavailable');
  demand(typeof token === 'string' && token.length > 0 && token.length <= 2048);
  let result: any;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST', body:new URLSearchParams({secret:env.TURNSTILE_SECRET_KEY, response:token}), signal:AbortSignal.timeout(10000),
    });
    demand(response.ok, 503, 'Turnstile unavailable'); result = await response.json();
  } catch { throw new HttpError(503, 'Turnstile unavailable'); }
  demand(result.success === true && result.hostname === new URL(env.PUBLIC_ORIGIN).hostname && result.action === (env.TURNSTILE_ACTION || 'checkout'), 403, 'Turnstile rejected');
}
