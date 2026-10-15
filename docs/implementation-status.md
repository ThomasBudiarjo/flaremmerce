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

## Penuntasan workflow baseline — 13 Oktober 2026

- Edit/activate/archive produk dan SKU, tambah SKU dengan limit 30 atomik, serta initial inventory/ledger/audit dalam satu D1 batch. PATCH tidak lagi mewarisi default create Zod 4 yang dapat menghapus description atau mengubah mode PO secara tidak sengaja.
- Saldo dan ledger inventory, listing/edit/deactivate campaign future/past/inactive, serta pagination dengan cursor tie-safe dan terminal null. Counter campaign dan snapshot order tidak ditimpa oleh draft UI.
- Detail item/contact/address/shipping/payment/timeline order dan fulfillment paid-only processing → shipped dengan resi → delivered/completed. Closing dialog, pergantian tab dan response terlambat tidak membatalkan rekonsiliasi write yang sudah diakui server atau menimpa draft baru.
- Panel Operasional dengan sampel oldest-first terindeks dan bounded; request ID/error/retry logs tanpa raw payload/URL/credential; Cron mencoba kedua scanner meskipun salah satunya gagal. Ini bukan external alert service.
- Customer dapat membuka kembali payment URL HTTPS attempt pending yang sama; tidak membuat attempt baru dan tidak menawarkan pembayaran ulang pada completed order.
- Import backup menyiapkan seluruh definisi tabel sebelum row insert, memperbaiki export populated Better Auth yang mereferensikan tabel parent belum dibuat. SQL asli/checksum, quoted multiline text, indeks dan trigger dipertahankan; temporary SQL privat dibersihkan.

Migration 0006/0007 hanya diterapkan lokal. Oracle telah mereview katalog, inventory/campaign, order, operations, payment resume dan recovery; finding dibetulkan dan review ulang masing-masing tidak menyisakan blocker. Pemeriksaan ulang 13 Oktober 20:16 UTC: **100 tes lulus** (34 commerce + 66 integration/storage/checkout/operations/UI/recovery), termasuk restore workerd nyata. Check/build/deploy dry-run lulus; production dependency audit tidak menemukan vulnerability. Bukti sebelum/sesudah, angka query dan batas klaim dicatat di [local-verification.md](local-verification.md). Durasi soak hanya boleh diklaim setelah prosesnya selesai dan timestamp diverifikasi.

## Hasil overnight — 14 Oktober 2026

Lima jam nyata (18000.091 detik): 60 suite penuh, 6000 GET load + 240 smoke, nol unexpected failure; 60 anonymous-admin 401/private-no-store memang diharapkan. Sesudah soak, final Oracle review menemukan dua race UI tambahan; lima regression scenarios gagal sebelum fixes lalu lulus. Final suite **104 tes lulus**, checks/build/deploy dry-run lulus, Oracle follow-up clear. Browser server nyata mengonfirmasi write inventory terlambat merekonsiliasi balance/ledger tanpa menghapus draft baru. Soak memakai snapshot sebelum final fixes, bukan klaim bahwa fixes tersebut mendapat soak lima jam.

RSS workerd meningkat pada soak dan bounded controls; bahkan Worker minimal tanpa aplikasi/D1/auth menunjukkan pertumbuhan. Root cause/native allocation policy dan kapasitas cloud tetap belum terbukti. Jangan menyebut leak-free/production-ready. Semua perubahan committed lokal; belum push/deploy. Rincian dan evidence scope ada di [local-verification.md](local-verification.md).

## Fase 2: anti-fraud dan abuse — 14 Oktober 2026

Backend-first, lokal, belum dipush/deploy. Migration baru `0010_risk.sql` (commerce: hash identitas order + index, `blocklist`, `rate_counters`, batas pembelian varian + trigger, `payment_events.kind`, index review open, audit immutable untuk semua row) dan `0011_admin_access.sql` (integrasi: `admin_roles.role`, `customer_bans`, `shipping_destinations`, index reuse quote, index halaman user).

