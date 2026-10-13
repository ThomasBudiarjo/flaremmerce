# Storage and inbound email

Apply migrations 0001, 0002, then 0003 before serving traffic. No new npm dependencies: this module uses existing integration authorization and Workers D1/R2 types; tests use existing Vitest 4, Miniflare and Node crypto for real Better Auth signed session fixtures.

## Parent wiring

- Extend the worker Env with `StorageEnv` from `src/storage.ts` (structural DB, PUBLIC_ORIGIN, optional MEDIA, PRIVATE_FILES, MEDIA_ORIGIN). Actual HTTP admin access also needs existing Better Auth/Google credentials from IntegrationEnv.
- Dispatch `await storageRequest(request, env)` before commerce's `/api` router; return the non-null response. Other paths return null without auth reads.
- Add `email(message, env) { return receiveEmail(message, env); }` to the worker export. Configure Email Routing to this Email Worker; no sending binding or Paid API is used.
- Bind separate R2 Standard buckets MEDIA and PRIVATE_FILES. PRIVATE_FILES must have public access/custom domains disabled. MEDIA_ORIGIN must be an HTTPS origin on a production custom domain (not r2.dev). Configure that domain to expose only MEDIA, with nosniff headers. Missing bindings fail closed.
- Include `tests/storage.test.ts` in the integration Vitest config.

## API and safety limits

POST `/api/admin/media?productId=<optional-id>` accepts raw JPEG/PNG/WebP bytes, at most 5 MiB, checks declared type against magic signature, and returns `{id,url}` with 201. SVG is excluded. Magic verification is not a full image decoder or malware scan; pre-generate/validate image variants before upload, not CPU-heavy runtime resizing. Product references are foreign keys. Every upload receives a new UUID key, conditional create-only R2 write and immutable public cache metadata; there is no overwrite endpoint.

Admin product creation/details now expose file selection, preview and primary-image saving. An upload alone does not change the catalogue: existing products persist `imageUrl` through product PATCH; new products associate a matching unbound `product_media` URL atomically during creation. Already-bound media are never reassigned. Failed/incomplete uploads block saving; cancellation or a newer selection ignores superseded results but can leave unused objects for the reconciliation procedure below. This is primary-image management, not a gallery/list/delete or runtime resizing feature.

POST `/api/admin/files` accepts raw bytes up to 5 MiB, returning only `{id}`. GET `/api/admin/files/:id` requires fresh session/role verification and returns octet-stream, forced attachment, nosniff, sandbox CSP and private no-store. User filenames/content types are never trusted for response headers. No public path or inbound-message read/render endpoint is provided. All uploads require exact trusted Origin and fresh admin authorization before body reads.

Inbound raw mail is bounded to 5 MiB by both advertised size and actual stream bytes. Envelope sender/recipient are limited to 320 characters and exclude CR/LF/NUL. Only IDs, private object key, size, envelope metadata and UTC epoch-millisecond timestamp enter D1. Subject, headers, body and MIME attachments remain raw in private R2: no HTML rendering, MIME expansion, forwarding, replies, mailbox/IMAP or outbound promise. Oversize messages are rejected; infrastructure errors propagate rather than falsely acknowledging durable receipt. Retries may produce duplicate records; no fabricated provider event identity/dedup guarantee. Production retention/abuse limits and operator support workflow remain deployment prerequisites. No raw/token/PII logging occurs.

## R2/D1 failure and orphan reconciliation

R2 and D1 have no shared transaction. Upload writes R2 first, then D1; success is returned only after both. On D1 failure, query metadata by exact random key before deleting: retain referenced objects if a response was ambiguous; if the lookup itself fails, retain for recovery. Process termination, ambiguous R2 put or failed cleanup can leave orphans. Never delete objects merely because an API response failed.

Operator cleanup must page through each prefix (`media/`, `files/`, `inbound/`) in small batches, use a generous age grace period longer than in-flight requests/retries, and check the corresponding D1 object_key index against authoritative database state before deleting unreferenced objects. Re-check before deletion; suspend cleanup during D1 outages/migrations. Record only counts and technical IDs, not envelopes or payloads. This scanner is an operational procedure, not an implemented cron job. Retention deletes require coordinated metadata/object cleanup and explicit PII policy; metadata can also reference missing objects after independent bucket loss, requiring restore/repair. Public CDN caches may outlive an object deletion: use versioned keys and a verified purge process when removal is required.
