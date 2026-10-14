export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

/** Reads at most `limit` bytes; the caller decides how the bytes are decoded (webhooks must stay byte-exact). */
export async function readBounded(stream: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const reader = stream.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Body too large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

// Stored encodings differ on purpose: guest tokens/scopes are hex, provider digests and quote fingerprints are base64.
export const encode = (value: string) => new TextEncoder().encode(value);
export const base64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
export async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export async function digest(value: string) { return base64(await crypto.subtle.digest('SHA-256', encode(value))); }

/** DOKU Checkout payment_due_date; commerce expiry is measured from attempt creation. */
export const PAYMENT_DUE_MINUTES = 60;

export const validSlug = (value: string) => value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value);

/** Integer minutes from an optional env var, clamped to [0,max]; anything unparsable falls back. */
export function envMinutes(value: string | undefined, fallback: number, max: number) {
  const parsed = value === undefined || value.trim() === '' ? NaN : Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? Math.min(parsed, max) : fallback;
}

type Normalizer = (value: string) => string | null;
export const catalogParams: Record<string, Normalizer> = {
  after: value => validSlug(value) ? value : null,
  limit: value => /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 90 ? String(Number(value)) : null,
};
/** Shared-cache key from path plus normalized allowlisted params. Null means "do not cache": the handler rejects or serves uncached. */
export function publicCacheKey(url: URL, allowed: Record<string, Normalizer> = {}): Request | null {
  const key = new URL(`${url.origin}${url.pathname}`);
  for (const [name, normalize] of Object.entries(allowed)) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    const normalized = normalize(value);
    if (normalized === null) return null;
    key.searchParams.set(name, normalized);
  }
  return new Request(key);
}

/** Distinct cart lines accepted by the storefront cart, shipping quote and checkout. */
export const MAX_CART_LINES = 30;

/** Positive integer from an optional env var; anything unparsable falls back. */
export function envCount(value: string | undefined, fallback: number) {
  const parsed = value === undefined || value.trim() === '' ? NaN : Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function hmac(secret: string, value: string) {
  const key = await crypto.subtle.importKey('raw', encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encode(value))), b => b.toString(16).padStart(2, '0')).join('');
}
/** Keyed hash secret for risk identities. Development has a fixed fallback; elsewhere it fails closed. */
export function optionalRiskSecret(env: { RISK_HASH_SECRET?: string; APP_ENV?: string }): string | null {
  if (env.RISK_HASH_SECRET && env.RISK_HASH_SECRET.length >= 32) return env.RISK_HASH_SECRET;
  return env.APP_ENV === 'development' ? 'flaremmerce-development-risk-hash-secret' : null;
}
export function riskSecret(env: { RISK_HASH_SECRET?: string; APP_ENV?: string }): string {
  const secret = optionalRiskSecret(env);
  if (!secret) throw new HttpError(503, 'Checkout unavailable');
  return secret;
}
export type RiskKind = 'email' | 'phone' | 'ip';
// Domain-separated so an email can never collide with a phone or IP of the same text.
export const riskHash = (secret: string, kind: RiskKind, value: string) => hmac(secret, `${kind}:${value}`);
export const normalizeEmail = (value: string) => value.trim().toLowerCase();
/** Indonesian mobile number as +628…; accepts 08…, 628… and +628… with common separators. */
export function normalizePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  const match = /^(?:\+62|62|0)(8[1-9]\d{6,10})$/.exec(compact);
  return match ? `+62${match[1]}` : null;
}
export const clientIp = (request: Request) => request.headers.get('CF-Connecting-IP')?.slice(0, 64) || 'unknown';

export type AdminRole = 'owner' | 'ops' | 'catalog';
export const ADMIN_ROLES: readonly AdminRole[] = ['owner', 'ops', 'catalog'];
type AdminArea = 'any' | 'ops' | 'catalog' | 'owner';
const areas: [RegExp, AdminArea][] = [
  [/^\/api\/admin\/me$/, 'any'],
  [/^\/api\/admin\/(?:operations|orders|review|blocklist|customers|users|files|exports)(?:\/|$)/, 'ops'],
  [/^\/api\/admin\/(?:products|variants|media|inventory|campaigns|categories)(?:\/|$)/, 'catalog'],
];
/** Unlisted admin paths are owner-only, so a new route is never silently exposed to a narrower role. */
export function adminPermits(role: AdminRole, path: string) {
  const area = areas.find(([pattern]) => pattern.test(path))?.[1] ?? 'owner';
  return role === 'owner' || area === 'any' || area === role;
}
