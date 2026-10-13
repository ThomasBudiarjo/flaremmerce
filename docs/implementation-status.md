# Status implementasi — 12 Oktober 2026

Implementasi lokal, bukan status deployment. Tiga worktree paralel terintegrasi ke local main; commerce, integrasi dan UI direview saat integrasi. Storage/inbound dan operasi diselesaikan sebagai unit tambahan independen. Tidak ada push, provision resource cloud, produksi migration, billing activation atau deployment.

| Area | Yang tersedia | Batas verifikasi |
|---|---|---|
| Storefront/admin | Homepage langsung katalog SSR (juga tersedia di /catalog), static policies, React cart/guest checkout/order status; admin memakai shadcn/ui Radix Nova neutral: sidebar, tabel, form, dialog, empty state resmi, Lucide/Geist dan drawer reduced-motion-aware; Google/bootstrap, catalogue/archive, SKU, inventory, PO, milestone/fulfillment dan review | Chromium desktop/390px: login/logout asli, create produk dan penyesuaian stok D1 lokal, pencarian SKU, dialog/Escape dan drawer. State order memakai fixture lokal disposable, bukan transaksi provider. Google live belum diuji |
| Commerce D1 | Reservasi multi-item atomik, stok/kuota finite/unlimited, snapshot immutable, scoped idempotency, payment attempt durable, paid/outbox atomik, ledger/audit | Tes race/rollback memakai workerd D1; concurrency produksi/CPU Free belum diukur |
| Provider | Siteverify fail closed, DOKU create/signature/verified webhook/GET inquiry, Komerce quote dari berat server + fingerprint cart | HTTP provider terkontrol dalam tes, bukan credential/live provider |
| Auth | Better Auth/Drizzle D1 Google untuk production; tombol dev tanpa provider dengan session asli, secret lokal otomatis, opaque cookie, fresh PII/admin checks, singleton wizard, authorized roles | Login dev dan admin API HTTP 200 lewat portal; tes gating production, Origin proxy, revocation, takeover dan bootstrap race lokal. OAuth callback dan CPU cloud tetap gate |
| Background | Queues producer/consumer, bounded Cron reconciliation/outbox retry, durable manual review | Crash/duplicate/outage/recovery lokal; queue provisioning/DLQ operational belum dilakukan |
| R2/email | Versioned public media, private authenticated attachment, bounded raw inbound email private | D1/R2 nyata Miniflare; domain R2/Email Routing produksi belum dikonfigurasi. Bukan mailbox/support-reply UI |
| Caching | Public allowlist API/SSR 60 detik, pagination keys, tracking dibuang, static hash immutable, private no-store | Cache D1 bypass/keys di tes; custom domain multi-edge cache belum diuji |
| Recovery | Export+manifest checksum, restore isolated lokal, integrity/FK/table counts, safe read-only load script | Restore snapshot demo terbukti; bukan backup scheduler cloud atau DR/account-compromise protection |

## Gate yang tidak boleh disamarkan

1. Resource, secret dan hostname staging/production nyata + otorisasi provision/deploy/migration. Root Wrangler masih lokal/ID dummy.
2. DOKU live sandbox: metode merchant yang aktif, original request identity pada notifikasi Checkout, retry/ack, response format dan inquiry eligibility. Checkout-wide expiry/grace belum terbukti; reservasi ambigu ditahan dan diangkat ke manual review.
3. Komerce paket/key, origin ID dan pencarian wilayah nyata. Baseline UI menerima numeric destination ID, bukan pencarian alamat otomatis.
4. Google OAuth redirect/cookie propagation/state pada HTTPS staging dan Turnstile token invalid/replay nyata. Tes provider lokal tidak menggantikan ini.
5. WAF exception tepat path/method webhook, Free rule quota, public R2 custom domain dan private bucket nonpublic, DNS Email Routing.
6. Load/CPU/rows/kuota cloud dengan dataset nyata; 100 request GET katalog lokal bukan bukti medium traffic/concurrency aman di Workers Free.
7. Policy retensi PII/raw email/token, UX pemulihan guest lintas perangkat, RPO/RTO, jadwal backup cloud, alert destination dan prosedur manual payment review. Tidak ada otomatis refund/retur.

Fitur yang tidak masuk baseline tetap tidak dibuat: pajak, voucher/diskon, marketplace, multi-gudang, split shipment, refund/retur dan outbound customer email Paid. Port preview tidak mengotorisasi atau membuktikan deployment production.
