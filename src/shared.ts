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

/** Normalized value, null for invalid (never cached, handler rejects), undefined for "same as absent". */
type Normalizer = (value: string) => string | null | undefined;
/** Name search: whitespace-collapsed lowercase, 2–60 characters; blank is no search (an empty GET form field). */
export function searchTerm(value: string) {
  const term = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!term) return undefined;
  return term.length >= 2 && term.length <= 60 ? term : null;
}
export const catalogParams: Record<string, Normalizer> = {
  after: value => validSlug(value) ? value : null,
  limit: value => /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 90 ? String(Number(value)) : null,
  category: value => value === '' ? undefined : validSlug(value) ? value : null,
  q: searchTerm,
};
/** LIKE pattern matching `term` literally anywhere; pair with ESCAPE '\'. */
export const likePattern = (term: string) => `%${term.replace(/[\\%_]/g, c => `\\${c}`)}%`;
/** D1 rejects LIKE/GLOB patterns longer than 50 bytes with an internal error; check before querying. */
export const likeFits = (term: string) => new TextEncoder().encode(likePattern(term)).length <= 50;
/** Shared-cache key from path plus normalized allowlisted params. Null means "do not cache": the handler rejects or serves uncached. */
export function publicCacheKey(url: URL, allowed: Record<string, Normalizer> = {}): Request | null {
  const key = new URL(`${url.origin}${url.pathname}`);
  for (const [name, normalize] of Object.entries(allowed)) {
    const value = url.searchParams.get(name);
    if (value === null) continue;
    const normalized = normalize(value);
    if (normalized === null) return null;
    if (normalized !== undefined) key.searchParams.set(name, normalized);
  }
  return new Request(key);
}
/** Allowlisted catalog query as the handler reads it (same normalizers as the cache key); null when invalid. */
export function catalogQuery(params: URLSearchParams) {
  const out: Record<string, string> = {};
  for (const [name, normalize] of Object.entries(catalogParams)) {
    const value = params.get(name);
    if (value === null) continue;
    const normalized = normalize(value);
    if (normalized === null) return null;
    if (normalized !== undefined) out[name] = normalized;
  }
  return out;
}

type Dimensions = { weight: number; length_cm?: number | null; width_cm?: number | null; height_cm?: number | null };
/** Billed grams per unit: the larger of actual and volumetric weight (L×W×H cm / divisor, in kg) when all dimensions are known. */
export function chargeableWeight(v: Dimensions, divisor: number) {
  if (!v.length_cm || !v.width_cm || !v.height_cm) return v.weight;
  return Math.max(v.weight, Math.ceil(v.length_cm * v.width_cm * v.height_cm * 1000 / divisor));
}
export const volumetricDivisor = (env: { VOLUMETRIC_DIVISOR?: string }) => envCount(env.VOLUMETRIC_DIVISOR, 6000);
export const maxCartWeight = (env: { MAX_CART_WEIGHT_G?: string }) => envCount(env.MAX_CART_WEIGHT_G, 50_000);
export const cartWeightMessage = (limit: number) => `Berat total melebihi batas ${new Intl.NumberFormat('id-ID').format(limit / 1000)} kg per pesanan`;

// Official public tracking pages. None accepts a documented resi deep link, so the resi is shown for the shopper to paste.
const couriers: Record<string, { name: string; url: string }> = {
  jne: { name: 'JNE', url: 'https://www.jne.co.id/tracking-package' },
  jnt: { name: 'J&T Express', url: 'https://jet.co.id/track' },
  sicepat: { name: 'SiCepat', url: 'https://www.sicepat.com/checkAwb' },
  anteraja: { name: 'AnterAja', url: 'https://anteraja.id/tracking' },
  pos: { name: 'Pos Indonesia', url: 'https://www.posindonesia.co.id/id/tracking' },
  tiki: { name: 'TIKI', url: 'https://www.tiki.id/id/track' },
  ninja: { name: 'Ninja Xpress', url: 'https://www.ninjaxpress.co/id-id/tracking' },
  lion: { name: 'Lion Parcel', url: 'https://lionparcel.com/track/stt' },
  ide: { name: 'ID Express', url: 'https://idexpress.com/lacak-paket/' },
  sap: { name: 'SAP Express', url: 'https://www.sap-express.id/layanan/tracking' },
  wahana: { name: 'Wahana', url: 'https://www.wahana.com/lacak' },
};
/** Courier code from an explicit value or a quote service such as `jne:REG`; unknown couriers keep only their code. */
export function tracking(resi: string | null | undefined, courier: string | null | undefined) {
  if (!resi) return null;
  const code = (courier ?? '').split(':')[0].trim().toLowerCase();
  const known = couriers[code];
  return { number: resi, courier: code || null, courierName: known?.name ?? (code ? code.toUpperCase() : null), url: known?.url ?? null };
}
export const COURIERS = Object.keys(couriers);
/** Latest shipped event's resi with a courier link (explicit courier, else the quoted service's courier). */
export function orderTracking(events: Record<string, unknown>[], shipping: { service?: string }) {
  const shipped = events.filter(e => e.kind === 'shipped').at(-1);
  if (!shipped) return null;
  const details = JSON.parse(String(shipped.details_json ?? '{}'));
  return tracking(details.tracking, details.courier ?? shipping.service);
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
/** Anything other than an explicit staging/development value behaves as production. */
export const environment = (env: { APP_ENV?: string }) => env.APP_ENV === 'staging' || env.APP_ENV === 'development' ? env.APP_ENV : 'production';
type FeatureEnv = { APP_ENV?: string; DOKU_CLIENT_ID?: string; DOKU_SECRET_KEY?: string; RAJAONGKIR_API_KEY?: string; RAJAONGKIR_ORIGIN?: string; RAJAONGKIR_COURIERS?: string; TURNSTILE_SITE_KEY?: string; TURNSTILE_SECRET_KEY?: string };
export const paymentsConfigured = (env: FeatureEnv) => !!(env.DOKU_CLIENT_ID && env.DOKU_SECRET_KEY);
export const shippingConfigured = (env: FeatureEnv) => !!(env.RAJAONGKIR_API_KEY && env.RAJAONGKIR_ORIGIN && env.RAJAONGKIR_COURIERS);
/** Only staging may run checkout without Turnstile keys; elsewhere a missing key keeps checkout fail-closed. */
export const turnstileSkipped = (env: FeatureEnv) => env.APP_ENV === 'staging' && !(env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY);
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
  [/^\/api\/admin\/(?:operations|orders|review|blocklist|customers|users|files|exports|summary)(?:\/|$)/, 'ops'],
  [/^\/api\/admin\/(?:products|variants|media|inventory|campaigns|categories)(?:\/|$)/, 'catalog'],
];
/** Unlisted admin paths are owner-only, so a new route is never silently exposed to a narrower role. */
export function adminPermits(role: AdminRole, path: string) {
  const area = areas.find(([pattern]) => pattern.test(path))?.[1] ?? 'owner';
  return role === 'owner' || area === 'any' || area === role;
}
