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
