# Runbook operasional Flaremmerce

Bahasa Indonesia · 12 Oktober 2026 · status: tooling lokal, bukan izin deploy/production.
Kontrak utama: [system-design.md](system-design.md), khususnya D9/D12/D13 dan gate V1–V7.

## Backup dan restore yang dapat dijalankan

Prasyarat: jalankan dari root repository; Node, dependency terpasang (`npm ci`), Wrangler dan Python 3 stdlib SQLite. Jangan gunakan dump tidak tepercaya: SQL import adalah eksekusi kode database. Manifest SHA256 mendeteksi perubahan, **bukan** signature autentikasi; simpan manifest melalui jalur tepercaya. Dump memuat PII dan credential session/OAuth database, bukan hanya katalog. Gunakan direktori privat/encrypted disk, `umask 077`, jangan commit atau log dump. SQL dan manifest diberi mode 0600 setelah export.

```sh
umask 077
mkdir -p /tmp/flaremmerce-recovery
node scripts/backup.mjs /tmp/flaremmerce-recovery/snapshot.sql
node scripts/restore.mjs /tmp/flaremmerce-recovery/snapshot.sql \
  --database DB --persist-to /tmp/flaremmerce-recovery/restored
```

Backup **default LOCAL** (`d1 export DB --local --output PATH`, root `wrangler.jsonc`). CLI export tidak mendukung `--persist-to`; gunakan state default Wrangler (`.wrangler/state` pada config root), bukan klaim membaca sembarang state preview. Pilihan `--config`/`--database` eksplisit tersedia. Jangan menjalankan dari cwd lain tanpa memeriksa resource. Backup menolak path output/manifest yang sudah ada. Export diimport ke state sementara untuk menghitung tabel snapshot dan memeriksa integritas, sehingga jumlah tidak diambil dari source yang mungkin berubah selama export. Source lokal tidak ditulis oleh script. Scratch backup dihapus di `finally`. Export gagal/validasi gagal bisa menyisakan SQL tanpa manifest: itu **bukan backup tervalidasi**; karantina/hapus secara sadar lalu gunakan path baru.

Restore memerlukan `--database` dan `--persist-to` baru; tidak ada flag remote, tidak menerima direktori existing atau direktori di bawah `.wrangler`. Database binding boleh sama tetapi storage terisolasi. Parent direktori harus sudah ada. Checksum/ukuran diverifikasi **sebelum** membuat target; setelah import, periksa seluruh table count, foreign key dan SQLite integrity. `PRAGMA integrity_check` via D1 SQL API pada versi ini ditolak `SQLITE_AUTH`; script menjalankannya melalui Python SQLite **read-only pada file disposable**, bukan live D1. Layout Miniflare lokal bisa berubah: script fail closed bila tidak menemukan tepat satu file database nonmetadata. Restore gagal dapat menyisakan target parsial; jangan gunakan target tersebut, investigasi lalu hapus hanya direktori disposable yang telah dipastikan. Tidak ada auto-switch binding atau production overwrite.

Export Wrangler populated dapat memasukkan row session sebelum definisi tabel user. `defer_foreign_keys` tidak menyelesaikan referensi ke tabel yang belum ada. Importer menyiapkan salinan privat (directory 0700, SQL 0600), memindahkan seluruh ordinary CREATE TABLE sebelum data tanpa mengubah snapshot asli. Parser SQLite mempertahankan semicolon di quoted text dan trigger multistatement; incomplete/unsupported dump ditolak. Temporary copy dibersihkan dan SQL/error diagnostics yang mungkin memuat credential tidak dicetak. Ini penanganan format export Wrangler, bukan importer SQL arbitrer.

### Remote dan penyimpanan privat: hanya operator berotorisasi

