# Flaremmerce

E-commerce satu brand: Astro 7 + React islands, admin React/Vite, Cloudflare Workers Static Assets, D1/Drizzle, Better Auth Google, DOKU Checkout, RajaOngkir Komerce, R2, Queues dan Cron. Bahasa UI Indonesia, uang IDR integer, timestamp UTC dan tampilan Asia/Jakarta.

## Menjalankan lokal

Node ≥22.12 (direkomendasikan Node 24), npm 11, Python 3 untuk validasi restore.

```sh
npm ci
npm run db:migrate
npm run db:seed # data demo lokal saja, tanpa admin/default password
npm run build
npm run dev
```

Di Amp orb gunakan managed service, bukan background shell:

```sh
amp orb service start flaremmerce --command 'npm run dev' --port 8787 --portal
```

Build menghasilkan Worker `apps/storefront/dist/server/entry.mjs`, config Wrangler generated dan aset `dist/client` termasuk admin. `src/entry.ts` adalah source entrypoint; middleware SSR memanggil katalog dalam proses yang sama, tanpa self-fetch/API service kedua. Admin menggunakan `/admin/`; entrypoint menangani fallback SPA tanpa redirect loop. Public katalog/API menggunakan cache allowlist 60 detik; mutation, auth, order/PII dan admin API private/no-store. Gambar runtime passthrough dan Astro sessions disabled: tidak ada KV atau Cloudflare Images Paid dependency tersembunyi.

## Admin UI

Admin memakai komponen resmi **shadcn/ui Radix Nova**, preset neutral, Tailwind 4, ikon Lucide dan font Geist. Komponen registry disimpan di `apps/admin/src/components/ui`, konfigurasi di `apps/admin/components.json`, lisensi MIT di `apps/admin/LICENSE.shadcn`. Tidak ada tema CSS custom untuk tombol, sidebar, tabel atau form. CLI hanya dipakai untuk generation, bukan dependency aplikasi; varian CSS upstream yang digunakan disalin dari shadcn 4.21.4. Penyesuaian komponen sebatas bahasa Indonesia, `aria-expanded`, dan pengembalian focus drawer ke trigger.

Struktur mengikuti pola admin e-commerce umum: router kecil berbasis history API di `/admin/` (deep link seperti `/admin/orders/:id`, `/admin/products/:id`), satu file per halaman di `apps/admin/src/pages`, sidebar dikelompokkan (Beranda, Penjualan, Katalog, Pelanggan, Risiko, Sistem) dan disaring menurut peran (owner/ops/catalog; server tetap menegakkan izin). Topbar memiliki pencarian global (referensi pesanan, email/HP, atau SKU melalui `GET /api/admin/variants/search`) dan menu akun dengan badge peran. Dashboard memakai `GET /api/admin/summary` (hari ini/7/30 hari). Daftar pesanan memakai filter server (tab status, tanggal WIB, referensi/email/HP) dan ekspor CSV sesuai filter.

Form edit terkontrol: hanya field yang berubah dikirim bersama `version`; 409 menampilkan "Data sudah diubah orang lain" dengan tombol muat ulang, dan respons sukses langsung menggantikan entity lokal. Kunci mutasi (`useMutation`) bertahan sampai request selesai walau dialog ditutup atau halaman ditinggal. Editor produk berupa halaman penuh (umum, media, tabel varian hingga 30 SKU dengan batas pembelian, dimensi, ambang stok, pratinjau SEO, bar simpan sticky, arsip/aktifkan). Detail pesanan dua kolom hanya menawarkan langkah fulfillment berikutnya (Proses → Kirim dengan resi dan kurir → Terkirim), diblokir selama ada review terbuka, serta menyediakan pembatalan, blokir identitas, dan cetak invoice/packing slip. Filter status produk dan tab review menyaring halaman yang sudah dimuat karena API tidak memiliki filter tersebut.

Panel Operasional menampilkan sampel 20 unfinished tertua per kategori, termasuk payment exhausted dan outbox dead; indikator lebih dari 20 adalah batas bawah, bukan total seluruh database. Terapkan migration 0006/0007 sebelum memakai API/panel baru. Customer pending dapat melanjutkan URL HTTPS payment attempt yang sama ketika tersedia; tombol ini tidak membuat attempt baru dan tidak muncul untuk order selesai.

