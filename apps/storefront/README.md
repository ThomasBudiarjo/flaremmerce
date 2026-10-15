# Storefront integration

Astro 7 + Cloudflare adapter 14, React islands. Build from the repository root with `npm run check` and
`npm run build`. The generated Worker is `dist/server/entry.mjs`; public
assets and prerendered policies, cart, and order shells are in `dist/client/`.
Homepage `/` immediately shows the SSR catalogue; `/catalog` uses the same component.
Both page by number (`page`, with `limit` 10/25/50, default 25) with a total and 60-second
public caching; old `after` slug links open page one. Page size is a display preference, so the
canonical URL carries only `category` and `page`. Product detail pages
are also server-rendered, never client-only. There is no separate editorial landing page.

## Parent Worker composition

`src/entry.ts` delegates SSR to `@astrojs/cloudflare/handler`. Storefront middleware imports
`env` from `cloudflare:workers` and supplies `locals.catalog(path)` by directly calling the
business Worker API. It forwards no user cookies to public catalogue reads. No CATALOG_API
service binding, second deployment or recursive same-origin HTTP request is necessary.

Public SSR responses declare a 60-second shared TTL. The parent owns explicit
Workers Cache API lookup/storage; this header alone does not implement caching.
No Astro session API is used; `session:false` prevents implicit KV
requirements. Better Auth owns sessions through HttpOnly cookies and D1.

Browser calls all APIs same-origin. `/api/config` must provide the public
Turnstile site key and Google enabled flag. Turnstile action is `checkout`.
Quote expiry accepts epoch milliseconds or ISO date strings. Campaign ship
dates accept business date strings, and timestamps accept epoch milliseconds.
Shipping destination currently uses a documented explicit RajaOngkir ID input;
no region-search endpoint was provided. Configure the matching provider ID scheme.

Only cart items enter localStorage. Guest order access is retained in sessionStorage
for this tab and explicitly shown for private saving; it never enters a URL.
Order reads use `X-Order-Token`. Checkout retries retain the idempotency key for
an unchanged payload while requesting a fresh Turnstile token. If a request's
outcome is ambiguous, the UI does not declare payment success or manufacture a
provider payment URL. Cross-tab/reload checkout recovery is not promised.

The admin sibling builds static assets under `/admin/`; parent routing must serve
its index asset at `/admin/` and its hashed assets at `/admin/assets/*` (not a generated
request to `/admin/index.html`, which Cloudflare redirects back to `/admin/`).
No auth secret is compiled into either bundle.
