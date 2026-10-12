import type { IntegrationEnv } from './index';

export class IntegrationError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
export function demand(ok: unknown, status = 400, message = 'Invalid request'): asserts ok {
  if (!ok) throw new IntegrationError(status, message);
}
export function origin(request: Request, env: IntegrationEnv) {
  demand(request.headers.get('Origin') === new URL(env.PUBLIC_ORIGIN).origin, 403, 'Origin rejected');
}
export async function body(request: Request, limit = 16384): Promise<string> {
  demand(Number(request.headers.get('content-length') || 0) <= limit, 413, 'Body too large');
  const reader = request.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const {done, value} = await reader.read(); if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new IntegrationError(413, 'Body too large'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  // Preserve a BOM rather than silently removing bytes before webhook hashing.
  return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes);
}
export async function json(request: Request): Promise<any> {
  try { return JSON.parse(await body(request)); }
  catch (error) { if (error instanceof IntegrationError) throw error; throw new IntegrationError(400, 'Invalid JSON'); }
}
export const encode = (s: string) => new TextEncoder().encode(s);
export const base64 = (b: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(b)));
export async function digest(s: string) { return base64(await crypto.subtle.digest('SHA-256', encode(s))); }
export async function equal(a: string, b: string) {
  const [x,y] = await Promise.all([crypto.subtle.digest('SHA-256', encode(a)), crypto.subtle.digest('SHA-256', encode(b))]);
  const left = new Uint8Array(x), right = new Uint8Array(y); let diff = 0;
  for (let i=0;i<left.length;i++) diff |= left[i] ^ right[i];
  return diff === 0;
}
export async function verifyTurnstile(token: string, env: IntegrationEnv): Promise<void> {
  demand(env.TURNSTILE_SECRET_KEY, 503, 'Turnstile unavailable');
  demand(typeof token === 'string' && token.length > 0 && token.length <= 2048);
  let result: any;
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method:'POST', body:new URLSearchParams({secret:env.TURNSTILE_SECRET_KEY, response:token}), signal:AbortSignal.timeout(10000),
    });
    demand(response.ok, 503, 'Turnstile unavailable'); result = await response.json();
  } catch { throw new IntegrationError(503, 'Turnstile unavailable'); }
  demand(result.success === true && result.hostname === new URL(env.PUBLIC_ORIGIN).hostname && result.action === (env.TURNSTILE_ACTION || 'checkout'), 403, 'Turnstile rejected');
}
