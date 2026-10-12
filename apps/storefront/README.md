# Storefront integration

Astro 5 + Cloudflare adapter 12, React islands. Build with `npm run check` and
`npm run build`. The generated Worker is `dist/_worker.js/index.js`; public
assets and prerendered landing, policies, cart, and order shells are in `dist/`.
Catalogue and product detail pages are server-rendered, never client-only.

## Parent Worker composition

SSR needs the same catalogue API as browser requests without recursive HTTP
requests to the storefront. Pass an in-process binding into Astro's environment:

```ts
return astroWorker.fetch(
  request,
  {
    ...env,
    CATALOG_API: {
      fetch: (catalogRequest: Request) => businessApi(catalogRequest, env, ctx),
    },
  },
  ctx,
);
```

`businessApi` above means the parent's actual API handler (not a new service).
The catalogue request is GET `https://catalog.internal/api/catalog` or
`/api/catalog/:slug`, has no cookie/session, and expects the documented response.
If the handler validates host, replace the internal hostname in `src/lib/catalog.ts`
or rewrite the request in this binding. Alternatively inject `locals.catalog(path)`
returning a Response, bind a distinct API service as `CATALOG_API`, or set
`API_ORIGIN` to a distinct API origin. Do not set it to the SSR origin.

Public SSR responses declare a 60-second shared TTL. The parent owns explicit
Workers Cache API lookup/storage; this header alone does not implement caching.
No Astro session API is used; the unused memory driver prevents implicit KV
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
its `dist/index.html` at `/admin/` and its hashed assets at `/admin/assets/*`.
No auth secret is compiled into either bundle.