Foto utama dapat diunggah dari kartu Media di editor produk baru/existing (JPEG/PNG/WebP ≤5 MiB; memerlukan MEDIA dan MEDIA_ORIGIN). Manual review menyediakan bukti, catatan wajib, status ditangani/buka kembali dan audit; tindakan review tidak mengubah pembayaran, stok atau pesanan. Terapkan migration 0004/0005 sebelum memakai fitur ini dan riwayat customer.

Katalog mendukung filter kategori dan pencarian nama (`/catalog?category=&q=`). Checkout membaca harga/stok dari `POST /api/cart/preview`, memilih wilayah melalui pencarian Komerce (bukan mengetik destination ID), dan customer login dapat memakai/menyimpan hingga 5 alamat. `/order` menyediakan pembatalan order belum dibayar, struk cetak, unduhan konfirmasi guest dan link pelacakan kurir. Halaman `/privacy`, `/terms`, `/returns`, `/about` adalah templat dengan placeholder yang **wajib direview konsultan hukum** sebelum production. Terapkan migration 0012/0013 sebelum memakai fitur ini. Riwayat di `/order` hanya memuat pesanan yang dibuat dengan akun pemilik; guest tetap memakai token privat, bukan klaim berdasarkan email sama. Credential provider tetap wajib dan tidak ada fallback ongkir gratis.

## Credential dan resource

`npm run dev` otomatis membuat `BETTER_AUTH_SECRET`, `BOOTSTRAP_SECRET` dan `RISK_HASH_SECRET` random sekali di `.dev.vars` privat (permission 0600); restart mempertahankan nilainya. Buka `/admin/` lalu klik **Masuk admin dev**: tanpa Google/password, session Better Auth asli dan admin pertama pada database lokal kosong disiapkan otomatis. Tidak mengambil alih instalasi yang sudah memiliki owner atau mengembalikan role yang dicabut. Login dev memerlukan kedua flag server `APP_ENV=development` dan `DEV_LOGIN_ENABLED=true`; jangan pasang keduanya pada deployment shared/production. Session identitas dev ditolak oleh akses admin/commerce saat mode dev dimatikan. Portal dev memberi akses admin kepada siapa pun yang bisa membuka portal; jangan gunakan data nyata. Untuk HTTPS portal, jalankan `node scripts/dev-setup.mjs --origin https://HOST` sebelum restart dev server agar Origin/cookie sesuai. Opsi ini juga menulis `DEV_LOGIN_ALLOW_REMOTE=true`, karena login dev ditolak pada origin HTTPS non-localhost tanpa opt-in tersebut; build/`deploy:check` gagal bila config deploy memuat `DEV_LOGIN_ENABLED=true` dengan origin HTTPS publik.

Tanpa credential provider, quote ongkir dan pembayaran tetap ditutup. Ini **bukan sandbox provider palsu**. Atur konfigurasi lokal privat `.dev.vars`, jangan commit nilai secret. Binding nonsecret: `PUBLIC_ORIGIN` canonical origin, `TURNSTILE_SITE_KEY`, `RAJAONGKIR_ORIGIN`, `RAJAONGKIR_COURIERS`, `MEDIA_ORIGIN`; secret: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `BOOTSTRAP_SECRET`, `TURNSTILE_SECRET_KEY`, `DOKU_SECRET_KEY`, `RAJAONGKIR_API_KEY`, `RISK_HASH_SECRET` (HMAC identitas risiko, minimal 32 karakter; tanpa secret ini checkout 503 di luar development). Opsional: `MAX_PENDING_PER_IDENTITY` (default 3, per email/HP), `MAX_PENDING_PER_IP` (default 10), `VELOCITY_LIMIT` (default 5/24 jam), `VELOCITY_LIMIT_IP` (default 20/24 jam), `LOW_STOCK_PUBLIC` (default 5), `LOW_STOCK_DEFAULT` (default 5, threshold admin), `VOLUMETRIC_DIVISOR` (default 6000), `MAX_CART_WEIGHT_G` (default 50000), `AUTO_COMPLETE_DAYS` (default 14), `INBOUND_RETENTION_DAYS` (default 180), `ORDER_PII_RETENTION_DAYS` (default kosong = redaksi PII off). Rate limiter memakai binding `RL_CHECKOUT`, `RL_QUOTE`, `RL_LOOKUP`, `RL_AUTH` di `wrangler.jsonc`; lihat [runbook](docs/operations.md). Google client ID/DOKU client ID tetap hanya konfigurasi server. Auth/bootstrap secret minimal 32 karakter random. Default `DOKU_MODE=sandbox`; production harus opt-in.

