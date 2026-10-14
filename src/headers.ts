import { base64, encode } from './shared';

const common = {
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
};
function media(origin: string | undefined) {
  try { const url = new URL(origin ?? ''); return url.protocol === 'https:' ? ` ${url.origin}` : ''; } catch { return ''; }
}
// Inline style attributes/tags come from Astro and Radix; scripts stay strict.
const base = (img: string) => `default-src 'self'; img-src 'self' data:${img}; style-src 'self' 'unsafe-inline'; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`;

/** Admin SPA: Vite bundles only, no inline script, no third-party frames. blob: is the local upload preview. */
export function adminHeaders(mediaOrigin?: string): Record<string, string> {
  return { ...common, 'Content-Security-Policy': `${base(` blob:${media(mediaOrigin)}`)}; script-src 'self'; frame-src 'none'` };
}
/** Storefront: Turnstile script/frame, product media, and hashes of the inline scripts Astro emits for islands. */
export function storefrontHeaders(mediaOrigin: string | undefined, scriptHashes: string[]): Record<string, string> {
  const hashes = scriptHashes.map(h => ` '${h}'`).join('');
  return { ...common, 'Content-Security-Policy': `${base(media(mediaOrigin))}; script-src 'self' https://challenges.cloudflare.com${hashes}; frame-src https://challenges.cloudflare.com` };
}

const memo = new Map<string, string>();
/** CSP sha256 sources for every inline (src-less) script in an HTML document. */
export async function inlineScriptHashes(html: string) {
  const hashes = new Set<string>();
  for (const [, attributes, body] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\ssrc\s*=/i.test(attributes) || !body) continue;
    let value = memo.get(body);
    if (!value) {
      value = `sha256-${base64(await crypto.subtle.digest('SHA-256', encode(body)))}`;
      if (memo.size < 100) memo.set(body, value);
    }
    hashes.add(value);
  }
  return [...hashes];
}

export function withAdminHeaders(response: Response, mediaOrigin?: string) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(adminHeaders(mediaOrigin))) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
/** Astro inlines island bootstrap scripts; hashing the rendered document keeps script-src free of 'unsafe-inline'. */
export async function withStorefrontHeaders(response: Response, mediaOrigin?: string) {
  const headers = new Headers(response.headers);
  let body: BodyInit | null = response.body, hashes: string[] = [];
  if (headers.get('Content-Type')?.includes('text/html')) {
    const html = await response.text();
    body = html; hashes = await inlineScriptHashes(html);
  }
  for (const [name, value] of Object.entries(storefrontHeaders(mediaOrigin, hashes))) headers.set(name, value);
  return { body, headers };
}
