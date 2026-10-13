# Bukti verifikasi lokal — 13 Oktober 2026

Implementasi di orb, **belum dipush/dideploy**. Kontrak: [system-design.md](system-design.md). Provenance dan artefak yang dapat direview ada di [thread development](https://ampcode.com/threads/T-01a136a6-81c6-753f-82e4-90ee94811fa0). Bukti kuat lokal tidak sama dengan bukti menyeluruh produksi atau transaksi provider live.

## Kasus dan kontrol

| Klaim | Sebelum | Sesudah dan kontrol |
|---|---|---|
| Workflow admin sesuai kontrak | Baseline checkout detached dengan tes baru yang sama: 6 gagal, 1 lulus; endpoint inventory/campaign/detail/add-SKU belum tersedia, PATCH membawa default create, cursor terakhir nonnull | 7/7 kontrak lulus dengan D1 workerd; nonadmin/cross-origin ditolak; snapshot pembelian tetap sama setelah katalog berubah |
| PATCH hanya mengubah field yang dikirim | Zod 4 default create mengosongkan description atau mengubah mode PO | Edit name/price mempertahankan description/mode; validation existing tetap berjalan |
| Write UI tidak hilang setelah navigasi | Forced delayed-response cases dipakai untuk menguji ownership dialog/tab/session | UI behavioral tests menutup/membuka dialog, berpindah tab, menerima response terlambat dan refresh gagal; write acknowledged tetap direkonsiliasi, draft baru tidak tertimpa |
| Fulfillment hanya paid dan berurutan | Fixture paid/pending dibuat lokal, bukan pembayaran provider | Browser nyata processing → shipped LOCAL-RESI-001 → delivered; D1 completed/delivered, timeline paid/processing/shipped/delivered/completed; pending tetap pending/unfulfilled dan tidak mendapat aksi fulfillment |
| Ledger dan PO bukan sekadar form | SKU ink dibeli; campaign snapshot sudah ada | Edit harga ink 207500, tambah SKU moss 219000/375g/stock 7, adjustment −2 menghasilkan balance 5; campaign quota 23 dan sold 1/reserved 0, snapshot order tidak berubah |
| Sampel operasi tetap bounded saat backlog besar | Payment/outbox query umur tanpa forced age index membaca 10003/10002 row dengan temporary sort pada 5000 row/category | Index/query final membaca 21/21 row dan menghasilkan ID identik; pending orders 43→21; reviews 21→21; limit display 20 dengan lower bound, bukan COUNT total |
| Backup populated bisa dipulihkan | Wrangler session INSERT sebelum CREATE user gagal missing parent table meski defer FK | Export yang sama berhasil setelah prepare; 28612 bytes, 27 tabel/27 indeks/15 trigger, integrity/FK/count identik, original dump/checksum tetap sama |
| Recovery tidak merusak SQL atau target lain | Regression menggunakan foreign key forward reference, quoted semicolon/newline dan trigger dua statement | Real Wrangler/D1 restore mempertahankan exact token/text dan dua efek trigger; target existing ditolak, checksum salah ditolak sebelum target dibuat |
| Payment resume bukan payment baru | Pending fixture memiliki URL HTTPS sintetis | UI membuka URL attempt yang sama; paid/completed/unknown tidak menawarkan tombol; ini bukan bukti URL provider live dapat membayar |

## Pemeriksaan yang dapat diulang

```sh
npm run check
npm test
npm run build
npm run deploy:check
npm audit --omit=dev
```

Run 20:16 UTC: **34 commerce + 66 integration/storage/checkout/operations/UI/recovery = 100 tes lulus**. Check, build dan deployment dry-run lulus; audit production dependencies 0 vulnerability. Hint FormEvent dan warning rename package Vitest bukan failure. Provider HTTP dalam tes dikontrol; D1/R2 memakai runtime workerd/Miniflare, auth memakai library Better Auth asli.

Backup rehearsal populated: export/import validation 32337 ms, isolated restore 30496 ms. Dump mencakup credential session dan tidak diterbitkan sebagai artefak. Jangan rerun dump di production atau menganggap angka ini RPO/RTO. Langkah dan safety controls ada di [operations.md](operations.md).

## Bukti browser dan state

Chromium desktop 1280×900 dan narrow 390×844, scale 2. Capture telah diinspeksi; narrow tables memakai internal horizontal overflow dan document width 390. Natural scroll tersedia pada dialog detail/timeline. Ini bukan uji perangkat Android/iOS nyata.

Artefak tersimpan privat di `.amp/in/artifacts/` pada orb thread:

- `products-list.png`, `catalog-editor-desktop.png` — katalog dan editor.
- `inventory-desktop.png`, `inventory-narrow.png` — saldo dan ledger.
- `campaign-desktop.png`, `campaign-narrow.png` — campaign dan counter.
- `order-paid-desktop.png`, `order-detail-narrow.png`, `order-pending-admin.png`, `order-completed-admin-timeline.png` — paid/pending/completed controls.
- `operations-desktop.png`, `operations-narrow.png` — backlog sample.
- `payment-resume-desktop.png`, `payment-resume-narrow.png`, `order-completed-narrow.png` — customer pending/completed.
- `fulfillment.mp4`, `fulfillment.loop.webp` — real moving pointer processing/shipped interaction; delivered/completed diperiksa terpisah melalui DOM dan D1, bukan diklaim terlihat pada rekaman.
- `live-d1-evidence.json`, `query-evidence.json` — sanitized state dan query plans/rows read.

Semua order/payment/shipment evidence memakai fixture lokal sintetis. SQL paid transition fixture bukan notifikasi DOKU; pengujian signature/webhook/early/late/duplicate dilakukan terpisah dalam integration tests.

## Review dan batas bukti

Oracle feature review katalog, inventory/PO, order, operations, payment resume dan recovery telah diulang sesudah fixes tanpa blocker tersisa. Review adalah penilaian kode, bukan runtime proof.

Belum terbukti: DOKU merchant sandbox/live, Google OAuth callback nyata, Turnstile real token/replay, Komerce key/package live, WAF/DNS/multi-edge cache, cloud CPU/kuota/traffic, private cloud backup/Time Travel/cutover. Policy retention/RPO/RTO/financial exception/guest recovery dan alert destination tetap membutuhkan keputusan operasional; tidak ada data palsu, fallback provider atau external side effect untuk menyamarkan gate.

Durasi validation soak hanya dicatat setelah benar-benar selesai dengan waktu mulai/akhir dan exit status. Pengulangan suite lokal dapat menemukan flakiness/regression/runtime drift, tetapi tidak memperluas klaim menjadi ketahanan produksi lima jam.