- Rate limit binding per route+IP dengan fallback D1 hashed; 429 + `Retry-After`. Webhook/admin tidak dibatasi. Smoke `wrangler dev`: 60×404 lalu 429 pada lookup order memakai binding (tanpa row D1).
- Reuse quote per fingerprint (≥2 menit sisa), maksimal 10 layanan termurah, cache pencarian wilayah ternormalisasi 1 hari, quote/checkout hanya untuk wilayah yang dikenal server; alamat order disnapshot dari server.
- `RISK_HASH_SECRET`, HP Indonesia `+628…` (400 "Nomor HP tidak valid"), limit pending per email/HP/IP (cek sebelum Turnstile dan ulang di dalam batch), review velocity dan email disposable dalam batch yang sama, hold fulfillment, blocklist ter-hash dengan CRUD teraudit dan block-from-order, batas `maxPerOrder`/`maxPerCustomer`.
- Event DOKU terverifikasi non-SALE/status lain → `payment_events` ignored + review `provider_event`, 200.
- Role `owner`/`ops`/`catalog`, API role (owner-only, owner terakhir terlindungi), `/api/admin/me`, daftar customer, revoke session, ban; audit `order.view`/`file.download`; force-cancel owner untuk attempt exhausted.
- CSP ketat + `frame-ancestors 'none'` + `X-Frame-Options` + Permissions-Policy untuk admin dan storefront; script inline Astro di-hash (runtime dan build); hash di header cocok dengan script di HTML hasil build. `imageUrl` dibatasi ke `MEDIA_ORIGIN`. Katalog publik memakai `stockLevel`.
- Guard login dev: runtime (HTTPS non-localhost perlu `DEV_LOGIN_ALLOW_REMOTE`) dan `scripts/deploy-guard.mjs` di build/`deploy:check`.

Pemeriksaan: `npm run check`, `npm test` (**145 tes**: 58 commerce + 87 integration/storage/checkout/operations/UI/recovery), `npm run build`, `npm run deploy:check` lulus. Belum diuji di browser: hidrasi island di bawah CSP (hash diverifikasi terhadap HTML hasil build, bukan console browser), widget Turnstile live. UI admin untuk blocklist/role/customer/hold menyusul di Fase 4 (API sudah tersedia).

## Fase 3: fitur ecommerce — 14 Oktober 2026