Di production, first admin harus sign-in Google terverifikasi lalu menyerahkan bootstrap secret yang dibuat random dan dipasang operator melalui Workers Secrets (bukan digenerate setiap request). User Google biasa tidak otomatis admin. Tidak ada akun/password admin production bawaan atau public admin signup. Guest checkout tidak membutuhkan Google, session auth atau outbound email. Cookie scope guest didapat sebelum reservasi/Siteverify; UI mengulang payload/key yang sama sekali setelah HTTP 428. Token akses guest disimpan hash di D1, dikirim lewat header, tidak dimasukkan URL/localStorage.

Root Wrangler memakai resource lokal dan D1 ID dummy, **jangan deploy langsung**. R2 media dan private terpisah; Queues lokal memiliki producer/consumer dan Cron recovery tetap aktif. Staging/production membutuhkan resource, canonical domain, OAuth redirect, merchant settings, Turnstile hostname dan secret terpisah, serta izin operator sebelum provision/deploy/migration. Tidak ada outbound pelanggan/Paid binding.

## Staging (workers.dev) via Workers Builds

`wrangler.jsonc` memiliki `env.staging` (Worker `flaremmerce-staging`, D1 `flaremmerce-staging`, R2 `flaremmerce-staging-media`/`flaremmerce-staging-private`, Queue `flaremmerce-staging-jobs` + DLQ `flaremmerce-staging-jobs-dlq`, rate limit namespace 2001–2004, Cron sama, `workers_dev: true`). Top-level tetap config lokal. Lingkungan dipilih saat **build**: adapter Astro (`@astrojs/cloudflare` → `@cloudflare/vite-plugin`) membaca `CLOUDFLARE_ENV` dan meratakan `env.staging` ke `apps/storefront/dist/server/wrangler.json` (tanpa blok `env`, `migrations_dir` relatif ke folder itu = `migrations/` di root). `npm run build` biasa tetap menghasilkan config lokal. Deploy selalu memakai config generated tersebut, bukan `--env`.

Pengaturan Workers Builds (Settings → Build):

| Pengaturan | Nilai |
|---|---|
| Production branch | `staging` (Branch control; hanya push ke branch ini yang men-deploy staging) |
| Builds for non-production branches | Nonaktif (deploy command non-production memakai `wrangler versions upload` tanpa deploy guard dan migration) |
| Root directory | `/` |
| Build command | `npm ci && npm run build:staging` |
| Deploy command | `npm run deploy:staging` |
| Build variable | `CLOUDFLARE_ENV=staging` |
| Worker name | `flaremmerce-staging` (harus sama dengan `name` di config generated) |

`deploy:staging` menjalankan `deploy-guard --deploy --staging` (menolak build non-staging dan `PUBLIC_ORIGIN` yang masih berisi `REPLACE`), lalu `wrangler d1 migrations apply DB --remote` dan `wrangler deploy` dengan config generated. `CLOUDFLARE_ENV` dikosongkan untuk kedua perintah karena config generated sudah rata. Staging aktif di `https://flaremmerce-staging.thomasbudiarjo.workers.dev`; resource, secret dan migration sudah disiapkan. Token build Workers Builds membutuhkan izin D1 Edit untuk langkah migration; bila build gagal di `migrations apply`, tambahkan izin itu pada token build.

Pemecah statement `wrangler d1 migrations apply` (port `sqlite3_complete`) menganggap `CASE … END;` di dalam badan trigger sebagai akhir trigger. Tulis guard trigger sebagai `SELECT CASE … END AS guard;` atau `SELECT RAISE(…) WHERE …;`, jangan diakhiri `END;` langsung.

