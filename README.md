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

## Credential dan resource

Tanpa credential, browsing/cart tetap berfungsi tetapi login, quote ongkir dan pembayaran ditutup. Ini **bukan sandbox provider palsu**. Atur konfigurasi lokal privat `.dev.vars`, jangan commit nilai secret. Binding nonsecret: `PUBLIC_ORIGIN` canonical origin, `TURNSTILE_SITE_KEY`, `RAJAONGKIR_ORIGIN`, `RAJAONGKIR_COURIERS`, `MEDIA_ORIGIN`; secret: `BETTER_AUTH_SECRET`, `GOOGLE_CLIENT_SECRET`, `BOOTSTRAP_SECRET`, `TURNSTILE_SECRET_KEY`, `DOKU_SECRET_KEY`, `RAJAONGKIR_API_KEY`. Google client ID/DOKU client ID tetap hanya konfigurasi server. Auth/bootstrap secret minimal 32 karakter random. Default `DOKU_MODE=sandbox`; production harus opt-in.

First admin harus sign-in Google terverifikasi lalu menyerahkan bootstrap secret. User Google biasa tidak otomatis admin. Tidak ada akun/password admin bawaan atau public admin signup. Guest checkout tidak membutuhkan Google, session auth atau outbound email. Cookie scope guest didapat sebelum reservasi/Siteverify; UI mengulang payload/key yang sama sekali setelah HTTP 428. Token akses guest disimpan hash di D1, dikirim lewat header, tidak dimasukkan URL/localStorage.

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

**Batas penting:** Checkout-wide expiry/grace DOKU belum terbukti untuk merchant nyata. Status EXPIRED tingkat channel tidak otomatis membatalkan order; reservasi ambigu ditahan dan masuk manual review. Recovery token guest lintas perangkat, retensi PII, SLA RPO/RTO, alert produksi dan CPU/load cloud membutuhkan keputusan/pengujian operasional sebelum production.
