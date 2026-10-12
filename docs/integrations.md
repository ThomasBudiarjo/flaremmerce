# Integration contract and production gates

Verified against official documentation on 2026-10-12. These adapters are not a claim of live merchant onboarding or production readiness. No outbound email is configured or required.

## Dependencies and schema provenance

Root configuration pins runtime versions `better-auth@1.7.7`, `@better-auth/drizzle-adapter@1.7.7`, `drizzle-orm@0.45.4`. Integrated verification uses `vitest@4.1.11`, `miniflare@5.20261006.1-alpha`, `typescript@5.9.3`, `@cloudflare/workers-types@5.20261012.1`. Schema regeneration tools: `auth@1.7.7` (the current official CLI name, NOT the old `@better-auth/cli`), `drizzle-kit@0.31.10`.

`src/integrations/schema.ts` was generated using `auth generate` with a Google-only, sqlite Drizzle-adapter configuration. The auth portion of `migrations/0002_integrations.sql` was generated from that schema by Drizzle Kit. The generated nullable password column is library compatibility, NOT enabled password signup. No auth plugins require extra tables. Auth uses `transaction:false` because D1 does not support Drizzle interactive transactions; installation uses native atomic D1 batch instead. Tests run the actual adapter against Miniflare D1, not a mock SQL adapter. Full Google OAuth flow, callback cookie propagation, CPU budget on Workers Free and auth partial-failure recovery still require staging verification. Worker bundling may require `nodejs_compat`; parent must verify the production bundle.

Official references:
- https://www.better-auth.com/docs/adapters/drizzle
- https://www.better-auth.com/docs/concepts/session-management
- https://www.better-auth.com/docs/authentication/google
- https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
- https://developers.cloudflare.com/turnstile/get-started/server-side-validation/

## Auth/security

Bindings are enumerated by exported `IntegrationEnv`. `PUBLIC_ORIGIN` must be the canonical HTTPS origin (no path/trailing slash); OAuth callback is `/api/auth/callback/google`. Set separate Google client credentials, Better Auth secret (32+ characters), and bootstrap secret (32+ random characters) per deployment. Primary token is opaque; compact signed cookie cache is 60 seconds. Sensitive `requireAdmin`, `getCustomer` (checkout/private PII order ownership) and bootstrap call the official `getSession({query:{disableCookieCache:true}})`; admin roles are read directly from D1. The library get-session endpoint retains ordinary cookie caching. Requests without an actual Better Auth token cookie return null without requiring OAuth configuration, including guest scope-cookie retries.

`GET /api/setup` returns `{initialized:boolean}`. Same-origin POST accepts `{secret}` and requires a fresh session belonging to a verified Google identity. An immutable installation singleton plus atomic batch grants only one initial administrator under concurrency. The initialized owner cannot be removed through role management. Normal deletion/update of installation is blocked by triggers; recovery is an operator migration, never a public reset route. `POST /api/admin/roles` accepts `{userId,admin:boolean}` from an existing admin, only for already verified Google users, forbids own-role changes, and writes a role audit record. No email invites/public admin signup. Unauthorized Google users remain customers.

Mutations require exact Origin; OAuth GET callback remains library-managed. Input bodies are bounded (16 KiB API, 64 KiB webhook). Sensitive responses are private/no-store and failures are safe JSON. Rate limits/WAF and secret rotation remain deployment responsibilities. Siteverify enforces success, canonical hostname and `TURNSTILE_ACTION` (default `checkout`), rejects outages. Token expiry/replay is enforced by Cloudflare Siteverify (300 seconds, single use), not a local token cache.

## DOKU Checkout non-SNAP

Official references actually read:
- https://developers.doku.com/accept-payments/doku-checkout/integration-guide/backend-integration
- https://developers.doku.com/get-started-with-doku-api/signature-component/non-snap/signature-component-from-request-header
- https://developers.doku.com/get-started-with-doku-api/notification/http-notification-sample-non-snap
- https://developers.doku.com/get-started-with-doku-api/notification/best-practice
- https://developers.doku.com/accept-payments/doku-checkout/order-and-notification-handling/expired-notification

Default endpoint is `https://api-sandbox.doku.com/checkout/v1/payment`; production is opt-in `DOKU_MODE=production`. Missing client ID/secret closes payment operations. Currency is integer IDR rupiah (12 digits maximum). `reference` is a **precreated random stable merchant attempt reference**, alphanumeric/hyphen, at most 30 characters for card compatibility; it is both `order.invoice_number` and request ID. Each attempt must have a distinct reference. The optional `providerId` is documented response UUID when present, not a fabricated provider identity. Response invoice/amount/currency are checked. Return URL must be canonical-origin HTTPS. Checkout is SALE, 60-minute payment-page deadline, retries in the page disabled. Do not equate that deadline with safe inventory-release time. Enable only methods supported by the documented basic request (VA/card/QRIS/convenience store/OVO/Linkaja) in merchant settings; methods requiring customer metadata are not implemented by this minimal input interface.

