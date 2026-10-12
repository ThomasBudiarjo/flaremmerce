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

## Isolasi staging/production dan secret

- Root config lokal memakai ID dummy; **bukan** template siap deployment. Operator menyediakan config masing-masing env dengan D1 ID, R2 bucket privat/media, queue (bila aktif), hostname/origin dan Cron terpisah. Binding env tidak diasumsikan inherited. Review generated Worker config juga, bukan hanya file root.
- Resource staging memakai DOKU sandbox, RajaOngkir credential/paket yang disetujui dan data sintetis. Production tidak boleh tersambung melalui fallback secret/binding staging. Feature outbound email/Paid/R2/Queues aktif hanya lewat keputusan/otorisasi eksplisit.
- Google OAuth: per env gunakan client dan redirect URI exact sesuai callback Better Auth versi terpasang, misalnya `https://HOST/api/auth/callback/google` **setelah route diverifikasi**; allowlist origin, TLS dan state. Jangan wildcard/menebak callback. Secret auth, Google client secret, Turnstile secret, bootstrap secret dan credential provider dipasang melalui Workers Secrets pada env yang tepat oleh operator. Tidak masuk vars public, source, screenshot, URL atau log. Rotate/revoke saat insiden; periksa dampak pada session.
- Sebelum deploy review Free WAF capability/rule quota saat ini. Managed Challenge risk-based, bukan semua pengunjung. Exemption tepat path+method webhook DOKU dari browser challenge, Turnstile dan login; jangan blanket skip `/api/*`. Signature raw body, payload limits, match merchant/nominal/currency dan replay policy tetap wajib. Uji webhook/Google callback/SEO/cache pada hostname staging nyata sebelum produksi.

## Payment, outbox dan recovery operator

Gate V1 tetap terbuka sampai produk DOKU dipilih dan kontrak signature, acknowledgment/retry, status lookup, expiry/grace serta unit IDR dikonfirmasi. Timeout create-payment = unknown; cari status authoritative dengan merchant reference yang telah dipersist, jangan blind recreate. Expiry hanya boleh melepas reservasi setelah status provider terverifikasi sesuai kontrak; provider ambigu/network down masuk bounded reconciliation/manual review, bukan clock-only release. Late success, mismatch nominal/currency, double payment dan cancelled order tidak otomatis fulfill/refund.

Queues **opsional** pada baseline Free: durable outbox D1 tetap source of truth. Bila binding/queue tidak tersedia, Cron scanner bounded batch/backoff/attempt cap menjalankan handler idempotent dari outbox; tidak mengandalkan `waitUntil`. Jika queue dipakai, send/mark dapat duplicate; consumer dan Cron harus aman redelivery, retention expiry dan DLQ redrive. Status pending/dead/oldest unfinished dimonitor. Outbound disabled tidak retry terus atau mengirim histori saat diaktifkan nanti. Mematikan Cron ketika queue sehat menghilangkan recovery dan tidak diperbolehkan tanpa scanner pengganti.

Bootstrap initialized **tidak pernah dibuka kembali**. Jika semua admin kehilangan akses: operator berotorisasi mengidentifikasi Google identity terverifikasi di tabel `user`, approval dua pihak bila policy menetapkan, backup dahulu, lalu perubahan role terbatas bersama audit dalam satu atomic unit melalui tooling operator yang direview. Catat actor operator, alasan, ticket, target, waktu dan perubahan; cabut session yang terdampak dan uji akses baru. Jangan delete/update `installation`, drop trigger atau publish bootstrap secret. Belum ada script otomatis recovery role; jangan membuat SQL ad hoc yang memalsukan Google verification/audit actor.

## Observability dan alert

Workers Logs: correlation ID, reference nonsecret, transition dan attempt; redaksi cookie/token/PII/raw provider payload. Audit bisnis terpisah dari technical log. Operator menetapkan threshold, kanal alert, recipient dan jadwal review sesuai kemampuan Free; outbound alert otomatis tidak dianggap tersedia/gratis. Pantau errors/CPU exceeded, Workers requests, D1 rows read/written dan storage, queue operations/DLQ, R2 operations/storage, unknown payment, oldest unfinished outbox dan manual review. Gunakan dashboard/metrics cloud dan D1 query insights dengan otorisasi, bukan waktu wall HTTP sebagai CPU.

