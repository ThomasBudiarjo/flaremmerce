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

Daftar produk/pesanan memakai tabel dengan pencarian lokal atas data yang sudah dimuat (bukan pencarian seluruh database). Detail dan tambah produk memakai dialog Radix. Inventori/pre-order memilih SKU dari katalog server, tanpa mengetik ID manual. Login dev dan Google tetap menggunakan auth server; shell login tidak menampilkan data admin sebelum session tersedia.

Produk existing dapat diedit/diarsipkan, ditambah SKU (maksimal 30), dan diaktifkan kembali. Inventori menampilkan saldo tersedia/reservasi serta ledger berpaginasi. Campaign PO termasuk yang future/inactive dapat diedit tanpa mengubah snapshot order atau menimpa counter sold/reserved. Detail pesanan menampilkan item yang benar-benar dibeli dan hanya menawarkan langkah fulfillment berikutnya untuk order paid. Produk/pesanan menyediakan load-more; pencarian tetap hanya atas data yang dimuat.

Panel Operasional menampilkan sampel 20 unfinished tertua per kategori, termasuk payment exhausted dan outbox dead; indikator lebih dari 20 adalah batas bawah, bukan total seluruh database. Terapkan migration 0006/0007 sebelum memakai API/panel baru. Customer pending dapat melanjutkan URL HTTPS payment attempt yang sama ketika tersedia; tombol ini tidak membuat attempt baru dan tidak muncul untuk order selesai.

Foto utama dapat diunggah dari dialog produk baru/existing (JPEG/PNG/WebP ≤5 MiB; memerlukan MEDIA dan MEDIA_ORIGIN). Manual review menyediakan bukti, catatan wajib, status ditangani/buka kembali dan audit; tindakan review tidak mengubah pembayaran, stok atau pesanan. Terapkan migration 0004/0005 sebelum memakai fitur ini dan riwayat customer.

Checkout memilih wilayah melalui pencarian Komerce, bukan mengetik destination ID. Riwayat di `/order` hanya memuat pesanan yang dibuat dengan akun pemilik; guest tetap memakai token privat, bukan klaim berdasarkan email sama. Credential provider tetap wajib dan tidak ada fallback ongkir gratis.

## Credential dan resource

`npm run dev` otomatis membuat `BETTER_AUTH_SECRET` dan `BOOTSTRAP_SECRET` random sekali di `.dev.vars` privat (permission 0600); restart mempertahankan nilainya. Buka `/admin/` lalu klik **Masuk admin dev**: tanpa Google/password, session Better Auth asli dan admin pertama pada database lokal kosong disiapkan otomatis. Tidak mengambil alih instalasi yang sudah memiliki owner atau mengembalikan role yang dicabut. Login dev memerlukan kedua flag server `APP_ENV=development` dan `DEV_LOGIN_ENABLED=true`; jangan pasang keduanya pada deployment shared/production. Session identitas dev ditolak oleh akses admin/commerce saat mode dev dimatikan. Portal dev memberi akses admin kepada siapa pun yang bisa membuka portal; jangan gunakan data nyata. Untuk HTTPS portal, jalankan `node scripts/dev-setup.mjs --origin https://HOST` sebelum restart dev server agar Origin/cookie sesuai.

Tanpa credential provider, quote ongkir dan pembayaran tetap ditutup. Ini **bukan sandbox provider palsu**. Atur konfigurasi lokal privat `.dev.vars`, jangan commit nilai secret. Binding nonsecret: `PUBLIC_ORIGIN` canonical origin, `TURNSTILE_SITE_KEY`, `RAJAONGKIR_ORIGIN`, `RAJAONGKIR_COURIERS`, `MEDIA_ORIGIN`; secret: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `BOOTSTRAP_SECRET`, `TURNSTILE_SECRET_KEY`, `DOKU_SECRET_KEY`, `RAJAONGKIR_API_KEY`. Google client ID/DOKU client ID tetap hanya konfigurasi server. Auth/bootstrap secret minimal 32 karakter random. Default `DOKU_MODE=sandbox`; production harus opt-in.

Di production, first admin harus sign-in Google terverifikasi lalu menyerahkan bootstrap secret yang dibuat random dan dipasang operator melalui Workers Secrets (bukan digenerate setiap request). User Google biasa tidak otomatis admin. Tidak ada akun/password admin production bawaan atau public admin signup. Guest checkout tidak membutuhkan Google, session auth atau outbound email. Cookie scope guest didapat sebelum reservasi/Siteverify; UI mengulang payload/key yang sama sekali setelah HTTP 428. Token akses guest disimpan hash di D1, dikirim lewat header, tidak dimasukkan URL/localStorage.

Root Wrangler memakai resource lokal dan D1 ID dummy, **jangan deploy langsung**. R2 media dan private terpisah; Queues lokal memiliki producer/consumer dan Cron recovery tetap aktif. Staging/production membutuhkan resource, canonical domain, OAuth redirect, merchant settings, Turnstile hostname dan secret terpisah, serta izin operator sebelum provision/deploy/migration. Tidak ada outbound pelanggan/Paid binding.

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