Secret Worker staging (Settings → Variables and Secrets, tipe Secret): `BETTER_AUTH_SECRET`, `BOOTSTRAP_SECRET`, `RISK_HASH_SECRET` (wajib seperti production, ≥32 karakter) dan `STAGING_LOGIN_SECRET` (≥32 karakter random). Opsional saat credential tersedia: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`, `TURNSTILE_SITE_KEY`/`TURNSTILE_SECRET_KEY`, `DOKU_CLIENT_ID`/`DOKU_SECRET_KEY`, `RAJAONGKIR_API_KEY` + var `RAJAONGKIR_ORIGIN`/`RAJAONGKIR_COURIERS`. Jangan menaruh `STAGING_LOGIN_SECRET` di `vars` (deploy guard menolak).

Perilaku `APP_ENV=staging` (production dan development tidak berubah):

- **Login admin:** `/admin/` menampilkan form **Masuk staging**; passphrase dibandingkan constant-time dengan `STAGING_LOGIN_SECRET`, dibatasi `RL_AUTH`, menghasilkan session Better Auth asli untuk identitas tetap `admin@staging.flaremmerce.test`. Login pertama pada instalasi kosong menjadi owner; tidak mengambil alih owner yang ada atau memulihkan role yang dicabut. Tanpa secret, login staging nonaktif dan session identitas staging ditolak. Tombol Google hanya tampil bila Google dikonfigurasi.
- **Turnstile:** bila `TURNSTILE_SITE_KEY` atau `TURNSTILE_SECRET_KEY` tidak ada, Siteverify dilewati dan widget disembunyikan (`turnstile:false`). Production tanpa key tetap 503. Rate limit, blocklist dan batas pending tidak berubah.
- **Fitur tanpa credential:** `GET /api/config` memuat `environment`, `payments`, `shipping`, `googleEnabled`, `turnstile`, `stagingLogin`. Checkout menolak lebih dulu dengan 503 `Pembayaran belum tersedia`/`Ongkir belum tersedia` sebelum reservasi atau order dibuat (juga di production). Keranjang menampilkan "Checkout belum tersedia di lingkungan ini" dan menonaktifkan pencarian wilayah, ongkir dan tombol pesan; halaman produk tidak terpengaruh. Dashboard admin menampilkan daftar integrasi nonaktif.
- **Penanda dan SEO:** badge STAGING di header toko dan topbar admin, `X-Robots-Tag: noindex, nofollow` (Worker dan `_headers`), meta robots noindex, `robots.txt` `Disallow: /`.

Media staging disajikan Worker sendiri di `/media/*` (`MEDIA_ORIGIN` = `PUBLIC_ORIGIN`, Cache API + `immutable`), karena DNS ISP Indonesia memblokir `*.r2.dev`. Route ini hanya aktif bila kedua origin sama; production memakai custom domain R2. Upload ke origin `r2.dev` hanya diterima saat `APP_ENV=staging`.

## Pemeriksaan

```sh
npm run check
npm test
npm run build
npm run deploy:check # dry-run saja, tidak membuat deployment
npm audit
node scripts/load-test.mjs --requests 100 --concurrency 5
```

Tes memakai D1/R2 workerd lokal, library auth asli, dan respons provider terkontrol. Mereka bukan transaksi DOKU/Google/RajaOngkir live atau profiling CPU cloud. Checkout atomik menggunakan native D1 batch plus SQL triggers; jangan menggantinya dengan transaksi interaktif Drizzle. Regression coverage meliputi race stok/PO, rollback multi-item, scope idempotency, webhook duplicate/early/late/mismatch, recovery/outbox, session revocation, concurrent bootstrap, storage privacy, dan checkout lintas adapter.

## Dokumen

- [Kontrak desain](docs/system-design.md)
- [Status implementasi dan gate sebelum production](docs/implementation-status.md)
- [Kontrak provider dan auth](docs/integrations.md)
- [Storage/inbound email](docs/storage.md)
- [Runbook, backup/restore dan load test](docs/operations.md)
- [Bukti verifikasi lokal dan batas klaim](docs/local-verification.md)

**Batas penting:** Checkout-wide expiry/grace DOKU belum terbukti untuk merchant nyata. Status EXPIRED tingkat channel tidak otomatis membatalkan order; reservasi ambigu ditahan dan masuk manual review. Recovery token guest lintas perangkat, retensi PII, SLA RPO/RTO, alert produksi dan CPU/load cloud membutuhkan keputusan/pengujian operasional sebelum production.