Contoh query read-only untuk schema saat ini (timestamp epoch ms, `:now`/`:cutoff` disuplai operator; bounded list):

```sql
SELECT id,reference,status,next_check FROM payment_attempts
 WHERE status IN ('created','pending','unknown') AND next_check <= :now
 ORDER BY next_check LIMIT 100;
SELECT id,status,attempts,next_run,created_at FROM outbox_events
 WHERE status='pending' AND next_run <= :now ORDER BY next_run LIMIT 100;
SELECT id,reason,created_at FROM manual_review
 WHERE created_at >= :cutoff ORDER BY created_at,id LIMIT 100;
SELECT id,reference,created_at FROM orders
 WHERE status='pending_payment' AND created_at < :cutoff ORDER BY created_at LIMIT 100;
```

Index tersedia: `attempts_recovery(status,next_check)`, `outbox_recovery(status,next_run)`, `review_created(created_at,id)`, `orders_status(status,created_at)`. Periksa `EXPLAIN QUERY PLAN` pada dataset representatif. Query due tidak sama dengan oldest unfinished: periksa umur `created_at` juga, termasuk backoff/dead; aggregate/dashboard dapat scan banyak rows, jangan jalankan COUNT seluruh tabel tiap request. Reservasi schema saat ini tidak punya timestamp expiry sendiri: correlasikan order/attempt dan expiry authoritative; jangan mengarang index/expiry field. Quota adalah rows scanned/written bukan jumlah query. Forecast dan threshold ditetapkan setelah ukur cloud, tidak mengekstrapolasi seed kecil.

## Load test read-only terbatas

```sh
node scripts/load-test.mjs --requests 100 --concurrency 5 --timeout-ms 5000
```

Default GET katalog lokal; hanya `/api/catalog`, `/catalog`, `/` tanpa query, credential atau redirect-follow diizinkan. Tidak ada POST/checkout/payment/webhook/session admin/cookie. Maksimum 10.000 requests, concurrency 50, timeout 30.000 ms/request. Operator memilih origin yang diotorisasi; jangan mengarahkan load ke production tanpa izin. Output p50/p95 nearest-rank atas seluruh attempt termasuk failures, status, error rate dan elapsed wall time; exit nonzero saat error. Bukan throughput guarantee, open-loop test atau CPU benchmark. Cold/hot cache perlu run terpisah dan bukti cache header/query; HTTP 200 saja tidak membuktikan cache.

Pemeriksaan preview lokal: 100 request concurrency 5 menghasilkan 100×200, 0 error, p50 12,05 ms dan p95 16,31 ms. Export/restore ulang setelah ketiga migration menghasilkan snapshot 18.216 bytes, 27 tabel dengan counts yang sama, integrity/FK ok; export+validasi 38,569 detik dan restore+validasi 37,782 detik. Ini bukan RPO/RTO produksi. Cloud CPU, D1 rows/quotas, queue usage dan WAF tidak diukur lokal. Acceptance auth/checkout/webhook burst cloud tetap perlu harness sandbox provider dan approval terpisah; script ini sengaja tidak menguji mutation.

## Keputusan yang belum final

Target backup harian adalah **usulan**, belum scheduler cloud terpasang. RPO, RTO, retention SQL/manifest/PII/audit/email/guest token, external/account-loss backup, pemilik alert dan mekanisme guest recovery belum diputuskan. Tidak ada angka SLA atau durasi retention fabricated. Catat umur backup terakhir tervalidasi, lakukan rehearsal berkala setelah perubahan schema/provider, dan jangan menyebut DR production siap berdasarkan fixture lokal.

Dokumentasi CLI resmi [D1 Wrangler commands](https://developers.cloudflare.com/d1/wrangler-commands/) diperiksa sebelum implementasi; installed `d1 export --help` dan `d1 execute --help` dikonfirmasi. Limit/pricing/Time Travel/WAF provider tetap harus direview sebelum operasi cloud.
