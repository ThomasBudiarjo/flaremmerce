# Status implementasi — 13 Oktober 2026

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

## Lanjutan development — 13 Oktober 2026

Empat worktree terpisah (wilayah, foto, review, riwayat) diintegrasikan ke local main. Perubahan ini belum dipush atau dideploy; migration 0004/0005 hanya diterapkan pada D1 lokal disposable.

- **Wilayah checkout:** pencarian server-only Komerce dengan input bounded dan maksimal 20 hasil, pemilihan wilayah bernama, pengisian kota/kode pos, serta pembatalan tujuan/quote/consent saat pencarian berubah. Respons pencarian dan quote yang sudah superseded diabaikan. Nama tujuan lengkap tetap terbaca di layar sempit. Tanpa credential/provider, pencarian gagal tertutup dan tidak menjadi gratis ongkir.
- **Foto admin:** upload JPEG/PNG/WebP maksimal 5 MiB, preview, pembatalan pilihan dan penyimpanan foto utama untuk produk baru/existing. Upload detached dikaitkan atomik saat produk dibuat; objek R2 tetap immutable. Upload gagal/belum selesai memblokir simpan, dan hasil upload lama tidak menggantikan pilihan baru. Belum ada gallery atau image resizing runtime.
- **Manual review:** bukti ringkas order/attempt/event, catatan wajib, status open/resolved dan buka kembali, compare-and-swap version untuk menolak update stale, serta audit immutable. Daftar bukti/audit bounded dan terindeks. Menandai ditangani eksternal tidak mengubah payment/order/reservasi/stock/outbox dan bukan fitur refund.
- **Riwayat customer:** GET `/api/orders` memakai fresh session, ownership `customer_id`, cursor deterministik dan summary private/no-store. UI menyediakan sign-in Google, empty/error/retry/load-more, detail dan refresh referensi yang sudah dibuka. Tidak mengklaim guest order dari email sama atau memulihkan token guest.

Pemeriksaan gabungan: `npm run check`, `npm test` (25 commerce + 22 integration/storage/checkout), `npm run build` dan `npm run deploy:check` dry-run lulus. Hint FormEvent dan warning rename plugin Vitest sudah ada sebelumnya.

Browser Chromium desktop/390px memeriksa session dev asli, foto di R2/D1 lokal beserta reload, review resolved/audit dengan order tetap pending dan stok reservasi tetap sama, serta pagination 20→22 order milik akun tanpa memasukkan guest ber-email sama. Detail order menerima focus dan tidak berubah ke input referensi lain ketika diperbarui. Ini pemeriksaan layout Chromium, bukan real-device/touch test. Video memakai data order sintetis; pencarian/quote happy path memakai respons UI terkontrol, sedangkan endpoint server memakai tes provider terkontrol. Gambar dilayani melalui bridge R2 lokal disposable, bukan custom domain cloud. Tidak ada transaksi DOKU, OAuth Google atau Komerce live yang diklaim.

## Gate yang tidak boleh disamarkan

1. Resource, secret dan hostname staging/production nyata + otorisasi provision/deploy/migration. Root Wrangler masih lokal/ID dummy.
2. DOKU live sandbox: metode merchant yang aktif, original request identity pada notifikasi Checkout, retry/ack, response format dan inquiry eligibility. Checkout-wide expiry/grace belum terbukti; reservasi ambigu ditahan dan diangkat ke manual review.
3. Komerce paket/key, origin ID dan pencarian wilayah nyata. UI/API pencarian wilayah sudah ada; eligibility paket, cakupan wilayah dan kuota/rate limiting tetap perlu verifikasi provider/staging.
4. Google OAuth redirect/cookie propagation/state pada HTTPS staging dan Turnstile token invalid/replay nyata. Tes provider lokal tidak menggantikan ini.
5. WAF exception tepat path/method webhook, Free rule quota, public R2 custom domain dan private bucket nonpublic, DNS Email Routing.
6. Load/CPU/rows/kuota cloud dengan dataset nyata; 100 request GET katalog lokal bukan bukti medium traffic/concurrency aman di Workers Free.
7. Policy retensi PII/raw email/token, UX pemulihan guest lintas perangkat, RPO/RTO, jadwal backup cloud, alert destination dan keputusan/prosedur penanganan finansial eksternal. UI manual review sudah tersedia; tidak ada otomatis refund/retur.

Fitur yang tidak masuk baseline tetap tidak dibuat: pajak, voucher/diskon, marketplace, multi-gudang, split shipment, refund/retur dan outbound customer email Paid. Port preview tidak mengotorisasi atau membuktikan deployment production.