Perintah berikut **tidak dijalankan dalam implementasi ini**. Review config/resource/account, dampak export pada database aktif, maintenance window serta dokumentasi [D1 export/import](https://developers.cloudflare.com/d1/best-practices/import-export-data/) sebelum mengotorisasi remote export. Jangan menganggap export cloud tanpa blocking/biaya. Baseline script hanya membantu export serta restore lokal, bukan scheduler cloud atau DR penuh.

```sh
# Config operator harus menunjuk resource yang telah disetujui; bukan config lokal dummy.
node scripts/backup.mjs /secure/backups/approved.sql \
  --config /secure/config/production.jsonc --database DB --remote
# Opsional, hanya jika private bucket dan izin/cost telah disetujui:
npx --no-install wrangler r2 object put PRIVATE_BUCKET/backup/approved.sql \
  --file /secure/backups/approved.sql --remote
npx --no-install wrangler r2 object put PRIVATE_BUCKET/backup/approved.sql.manifest.json \
  --file /secure/backups/approved.sql.manifest.json --remote
```

Tidak ada public domain/r2.dev pada bucket backup. Least privilege, MFA akun, audit akses, lifecycle retention dan encrypt-at-rest/akses operator ditinjau sebelum upload. Cadangan R2 dalam akun sama **tidak melindungi account compromise**. R2 activation/overage bukan otomatis gratis; tidak diaktifkan oleh script. Time Travel adalah fasilitas **remote**; bookmark/retention plan harus diverifikasi, restore memutasi resource dan membutuhkan approval terpisah. Jangan memakai `d1 create` untuk rehearsal lokal: command itu membuat cloud database. Recovery production harus diuji di resource terpisah, validasi aplikasi dan rekonsiliasi pembayaran sejak snapshot, kemudian cutover terotorisasi dengan rollback plan; script tidak mengimplementasikan cutover.

### Bukti rehearsal lokal

12 Oktober 2026, Wrangler 4.149.0, root DB `flaremmerce-local` dengan dua migration dan fixture katalog: export SQL **17.143 bytes**, SHA256 `8a9d5071bf1b0d5f43f22495043af21e782bab729c0e9afd65f3b85589af6f32`. Backup termasuk import/validasi snapshot memerlukan **34.150 ms**, restore ke `/tmp/flaremmerce-ops-restored` termasuk semua check **32.445 ms**, exit 0, integrity `ok`, foreign keys `ok`, semua table count sama. Snapshot mempunyai **24 tabel**, `products=3`, `product_variants=5`, `inventory=5`, `preorder_campaigns=1`, `d1_migrations=2`; seluruh 19 tabel lain kosong. Data transaksi/OAuth nyata tidak tercakup; bukan bukti restore dataset production. SQL, manifest dan target disposable dibersihkan setelah checks; angka ini bukan SLA/RTO produksi.

Kontrol negatif dijalankan: output backup existing ditolak; restore existing target, target `.wrangler` dan flag `--remote` ditolak; SQL dimodifikasi ditolak checksum sebelum target dibuat. `node --check` lulus untuk tiga script. Load-test menolak path checkout dan concurrency 51 sebelum network request. Preview tidak tersedia pada pemeriksaan ulang, sehingga tidak ada angka p50/p95 aplikasi yang diklaim.

Rehearsal ulang 13 Oktober setelah tujuh migration dan transaksi/session lokal sintetis: snapshot **28.612 bytes**, **27 tabel**, **27 indeks**, **15 trigger**, seluruh count/integrity/FK sama. Backup termasuk import validation **32.337 ms**, restore **30.496 ms**. Percobaan pertama menemukan kegagalan missing parent table di atas; setelah perbaikan, snapshot populated yang sama dapat dipulihkan. Tes permanen juga memeriksa exact multiline token, efek dua INSERT trigger, penolakan target existing dan checksum salah sebelum target dibuat. Angka ini lokal, bukan SLA atau DR production.

## Isolasi staging/production dan secret

- Root config lokal memakai ID dummy; **bukan** template siap deployment. Operator menyediakan config masing-masing env dengan D1 ID, R2 bucket privat/media, queue (bila aktif), hostname/origin dan Cron terpisah. Binding env tidak diasumsikan inherited. Review generated Worker config juga, bukan hanya file root.
- Resource staging memakai DOKU sandbox, RajaOngkir credential/paket yang disetujui dan data sintetis. Production tidak boleh tersambung melalui fallback secret/binding staging. Feature outbound email/Paid/R2/Queues aktif hanya lewat keputusan/otorisasi eksplisit.
- Google OAuth: per env gunakan client dan redirect URI exact sesuai callback Better Auth versi terpasang, misalnya `https://HOST/api/auth/callback/google` **setelah route diverifikasi**; allowlist origin, TLS dan state. Jangan wildcard/menebak callback. Secret auth, Google client secret, Turnstile secret, bootstrap secret dan credential provider dipasang melalui Workers Secrets pada env yang tepat oleh operator. Tidak masuk vars public, source, screenshot, URL atau log. Rotate/revoke saat insiden; periksa dampak pada session.
- Sebelum deploy review Free WAF capability/rule quota saat ini. Managed Challenge risk-based, bukan semua pengunjung. Exemption tepat path+method webhook DOKU dari browser challenge, Turnstile dan login; jangan blanket skip `/api/*`. Signature raw body, payload limits, match merchant/nominal/currency dan replay policy tetap wajib. Uji webhook/Google callback/SEO/cache pada hostname staging nyata sebelum produksi.

## Anti-fraud, rate limit dan WAF (migration 0010/0011)

- **Rate limit Worker.** Binding `ratelimits` (`RL_CHECKOUT` 10/60 s, `RL_QUOTE` 30/60 s untuk quote dan pencarian wilayah, `RL_LOOKUP` 60/60 s untuk GET/POST `/api/orders/:ref*`, `RL_AUTH` 10/60 s untuk POST `/api/auth/*` dan `/api/setup`) dengan key `route:CF-Connecting-IP`. Webhook dan `/api/admin/*` tidak dibatasi di sini. Limit binding berlaku **per lokasi Cloudflare**, bukan global, dan bersifat eventually consistent; anggap sebagai rem kasar, bukan kuota. Ketersediaan binding pada plan akun harus dikonfirmasi saat provisioning. Tanpa binding, Worker memakai fixed window D1 `rate_counters` (key = route + HMAC IP, raw IP tidak disimpan) dengan angka yang sama; Cron menghapus window lama. Jika D1 fallback error, request diloloskan dengan log `rate_limit_unavailable` agar checkout tidak ikut down. Jawaban limit: HTTP 429, `Retry-After`, JSON private/no-store.
- **WAF yang direkomendasikan** (lapisan luar, sebelum Worker): satu rate limiting rule untuk `http.request.method eq "POST" and http.request.uri.path in {"/api/checkout" "/api/shipping/quote" "/api/shipping/destinations"}` dengan characteristic IP, mis. 20 request/10 detik → Managed Challenge atau Block 10 detik (sesuaikan dengan kuota rule plan). Kecualikan `POST /api/payments/webhook` secara eksplisit; jangan blanket `/api/*`. Uji pada staging bahwa browsing, SEO dan callback Google tidak terkena.
- **Identitas risiko.** `RISK_HASH_SECRET` (≥32 karakter, Workers Secret) wajib di luar development; tanpa itu checkout 503. Order menyimpan HMAC email (lowercase/trim), HP (`+628…`) dan IP. Rotasi secret memutus korelasi histori dan blocklist: lakukan hanya saat insiden, lalu tambahkan ulang entri blocklist penting.
- **Limit pending dan velocity.** `MAX_PENDING_PER_IDENTITY` (default 3) menolak order baru (429 "Terlalu banyak pesanan belum dibayar") bila order `pending_payment` yang berbagi email, HP **atau** IP sudah mencapai batas; retry idempotency key yang sama tetap mengembalikan order lama. Catatan: IP seluler/CGNAT dapat dipakai banyak pelanggan; pantau 429 dan naikkan nilai bila perlu. `VELOCITY_LIMIT` (default 5 per 24 jam per identitas) dan domain email disposable tidak menolak order, tetapi membuka review `risk_velocity`/`risk_disposable_email` dalam batch yang sama.
- **Hold fulfillment.** Setiap review `open` pada order (risiko, pembayaran, provider event) menahan transisi fulfillment (409 "Pesanan ditahan: review risiko terbuka"). Daftar/detail order admin menampilkan `hold` dan `openReviewReasons`. Selesaikan review setelah verifikasi (mis. telepon pelanggan); jangan resolve hanya untuk melepas hold.
- **Blocklist.** `GET/POST /api/admin/blocklist`, `DELETE /api/admin/blocklist/:id`, serta `POST /api/admin/orders/:id/block {kinds,reason}` memakai hash yang tersimpan di order. Nilai mentah hanya dikirim saat menambah dan langsung di-hash; tabel dan audit tidak menyimpan email/HP/IP mentah. Checkout yang cocok ditolak 403 umum sebelum Turnstile.
- **Batas pembelian.** `max_per_order` dan `max_per_customer` per varian (admin create/PATCH `maxPerOrder`/`maxPerCustomer`, `null` = tanpa batas). Batas pelanggan menjumlahkan order tidak-cancelled dengan email hash, HP hash atau customer yang sama; trigger `item_purchase_limit` menahan race.
- **Alamat.** Hasil pencarian wilayah disalin ke `shipping_destinations`; quote hanya untuk ID yang dikenal dan checkout menyalin label/provinsi/kota/kecamatan/kelurahan/kode pos dari server. Pencarian dinormalisasi (lowercase, spasi tunggal) dan di-cache internal 1 hari (hasil kosong 1 jam); respons ke browser tetap private/no-store. Quote dengan fingerprint sama dipakai ulang selama masih berlaku ≥2 menit; maksimal 10 layanan termurah disimpan.
- **Role admin.** `owner` (semua), `ops` (pesanan, fulfillment, cancel, review, blocklist, customer, file privat, operasional), `catalog` (produk, varian, media, inventori, campaign). Path admin yang tidak terdaftar hanya owner. Owner mengelola role melalui `GET/POST /api/admin/roles {userId,role}` dan `DELETE /api/admin/roles/:userId`; owner terakhir tidak bisa diturunkan/dicabut dan installation owner tidak bisa dicabut. `GET /api/admin/me` memberi role aktif untuk UI.
- **Customer.** `GET /api/admin/customers`, `POST /api/admin/users/:id/revoke-sessions` (sesi admin hanya oleh owner) dan `POST /api/admin/users/:id/ban {banned}`. Ban menghapus sesi; user yang dibanned diperlakukan signed-out untuk commerce dan checkout sebagai akun tersebut 403. Admin tidak bisa dibanned.
- **Audit.** Semua baris `audit_logs` immutable (trigger UPDATE/DELETE). Baca detail order admin dicatat `order.view`, unduh file privat `file.download`, blocklist/role/user/cancel juga diaudit.
- **Header keamanan.** CSP ketat (`frame-ancestors 'none'`, tanpa `unsafe-inline` untuk script), `X-Frame-Options: DENY` dan Permissions-Policy untuk admin dan storefront. Script inline Astro diizinkan lewat hash: runtime untuk HTML yang dilayani Worker, build-time (`scripts/assets.mjs`) untuk halaman statis. Setelah upgrade Astro, periksa console browser untuk pelanggaran CSP. `imageUrl` produk wajib berasal dari `MEDIA_ORIGIN`.
- **Login dev.** Runtime menolak login dev di luar `APP_ENV=development`, dan pada origin HTTPS non-localhost kecuali `DEV_LOGIN_ALLOW_REMOTE=true` (diset `dev-setup --origin`). `npm run build`/`deploy:check` gagal bila config hasil build memuat `DEV_LOGIN_ENABLED=true` dengan origin HTTPS publik.

### Prosedur offline: dispute, refund dan event provider

Notifikasi DOKU yang signature-nya valid tetapi bukan `SALE` atau berstatus selain SUCCESS/FAILED (refund, chargeback, void, status tak dikenal) dijawab 200, disimpan sebagai `payment_events` (`status='ignored'`, `processed=1`, `kind` mis. `REFUND:SUCCESS`) dan membuka review `provider_event` (atau `unknown_reference`). Tidak ada perubahan order/stok/pembayaran otomatis. Operator: (1) buka review dan cocokkan reference/nominal dengan dashboard DOKU; (2) untuk chargeback/refund, kumpulkan bukti pengiriman (resi, timeline) dan tanggapi di DOKU sesuai tenggatnya; (3) bila barang belum dikirim, biarkan hold aktif dan putuskan cancel/penahanan; (4) catat keputusan, nomor tiket DOKU dan jumlah pada catatan review sebelum resolved; (5) pertimbangkan blocklist dari order bila terbukti fraud.

### Pembatalan paksa attempt yang tidak pernah sampai ke DOKU

Bila lookup DOKU tidak konklusif (mis. 404 karena create tidak pernah diterima) dan attempt sudah punya review `reconciliation_exhausted`, **owner** dapat `POST /api/admin/orders/:id/cancel {"confirmNoPayment":true,"reason":"…"}`. Server tetap mencoba lookup terlebih dahulu: SUCCESS diterapkan dan pembatalan ditolak 409. Audit `order.cancel` mencatat `confirmNoPayment`/`forced`. Pembayaran yang datang setelahnya menjadi review `late_payment` dan harus direfund manual.

## Payment, outbox dan recovery operator

Gate V1 tetap terbuka sampai produk DOKU dipilih dan kontrak signature, acknowledgment/retry, status lookup, expiry/grace serta unit IDR dikonfirmasi. Timeout create-payment = unknown; cari status authoritative dengan merchant reference yang telah dipersist, jangan blind recreate. Expiry hanya boleh melepas reservasi setelah status provider terverifikasi sesuai kontrak; provider ambigu/network down masuk bounded reconciliation/manual review, bukan clock-only release. Late success, mismatch nominal/currency, double payment dan cancelled order tidak otomatis fulfill/refund.

Setelah migration 0004, admin membuka Manual review → Bukti & tindakan untuk melihat ringkasan order/attempt/event dan maksimal 100 audit terbaru. Catatan wajib disimpan bersama status open/resolved dan audit immutable dalam atomic batch. `PATCH /api/admin/review/:id` memerlukan `{version,status,note}` dan opsional `action:"cancel_order"`; HTTP 409 berarti operator lain sudah mengubah kasus (atau order sudah dibayar), sehingga bukti harus dimuat ulang sebelum keputusan baru. Tanpa `action`, status resolved hanya berarti penanganan eksternal sudah dicatat: tidak mengonfirmasi pembayaran, membatalkan order, melepas stok atau melakukan refund. Dengan `cancel_order`, server mengecek status DOKU dulu (SUCCESS diterapkan dan menghasilkan 409, lookup gagal menghasilkan 503), lalu CAS review dan pembatalan order berjalan dalam satu batch atomik. Endpoint yang sama tersedia sebagai `POST /api/admin/orders/:id/cancel` (audit `order.cancel`) dan `POST /api/orders/:reference/cancel` (guest token atau pemilik, event `cancelled_by_customer`). Tentukan prosedur/bukti finansial eksternal dan pemilik tindak lanjut sebelum production; jangan menandai resolved sekadar untuk menyembunyikan alert.

Queues **opsional** pada baseline Free: durable outbox D1 tetap source of truth. Bila binding/queue tidak tersedia, Cron scanner bounded batch/backoff/attempt cap menjalankan handler idempotent dari outbox; tidak mengandalkan `waitUntil`. Jika queue dipakai, send/mark dapat duplicate; consumer dan Cron harus aman redelivery, retention expiry dan DLQ redrive. Status pending/dead/oldest unfinished dimonitor. Outbound disabled tidak retry terus atau mengirim histori saat diaktifkan nanti. Mematikan Cron ketika queue sehat menghilangkan recovery dan tidak diperbolehkan tanpa scanner pengganti.

Bootstrap initialized **tidak pernah dibuka kembali**. Jika semua admin kehilangan akses: operator berotorisasi mengidentifikasi Google identity terverifikasi di tabel `user`, approval dua pihak bila policy menetapkan, backup dahulu, lalu perubahan role terbatas bersama audit dalam satu atomic unit melalui tooling operator yang direview. Catat actor operator, alasan, ticket, target, waktu dan perubahan; cabut session yang terdampak dan uji akses baru. Jangan delete/update `installation`, drop trigger atau publish bootstrap secret. Belum ada script otomatis recovery role; jangan membuat SQL ad hoc yang memalsukan Google verification/audit actor.

## Observability dan alert

Workers Logs: correlation ID, reference nonsecret, transition dan attempt; redaksi cookie/token/PII/raw provider payload. Audit bisnis terpisah dari technical log. Operator menetapkan threshold, kanal alert, recipient dan jadwal review sesuai kemampuan Free; outbound alert otomatis tidak dianggap tersedia/gratis. Pantau errors/CPU exceeded, Workers requests, D1 rows read/written dan storage, queue operations/DLQ, R2 operations/storage, unknown payment, oldest unfinished outbox dan manual review. Gunakan dashboard/metrics cloud dan D1 query insights dengan otorisasi, bukan waktu wall HTTP sebagai CPU.

Setelah migration 0007, panel **Operasional** memuat GET `/api/admin/operations` melalui fresh admin authorization dan private/no-store. Setiap kategori mengambil 21 row tertua dan menampilkan 20: `hasMore`/`atLeast` adalah sampel dan batas bawah, bukan total backlog. Payments mencakup retry exhausted; outbox mencakup pending/dead. Partial age indexes memastikan LIMIT tidak membutuhkan sort seluruh backlog. Setelah migration 0008, planner memilih index umur orders/reviews sendiri; payments/outbox tetap memakai `INDEXED BY` karena index recovery berawalan status lebih disukai planner (diverifikasi dengan `EXPLAIN QUERY PLAN`). Jangan drop/rename index tersebut tanpa mengubah query. Fixture workerd 5.000 row membuktikan payment/outbox reads turun dari 10.003/10.002 menjadi 21 dengan hasil identik, bukan pengukuran biaya/CPU cloud.

Respons API mendapat `X-Request-ID` baru di luar cache storage, termasuk cache hit. Log `api_error` mencatat category/status/requestId, bukan URL/query/body atau pesan exception. Cron menjalankan payment recovery dan outbox recovery secara independen lalu melaporkan failure tersanitasi; satu scanner gagal tidak mencegah scanner lain dicoba. Retry/unknown/dead logs tidak membuktikan alert terkirim: destination/threshold tetap gate operasional.

Contoh query read-only untuk schema saat ini (timestamp epoch ms, `:now`/`:cutoff` disuplai operator; bounded list):

```sql
SELECT id,reference,status,next_check FROM payment_attempts
 WHERE status IN ('created','pending','unknown') AND next_check <= :now
 ORDER BY next_check LIMIT 100;
SELECT id,status,attempts,next_run,created_at FROM outbox_events
 WHERE status='pending' AND next_run <= :now ORDER BY next_run LIMIT 100;
SELECT id,reason,status,version,created_at FROM manual_review
 WHERE status='open' AND created_at >= :cutoff ORDER BY created_at,id LIMIT 100;
SELECT id,reference,created_at FROM orders
 WHERE status='pending_payment' AND created_at < :cutoff ORDER BY created_at LIMIT 100;
```

Index tersedia: `attempts_recovery(status,next_check)`, `outbox_recovery(status,next_run)`, `review_created(created_at,id)`, `operations_orders_age(created_at,id) WHERE status='pending_payment'`. `orders_status` dihapus di 0008. Attempt yang exhausted mendapat `next_check=8640000000000000` agar keluar dari range scan; di admin nilainya tampil kosong. Expiry: attempt created/pending/unknown yang `created_at + 60 menit + EXPIRY_GRACE_MIN` (default 30, maksimal 120) sudah lewat dan dijawab DOKU bukan SUCCESS (PENDING/FAILED/TIMEOUT/REDIRECT/EXPIRED) dengan invoice/nominal cocok dibatalkan dengan event `expiry:<reference>`; lookup gagal/ambigu tetap ditahan. Webhook dengan `Request-Timestamp` di luar ±`WEBHOOK_MAX_SKEW_MIN` (default 15) ditolak 401. Periksa `EXPLAIN QUERY PLAN` pada dataset representatif. Query due tidak sama dengan oldest unfinished: periksa umur `created_at` juga, termasuk backoff/dead; aggregate/dashboard dapat scan banyak rows, jangan jalankan COUNT seluruh tabel tiap request. Reservasi schema saat ini tidak punya timestamp expiry sendiri: correlasikan order/attempt dan expiry authoritative; jangan mengarang index/expiry field. Quota adalah rows scanned/written bukan jumlah query. Forecast dan threshold ditetapkan setelah ukur cloud, tidak mengekstrapolasi seed kecil.

## Load test read-only terbatas

```sh
node scripts/load-test.mjs --requests 100 --concurrency 5 --timeout-ms 5000
```

Default GET katalog lokal; hanya `/api/catalog`, `/catalog`, `/` tanpa query, credential atau redirect-follow diizinkan. Tidak ada POST/checkout/payment/webhook/session admin/cookie. Maksimum 10.000 requests, concurrency 50, timeout 30.000 ms/request. Operator memilih origin yang diotorisasi; jangan mengarahkan load ke production tanpa izin. Output p50/p95 nearest-rank atas seluruh attempt termasuk failures, status, error rate dan elapsed wall time; exit nonzero saat error. Bukan throughput guarantee, open-loop test atau CPU benchmark. Cold/hot cache perlu run terpisah dan bukti cache header/query; HTTP 200 saja tidak membuktikan cache.

Pemeriksaan preview lokal: 100 request concurrency 5 menghasilkan 100×200, 0 error, p50 12,05 ms dan p95 16,31 ms. Export/restore ulang setelah ketiga migration menghasilkan snapshot 18.216 bytes, 27 tabel dengan counts yang sama, integrity/FK ok; export+validasi 38,569 detik dan restore+validasi 37,782 detik. Ini bukan RPO/RTO produksi. Cloud CPU, D1 rows/quotas, queue usage dan WAF tidak diukur lokal. Acceptance auth/checkout/webhook burst cloud tetap perlu harness sandbox provider dan approval terpisah; script ini sengaja tidak menguji mutation.

## Keputusan yang belum final

Target backup harian adalah **usulan**, belum scheduler cloud terpasang. RPO, RTO, retention SQL/manifest/PII/audit/email/guest token, external/account-loss backup, pemilik alert dan mekanisme guest recovery belum diputuskan. Tidak ada angka SLA atau durasi retention fabricated. Catat umur backup terakhir tervalidasi, lakukan rehearsal berkala setelah perubahan schema/provider, dan jangan menyebut DR production siap berdasarkan fixture lokal.

Dokumentasi CLI resmi [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) diperiksa sebelum implementasi; installed `d1 export --help` dan `d1 execute --help` dikonfirmasi. Limit/pricing/Time Travel/WAF provider tetap harus direview sebelum operasi cloud.