Signature is precisely base64 SHA256 of the **unchanged raw JSON body**, then HMAC-SHA256 over newline-separated Client-Id, Request-Id, Request-Timestamp, Request-Target, Digest (no trailing newline), prefixed `HMACSHA256=`. Notification target is actual merchant URL pathname. Client ID is matched to configured merchant; signature comparison is fixed-size digest comparison. Timestamps are syntactically checked; no invented five-minute replay cutoff (would break legitimate retries). Durable inbox dedup is essential.

Non-SNAP docs define notification Request-Id as DOKU's unique random notification ID used to prevent duplicate notifications. `eventKey = doku:<clientId>:<Request-Id>`. Commerce must insert this in its own durable payment inbox with a unique constraint BEFORE a 2xx acknowledgment. Match stable reference to a preexisting attempt, authoritative expected amount and currency; missing/unknown attempt or mismatch goes to manual review, never paid. If original_request_id is provided it must match the stable creation request ID; QRIS sample does not always include it, so merchant invoice is the anchor. Do not map order using a response UUID alone. Integration does not own commerce inbox or mutate orders.

**Critical provider semantics:** official best-practice docs say Checkout must IGNORE `FAILED` because customer may switch method and succeed. The adapter returns verified SUCCESS as succeeded and verified FAILED as ignored. Commerce durably stores/deduplicates ignored events before 2xx acknowledgment, without changing order or reservation. Unsupported refund/void/capture/authorization/unknown webhook statuses remain 422. A distinct success notification on an already paid/completed order is conservatively flagged additional_payment_confirmation: investigate whether duplicate evidence or duplicate money, never double fulfill.

Status inquiry is implemented from [Non-SNAP Check Status](https://developers.doku.com/get-started-with-doku-api/check-status-api/non-snap) and [GET signature](https://developers.doku.com/get-started-with-doku-api/signature-component/non-snap/signature-from-api-get-method): GET `/orders/v1/status/{invoice}`, random request ID, canonical HMAC without Digest. Scanner begins at least 60 seconds after attempt creation. Matching invoice/amount/currency and SALE SUCCESS can confirm payment; FAILED/PENDING/TIMEOUT/REDIRECT remain pending. Invalid identity, unavailable provider and unsupported status remain unknown. An EXPIRED channel does not by itself prove the whole Checkout cannot still be paid: automatic Checkout-wide release/grace remains gated by merchant verification. A timeout never blindly recreates payment. No live sandbox transaction or API eligibility test was performed (no credentials).

## RajaOngkir Komerce current direct-search API

Official reference read:
https://www.rajaongkir.com/docs/shipping-cost/endpoint-rajaongkir-for-search-base/calculate-domestic-cost

POST `https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost`, `key` header, URL-encoded origin/destination IDs from domestic destination search, integer grams, configured courier codes, `price=lowest`. The documentation contradicts itself in generic tips mentioning Bearer authorization and a boolean price type; implementation deliberately follows its concrete cURL/header/body table and success example (`meta.status="success"`, data[].cost), not that generic tip. Live key/package and origin/destination eligibility must be tested before production. No invented rate limit or provider-guaranteed quote TTL.

`POST /api/shipping/quote` accepts `{destination,items:[{variantId,quantity}]}`. Destination is a numeric direct-search ID, NOT a free-form address or legacy city ID. Origin and courier list are server bindings. Reads `product_variants.id/weight`; parent catalog must store positive integer grams. Duplicate variants aggregate; catalog determines weight, never browser weight/tariff. Positive integer tariffs are persisted atomically with id, fingerprint, destination, service (`courier:service`), amount, weight, expires_at and provider details_json. Response is `{quotes:[{id,service,amount,expiresAt}]}` in epoch milliseconds. Default five-minute TTL is a local conservative policy, NOT a provider guarantee.

Fingerprint is base64 SHA256 of JSON `{origin,destination,weight,items}` with aggregated items sorted by variant ID; each item is `[variantId,quantity]`. Commerce re-reads the quote and verifies destination, recomputed authoritative cart weight, expiry and exact fingerprint including configured origin; it uses persisted amount, never submitted tariff. Expired quotes require fresh quote/customer confirmation. Missing keys/outage/invalid provider response fails closed, never free or stale shipping. Unknown catalog variants fail. Empty supported-service list returns empty quotes, not zero-cost shipping. Region lookup UI, cleanup of expired quotes, rate limiting and API subscription validation are parent/deployment gates.

## Verification

`vitest run tests/integrations.test.ts` covers actual D1 schema application, signed Better Auth sessions, tamper/revocation, concurrent bootstrap winner, immutable installation, wrong secret/unverified account/origin/public role escalation, independent DOKU signature fixtures and raw-body tamper, unknown/FAILED provider statuses and identity mismatch, unknown lookup, Siteverify failure/hostname/action/outage, and catalog-authoritative persisted tariffs. No live Google/DOKU/Komerce/Turnstile credentials or outbound email were used. Local adapter execution plus workerd-backed D1 is not full deployed OAuth/provider E2E or Free CPU profiling.