Lokal, belum dipush/deploy. Migration `0012_ecommerce.sql` (commerce) dan `0013_accounts.sql` (integrasi); rincian dan retensi di [operations.md](operations.md#fitur-ecommerce-fase-3-migration-00120013).

- Perbaikan Fase 2: limit pending dan velocity IP dipisah (`MAX_PENDING_PER_IP` 10, `VELOCITY_LIMIT_IP` 20) dari email/HP (3 / 5) karena CGNAT seluler.
- Kategori + pencarian nama bounded di API dan SSR katalog (chip kategori, form GET), cache key ternormalisasi; CRUD kategori admin.
- `POST /api/cart/preview` menggantikan loop katalog di checkout. Checkout: konfirmasi ulang saat total berubah (409 `details.total`), idempotency key + payload dibekukan setelah hasil ambigu (network/5xx/408) dengan link "Periksa status pesanan" dan hanya diganti setelah penolakan 4xx pasti, quote kedaluwarsa dibuang, Total "Pilih ongkir" sebelum quote, edit alamat jalan tidak membatalkan quote, janji kirim snapshot di konfirmasi, buku alamat untuk customer login.
- `/order`: tombol "Batalkan pesanan" (konfirmasi, pesan 409/503), struk cetak (`@media print`) untuk paid/completed, "Simpan konfirmasi" (.txt lokal; token tidak masuk URL), link halaman pelacakan kurir, label timeline baru.
- Auto-complete Cron, retensi bounded, redaksi PII opsional dengan pengecualian trigger sempit, berat volumetrik + batas berat cart, SEO (meta/canonical/OG/JSON-LD, sitemap, robots), halaman legal templat + link footer.
- API admin: ringkasan, filter/pencarian order, ekspor CSV teraudit dan aman formula, low-stock, pencarian SKU, `version` CAS + entity di respons. UI admin hanya diubah minimal (mengirim `version`); redesign di Fase 4.

Pemeriksaan: `npm run check`, `npm test` (**168 tes**: 69 commerce + 99 integration/storage/checkout/operations/UI/recovery), `npm run build`, `npm run deploy:check` lulus. Belum diuji di browser nyata: halaman katalog dengan filter, print preview struk, link kurir, hidrasi island di bawah CSP. URL pelacakan kurir dan teks legal belum diverifikasi.

## Fase 4: refactor dan refresh UI — 14 Oktober 2026

- Admin: `main.tsx` 2117 → 224 baris (bootstrap saja). Router history di `/admin/`, satu halaman per route (Beranda, Pesanan + detail, Produk + editor halaman penuh, Kategori, Inventori, Pre-order, Pelanggan, Review + detail, Blocklist, Operasional, Tim & akses), sidebar terkelompok, pencarian global, navigasi sesuai role. `SaveForm`, `AdminWorkflows.tsx`, `ReviewDetail.tsx` dan `OperationalStatus.tsx` dihapus; form terkontrol mengirim field berubah + `version`, 409 menampilkan banner konflik. Lock mutasi bertahan sampai request selesai; picker varian memakai pencarian server; config/setup/me dimuat sekali. Tambahan backend: `GET /api/admin/products/:id`.
- Storefront: grid katalog, breadcrumb produk, checkout bertahap (Kontak, Alamat, Pengiriman, Ringkasan) tanpa mengubah protokol, stepper status pesanan, kartu pelacakan, count keranjang di header.
- Batas: filter status produk/review hanya atas halaman yang dimuat; bundle admin ~553 kB (belum lazy-load); count keranjang tidak tampil di halaman katalog tanpa island; screenshot 390px pesanan diambil sebelum perbaikan layout tab.

Pemeriksaan: `npm run check`, `npm test` (**159 tes**: 69 commerce + 90 integration/storage/checkout/operations/UI/storefront-UI/recovery; tes rekonsiliasi `SaveForm` lama dihapus bersama kodenya), `npm run build`, `npm run deploy:check`, `npm audit --omit=dev` lulus. Browser Chromium lokal: console tanpa pelanggaran CSP; screenshot di `.artifacts/phase4/` (diabaikan git).

## Mode staging workers.dev — 14 Oktober 2026

- `env.staging` di `wrangler.jsonc` dipilih dengan `CLOUDFLARE_ENV=staging npm run build` (`build:staging`); adapter Astro meratakan config ke `dist/server/wrangler.json`. `deploy:staging` = guard (`--deploy --staging`) + D1 migrations remote + deploy dengan config generated. Sudah dideploy ke `https://flaremmerce-staging.thomasbudiarjo.workers.dev` (D1, R2 media r2.dev + private, Queue + DLQ, 4 secret); 13 migration remote diterapkan setelah guard trigger `CASE … END;` ditulis ulang menjadi `END AS guard;` (pemecah statement Wrangler memotong trigger sebelumnya; perubahan teks saja, belum ada D1 remote lain yang menerapkan versi lama). Smoke: halaman/API publik 200, admin API anonim 401, passphrase salah 403, passphrase benar → owner, ringkasan admin 200, noindex/robots aktif.
- `APP_ENV=staging`: login admin passphrase `STAGING_LOGIN_SECRET` (session Better Auth, bootstrap owner sekali, RL_AUTH), Turnstile dilewati hanya bila key tidak lengkap, flag fitur di `/api/config`, badge STAGING, noindex/robots `Disallow: /`.
- Checkout di semua lingkungan menolak 503 sebelum reservasi bila DOKU atau RajaOngkir belum dikonfigurasi, sehingga tidak ada order yang tidak bisa dibayar. Turnstile production tanpa key tetap 503.

Pemeriksaan: `npm run check`, `npm test` (**169 tes**: 69 commerce + 100 integration/storage/checkout/operations/UI/storefront-UI/recovery), `npm run build`, `npm run build:staging`, `npm run deploy:check` lulus; `wrangler deploy --dry-run` atas config staging generated menampilkan binding staging. Binding Rate Limiting diterima saat deploy di akun ini. Production belum diprovision/dideploy.

## Admin UI/UX QoL — 15 Oktober 2026

Lokal, belum dipush/dideploy. Tanpa migration; backend hanya aditif.

- Fondasi: `useNavigationGuard` (link/`navigate`/popstate + `beforeunload`, URL dipulihkan saat tetap di halaman), memori daftar per route (URL + id baris untuk kembali dan Sebelumnya/Berikutnya), `CopyButton`, `RelativeTime`, `MoneyInput`, hotkey (`/`, Ctrl/Cmd+K, Ctrl/Cmd+S), `document.title` per halaman, `DataTable` dengan `mobileHidden`, seleksi dan `LinkRow`, `LoadError` seragam.
- Pesanan: pencarian global live untuk SKU dan Enter untuk pesanan persis, badge sidebar yang diperbarui, preset tanggal, jumlah di tab, kolom usia, aksi massal proses dan cetak packing slip, salin/WhatsApp/pesanan lain di detail, lanjut ke pesanan berikutnya.
- Katalog: filter status produk di server, kolom harga, pencarian live, menu baris (edit, lihat di toko, duplikat, arsip/aktifkan), slug otomatis, berat inline dan penghalang simpan per varian, duplikat produk, sesuaikan stok dari editor, unggah foto drag-and-drop, urutan kategori naik/turun dan jumlah produk, opname inventori, tab fase/kuota/validasi/buat ulang pre-order.
- Pelanggan/risiko/sistem: pencarian pelanggan di server, filter status review di server dengan jumlah, templat catatan dan review berikutnya, tab jenis dan kolom aktor blocklist, auto-refresh operasional 30 detik, pemilih pengguna dan konfirmasi penurunan owner.
- Backend: `GET /api/admin/products?status=`, `GET /api/admin/review?status=`, `GET /api/admin/customers?q=`, `productCount` di `GET /api/admin/categories`, `productId` di campaign. Ditemukan saat pengujian: D1 menolak pola LIKE di atas 50 byte (503); pencarian pelanggan dan varian admin kini menolak dengan 400. **Belum diubah:** pencarian katalog publik (`searchTerm` 2–60 karakter) masih dapat 503 untuk 49–60 karakter.

Pemeriksaan: `npm run check`, `npm test` (**199 tes**: 73 commerce + 126 integration/storage/checkout/operations/UI/storefront-UI/recovery), `npm run build`, `npm run deploy:check` lulus. Browser Chromium headless 1440 px dan 390 px pada D1 lokal disposable (`.artifacts/ux-round/`, diabaikan git): guard, proses massal 3 pesanan, pratinjau cetak 3 halaman, kirim dengan Ctrl+S, opname (D1 on_hand 12→15, ledger +3), pemberian peran lewat pemilih; console tanpa error/CSP. Belum diuji: clipboard dan dialog print nyata (headless), unggah drag-and-drop dengan media nyata, perangkat sentuh.

## Gate yang tidak boleh disamarkan

1. Resource, secret dan hostname staging/production nyata + otorisasi provision/deploy/migration. Root Wrangler masih lokal/ID dummy.
2. DOKU live sandbox: metode merchant yang aktif, original request identity pada notifikasi Checkout, retry/ack, response format dan inquiry eligibility. Checkout-wide expiry/grace belum terbukti; reservasi ambigu ditahan dan diangkat ke manual review.
3. Komerce paket/key, origin ID dan pencarian wilayah nyata. UI/API pencarian wilayah sudah ada; eligibility paket, cakupan wilayah dan kuota/rate limiting tetap perlu verifikasi provider/staging.
4. Google OAuth redirect/cookie propagation/state pada HTTPS staging dan Turnstile token invalid/replay nyata. Tes provider lokal tidak menggantikan ini.
5. WAF exception tepat path/method webhook, Free rule quota, public R2 custom domain dan private bucket nonpublic, DNS Email Routing.
6. Load/CPU/rows/kuota cloud dengan dataset nyata; 100 request GET katalog lokal bukan bukti medium traffic/concurrency aman di Workers Free.
7. Periode simpan catatan transaksi dan nilai `ORDER_PII_RETENTION_DAYS` (mekanisme retensi sudah ada, default redaksi off), review hukum halaman legal templat, verifikasi URL pelacakan kurir, UX pemulihan guest lintas perangkat, RPO/RTO, jadwal backup cloud, alert destination dan keputusan/prosedur penanganan finansial eksternal. UI manual review sudah tersedia; tidak ada otomatis refund/retur.

Fitur yang tidak masuk baseline tetap tidak dibuat: pajak, voucher/diskon, marketplace, multi-gudang, split shipment, refund/retur dan outbound customer email Paid. Port preview tidak mengotorisasi atau membuktikan deployment production.
