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
/** Longest public catalog search: `%term%` must stay within D1's 50-byte LIKE pattern limit. */
export const MAX_SEARCH_LENGTH = 48;
/** Name search: whitespace-collapsed lowercase, 2–48 characters that fit a LIKE pattern; blank is no search (an empty GET form field). */
export function searchTerm(value: string) {
  const term = value.trim().replace(/\s+/g, ' ').toLowerCase();
  if (!term) return undefined;
  // Multi-byte text and escaped `%`/`_` take more pattern bytes than characters, so the length cap alone is not enough.
  return term.length >= 2 && term.length <= MAX_SEARCH_LENGTH && likeFits(term) ? term : null;
}
/** Page sizes the list paginators offer; APIs accept any size up to their own limit. */
export const PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 25;
/** Numbered pages skip rows with OFFSET, which D1 still reads and bills; the cap bounds that scan. */
export const MAX_PAGE = 1000;
/** 1-based ?page= value, null when invalid. */
export const pageNumber = (value: string) => /^\d{1,4}$/.test(value) && Number(value) >= 1 && Number(value) <= MAX_PAGE ? Number(value) : null;
/** Page numbers around `page`: always the first, the last and the neighbours; null marks a gap. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const shown = [...new Set([1, page - 1, page, page + 1, pages])].filter(n => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const n of shown) {
    // A gap of one page shows that page: "…" would take the same space and hide it.
    if (n - previous === 2) out.push(n - 1);
    else if (n - previous > 2) out.push(null);
    out.push(n);
    previous = n;
  }
  return out;
}
export const catalogParams: Record<string, Normalizer> = {
  after: value => validSlug(value) ? value : null,
  limit: value => /^\d{1,2}$/.test(value) && Number(value) >= 1 && Number(value) <= 90 ? String(Number(value)) : null,
  page: value => { const page = pageNumber(value); return page === null ? null : page === 1 ? undefined : String(page); },
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
/** Units per cart line accepted by the cart preview and checkout. */
export const MAX_LINE_QUANTITY = 100;

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
/** Indonesian mobile number (10–13 digits written as 08…) as +628…; accepts 08…, 628…, +628… and 00628… with common separators. */
export function normalizePhone(value: string): string | null {
  const compact = value.trim().replace(/[\s().-]/g, '');
  const match = /^(?:\+62|0062|62|0)(8[1-9]\d{7,10})$/.exec(compact);
  return match ? `+62${match[1]}` : null;
}
export const clientIp = (request: Request) => request.headers.get('CF-Connecting-IP')?.slice(0, 64) || 'unknown';
/**
 * One spelling per address, so a block typed by hand hashes like CF-Connecting-IP: IPv4 without leading zeros,
 * IPv6 compressed and lowercase. Null when the text is not an IP address.
 */
export function normalizeIp(value: string): string | null {
  const ip = value.trim();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  // Parsed by hand: the URL parser would read "010" as octal.
  if (v4) return v4.slice(1).every(part => Number(part) <= 255) ? v4.slice(1).map(Number).join('.') : null;
  if (!ip.includes(':') || !/^[0-9a-fA-F:.]{2,45}$/.test(ip)) return null;
  try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1); } catch { return null; }
}
/** Rate-limit identity: an IPv6 client usually controls a whole /64, so it counts as one; IPv4 stays per address. */
export function rateLimitIp(value: string) {
  const ip = normalizeIp(value);
  if (!ip?.includes(':')) return ip ?? value;
  // The normalized form has at most one "::" and no embedded IPv4 part.
  const [head, tail] = ip.split('::'), left = head ? head.split(':') : [], right = tail ? tail.split(':') : [];
  const groups = tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
  return `${groups.slice(0, 4).join(':')}::/64`;
}

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
