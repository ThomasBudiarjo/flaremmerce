# Flaremmerce — System Design dan Kontrak Implementasi

Versi 1.0 · 12 Oktober 2026 · Bahasa Indonesia · Timezone operasional Asia/Jakarta

## Ringkasan dan status dokumen

**Kebutuhan dari pembaca:** tidak ada keputusan tambahan yang diperlukan untuk menerima dokumen ini. Detail integrasi yang belum diketahui wajib diverifikasi sebelum implementasi terkait, bukan ditebak.

Dokumen ini merangkum keputusan diskusi pada [thread desain](https://ampcode.com/threads/T-01a12ff3-4334-7168-b8f3-fcfd624c924e). Ini adalah kontrak desain, **bukan bukti bahwa aplikasi sudah dibuat, diuji, atau dideploy**. Repository belum berisi implementasi aplikasi saat dokumen disusun.

Istilah **wajib** berarti invariant yang tidak boleh dilanggar. **Default** adalah pilihan awal yang boleh disesuaikan dengan alasan dan bukti. **Belum diverifikasi** berarti detail teknis masih menunggu dokumentasi atau pengujian. Tidak ada dokumen yang dapat menjamin nol kesalahan; invariants dan acceptance checks di sini digunakan untuk mencegah interpretasi yang keliru.

## D1 — Tujuan, batas sistem, dan scope

- E-commerce satu brand, bukan marketplace atau platform multi-tenant.
- Target medium traffic dan banyak request concurrent. Tidak ada angka throughput yang sudah dijanjikan atau diukur.
- Seluruh hosting, database, file storage, background jobs, dan email aplikasi berada dalam **satu akun Cloudflare**. Staging dan production harus memiliki resource dan secret terpisah.
- Baseline harus dapat dideploy pada **Workers Free** tanpa dependency yang mensyaratkan Workers Paid. Paid hanya opt-in dengan konfigurasi eksplisit.
- Integrasi eksternal yang disepakati: **DOKU**, **RajaOngkir**, dan **Google OAuth**. Mereka bukan hosting/database aplikasi tambahan.
- Guest checkout adalah kemampuan wajib, tidak boleh dikunci di belakang login atau paket Paid.
- Customer-facing authentication hanya Google sign-in. Tidak ada login password, magic link, atau email OTP customer pada baseline.
- Refund, retur, diskon, voucher, modul perhitungan pajak, multi-gudang, dan toko fisik belum disediakan. Penghapusan modul pajak bukan pernyataan bahwa kewajiban hukum/pajak bisnis tidak berlaku.

## D2 — Stack dan ownership

| Area | Pilihan | Tanggung jawab dan batas |
| --- | --- | --- |
| Storefront | Astro + React islands | Astro untuk HTML/SEO; React untuk varian, cart, ongkir, checkout dan elemen personal. Bukan full SPA storefront. |
| Admin | React + Vite full SPA | Shell dan bundle statis; API tetap memvalidasi auth dan permission. |
| Hosting/API | Cloudflare Workers + Static Assets | Asset-first; SSR dan endpoint bisnis di Worker. Pages tidak ditambahkan sebagai hosting kedua. |
| Bahasa/validasi | TypeScript + Zod | Validasi request di server; input browser tidak dipercaya. |
| Database | D1 + Drizzle ORM | Source of truth katalog, stok, order, pembayaran, auth, audit dan outbox. |
| Auth | Better Auth | Session D1, Google OAuth, cookie cache terbatas. Kompatibilitas adapter dan CPU Free harus dibuktikan. |
| Storage | R2 Standard | Media publik dipisahkan dari dokumen/attachment privat. |
| Background | Queues + consumer Worker | Delivery/retry pekerjaan; bukan satu-satunya tempat menyimpan pekerjaan kritis. |
| Scheduler | Workers Cron Triggers | Rekonsiliasi, outbox recovery, expiry dan cleanup dalam batch kecil. |
| Email | Email Routing/Email Worker; Email Sending opt-in | Inbound Free; outbound pelanggan membutuhkan Workers Paid sesuai dokumentasi saat desain. |
| Security | Turnstile, WAF/Managed Challenge, Workers Secrets | Perlindungan edge dan checkout, tanpa menggantikan authorization. |
| Observability | Workers Logs + Web Analytics + audit D1 | Telemetri teknis, traffic dan riwayat bisnis; bukan log secret/payload sensitif. |
| Tooling | Wrangler + Vitest | Development, migration, deployment dan verification. |

Arsitektur adalah **modular monolith**: satu sumber logika bisnis untuk web/API, background consumer dan email handler. Handler dapat memiliki deployment terpisah sesuai kebutuhan runtime; jangan menggandakan aturan harga, stok, atau pembayaran. Tidak ada microservices, VPS, Supabase, Redis, atau auth SaaS berlangganan sebagai dependency awal.

## D3 — Lifecycle checkout: order dibuat sebelum pembayaran

<figure id="fig-payment-lifecycle">
<div class="viz"><div class="flow">
<div class="node">Checkout + Turnstile<small>Server memvalidasi harga, ongkir dan kuota/stok</small></div>
<div class="edge"><span>Transaksi D1</span></div>
<div class="node hot">Order pending_payment + reservasi<small>Snapshot pembelian dan idempotency tersimpan</small></div>
<div class="edge"><span>Payment attempt tercatat → panggil DOKU</span></div>
<div class="node">Payment pending<small>HTTP sukses/redirect bukan bukti terbayar</small></div>
<div class="edge"><span>Webhook terverifikasi atau hasil rekonsiliasi authoritative</span></div>
<div class="node">Order paid + stok terjual + outbox<small>Perubahan bisnis atomik; duplicate tidak mengulang efek</small></div>
<div class="edge"><span>Fulfillment</span></div>
<div class="node ok">Processing → shipped → delivered<small>Order completed setelah fulfillment selesai</small></div>
</div></div>
<figcaption>Order pending adalah anchor pembayaran, bukan order siap dikirim. Detail API dan acknowledgment DOKU harus mengikuti dokumentasi produk yang dipilih.</figcaption>
</figure>

1. Browser mengirim item, pilihan ongkir, kontak/alamat, token Turnstile dan idempotency key. Customer boleh guest.
2. Worker memvalidasi Turnstile, payload, produk aktif, jumlah item, mode ready stock/PO, harga authoritative dan quote ongkir. Jika harga berubah dari yang ditampilkan, customer perlu mengonfirmasi total baru sebelum pembayaran.
3. Dalam unit kerja atomik D1, server mencatat checkout idempotency, membuat order `pending_payment`, menyimpan snapshot dan mereservasi seluruh item/kuota yang diperlukan. Kegagalan satu item tidak boleh meninggalkan reservasi parsial.
4. Payment attempt dengan identitas merchant yang stabil disimpan **sebelum** request eksternal DOKU. Network call tidak berada di dalam transaksi database.
5. Respons DOKU dipersist dan payment instruction/checkout URL dikembalikan. HTTP 200 dari create-payment tidak berarti pembayaran sukses; mapping status sebenarnya menunggu dokumentasi.
6. Webhook diverifikasi, dicocokkan dengan order, attempt, nominal, currency dan merchant yang relevan, lalu event dicatat durable. Hanya informasi provider yang authoritative boleh mengonfirmasi pembayaran.
7. Transisi pertama ke paid secara atomik mencatat pembayaran, mengonsumsi reservasi menjadi penjualan, menambah timeline dan outbox. Fulfillment tidak boleh terpicu dua kali.
8. Redirect/return page membaca status server. Browser tidak boleh menandai order paid melalui parameter URL atau respons lokal.

### Status terpisah, bukan satu enum untuk semua hal

| Entity | Status normal | Makna |
| --- | --- | --- |
| Order | pending_payment → paid → completed; cancelled sebagai cabang sebelum pembayaran terkonfirmasi | Paid berarti pembayaran terkonfirmasi, bukan otomatis dikirim. Completed setelah fulfillment selesai. Paid order tidak dibatalkan lewat flow baseline tanpa penanganan finansial eksplisit. |
| Payment attempt | created → pending → succeeded / failed / expired | Satu order boleh memiliki beberapa attempt; status sukses tidak boleh turun akibat event lama. |
| Fulfillment | unfulfilled → processing → shipped → delivered | Diubah melalui operasi admin yang terotorisasi; delivered tidak boleh diklaim hanya dari pembayaran. |

Kasus payment creation timeout dicatat sebagai **hasil belum diketahui** melalui metadata/status reconciliation yang sesuai. Jangan memaksakan mapping ke failed atau menciptakan payment baru secara buta. Model exception/manual review harus terpisah dari asumsi happy path; nama kolom final ditetapkan saat schema dibuat.

### Idempotency, retry dan race conditions wajib

- Idempotency key checkout terikat scope caller/checkout dan fingerprint payload. Key sama dengan payload berbeda ditolak; key sama tidak menghasilkan order baru atau membocorkan order caller lain.
- Retry dengan token Turnstile baru tetap mengacu checkout idempotency yang sama. Tidak perlu memakai ulang token Turnstile yang sudah consumed.
- Retry pembayaran menggunakan attempt aktif terlebih dahulu. Hasil timeout diverifikasi melalui kemampuan lookup/status DOKU sebelum mencoba membuat ulang; jangan mengasumsikan API provider memiliki idempotency header tertentu.
- Identitas transaksi provider dan dedup event disimpan dengan unique constraint yang sesuai kontrak API. Jika provider tidak memiliki event ID stabil, strategi dedup ditentukan dari dokumentasi, bukan fabricated ID.
- Webhook dapat tiba sebelum response create-payment dipersist. Identitas attempt yang sudah dicatat harus cukup untuk mengorelasikannya; respons terlambat tidak boleh menurunkan status succeeded menjadi pending.
- Event duplikat menjadi no-op terhadap efek bisnis. Event tidak berurutan tidak boleh membalik pembayaran sukses atau mengonsumsi stok dua kali.
- Race webhook sukses versus expiry diselesaikan melalui transaksi/conditional update. Tepat satu jalur menang; order tidak boleh simultaneously paid dan dilepas reservasinya.

### Reservasi, expiry dan exception pembayaran

Durasi reservasi mengikuti expiry metode pembayaran DOKU ditambah grace period yang terdokumentasi; **belum ada angka final**. Expiry worker tidak boleh melepas reservasi hanya berdasarkan clock lokal saat status provider ambigu. Lakukan reconciliation sesuai kontrak provider atau tandai manual review.

Pembayaran sukses setelah reservasi dilepas, pembayaran ganda, mismatch nominal atau order cancelled harus dicatat dan diangkat ke **manual review**; jangan otomatis mengirim tanpa stok atau menghapus bukti pembayaran. Tidak ada UI/API refund dan retur pada versi awal. Ini tidak menghilangkan kebutuhan penanganan operasional untuk uang yang sudah masuk, termasuk tindak lanjut di provider jika diperlukan.

## D4 — Katalog multi-SKU, inventory, PO dan timeline

- Setiap produk memiliki minimal satu variant dengan SKU unik. Awalnya satu SKU per produk; multi-SKU adalah struktur native sejak awal, bukan kolom tambahan di order nanti.
- Harga dan inventory/kuota terikat variant. Produk satu-SKU menggunakan default variant; tidak dipaksa menampilkan pilihan varian yang tidak ada.
- Tidak ada warehouse/store entity awal. Ledger inventory tetap diperlukan agar perubahan stok dapat ditelusuri.
- Ready stock tidak boleh oversold: available dihitung konsisten dari stok fisik dan reservasi aktif; reserve memakai conditional write dan transaksi, bukan read lalu write terpisah.
- PO tidak mereservasi stok fisik yang belum ada. Kuota PO finite diperlakukan sebagai kapasitas yang direservasi lalu dikonsumsi saat paid; kuota null berarti unlimited, bukan nol. Default PO tidak aktif sebelum campaign dikonfigurasi eksplisit.
- Campaign PO memiliki periode pemesanan, rentang estimasi pengiriman dan kuota opsional. Untuk baseline, satu variant tidak memiliki campaign aktif yang tumpang tindih. Pemenuhan PO mengikuti campaign pada snapshot order.
- Timeline mencakup milestone produksi/persiapan dan perjalanan order: paid, persiapan/produksi, siap kirim, shipped, delivered. Estimasi ditandai estimasi, bukan fakta atau jaminan tanggal.
- Mixed cart ready stock + PO memakai **satu pengiriman mengikuti item paling lambat**. Informasi ini wajib terlihat sebelum customer mengonfirmasi pembayaran. Split shipment belum disediakan.
- Janji rentang kirim disnapshot saat checkout. Perubahan campaign tidak diam-diam mengubah janji order lama; perubahan untuk order existing dicatat dalam timeline.
- Produk/variant yang sudah direferensikan order diarsipkan, tidak hard-delete sehingga menghilangkan riwayat.

## D5 — Ongkir melalui RajaOngkir

Customer harus memilih layanan pengiriman sebelum total final dibuat. Worker mengakses RajaOngkir menggunakan credential server; browser tidak mengirim tarif yang dipercaya begitu saja.

Quote dikaitkan dengan input authoritative: lokasi asal operasional yang dikonfigurasi, tujuan, berat total dari katalog, kurir/layanan dan parameter lain yang diwajibkan API. Lokasi asal bukan alasan menambahkan modul multi-gudang. Satuan berat/dimensi, pembulatan, cakupan wilayah dan bentuk identifier mengikuti dokumentasi paket RajaOngkir yang dipilih.

Cache quote memiliki TTL singkat; default usulan 5 menit, wajib ditinjau terhadap kontrak API. Snapshot ongkir final menyimpan layanan, nominal dan input/masa berlaku yang diperlukan untuk audit. Quote expired atau cart/alamat berubah harus divalidasi ulang; perubahan nominal membutuhkan persetujuan customer. Error provider tidak boleh dianggap gratis ongkir atau menggunakan quote stale tanpa batas. Input resi dan status shipment awal melalui admin; integrasi tracking otomatis belum diputuskan.

## D6 — Auth, session dan first-run wizard

**Guest checkout tidak membutuhkan session akun.** Cart boleh lokal di browser. Login Google bersifat opsional untuk customer; user account tidak otomatis dibuat dari email guest checkout.

Better Auth menyimpan primary session di D1. Cookie primary berisi opaque session token. Tidak ada JWT bearer token, refresh-token architecture atau token auth di localStorage sebagai dependency awal. Google OAuth memakai flow aman yang dikelola library, dengan validasi state/redirect dan verifikasi provider; detail adapter harus diuji di runtime Workers.

Admin juga memakai Google sign-in sebagai default yang dipilih pada desain. Akun Google baru tidak otomatis mendapat role admin. Login, role, permission dan akses resource diverifikasi server; shell SPA bukan security boundary.

### Bootstrap aman

- First-run wizard dipilih dibanding akun/password default yang ditanam dalam environment.
- Tetap ada bootstrap secret di Workers Secrets sebagai bukti kepemilikan deployment. Jangan menaruhnya di bundle SPA, URL, log atau dokumen publik.
- Wizard memerlukan Google identity yang terverifikasi dan bootstrap secret untuk menjadikan admin pertama.
- Pembuatan admin pertama serta penutupan bootstrap memakai transaksi dan singleton/unique constraint; dua request concurrent tidak boleh menghasilkan dua bootstrap owner.
- Setelah installation initialized, wizard ditutup server-side secara permanen untuk flow normal. Recovery tidak boleh membuka wizard publik kembali; gunakan prosedur operator terkontrol dan diaudit.
- Tidak ada public admin signup. Undangan/provisioning admin berikutnya tidak bergantung outbound email Paid; operator dapat provision identitas/role secara terotorisasi.

### Session caching dan keamanan cookie

| Request | Kebijakan |
| --- | --- |
| Katalog publik/aset | Tidak memanggil getSession atau query auth. |
| Guest checkout | Validasi checkout + Turnstile; tanpa login wajib. |
| Read biasa untuk area login | Cookie cache Better Auth, default TTL 60 detik, compact signed strategy. |
| Admin mutation, akses PII pelanggan, ekspor, perubahan role, operasi sensitif | Bypass cookie cache dan periksa session + permission terbaru di D1. |
| Cache kedaluwarsa | Revalidasi di D1. Session update bukan write wajib pada setiap request; ikuti updateAge library. |

Cookie memakai HttpOnly, Secure, SameSite yang cocok dengan OAuth, serta scope host/path minimal. Request mutation perlu proteksi CSRF/origin; OAuth redirect harus allowlisted. Cookie signed bukan encrypted: jangan menaruh rahasia atau PII berlebihan di cache. Jangan mencache response auth dalam shared CDN.

Revoked session dapat tetap diterima pada read yang memakai cookie cache sampai TTL habis. Logout lokal membersihkan cookie dan mencabut session; revocation perangkat lain tidak langsung menghapus cookie perangkat tersebut. Revalidasi database diperlukan untuk immediate enforcement. Callback custom session yang query role setiap kali dapat menghilangkan manfaat cache; jangan menyebut seluruh request bebas D1 hanya karena cookie cache aktif.

CPU login adalah komputasi Worker untuk auth/crypto/parsing, bukan waktu menunggu jaringan. Google sign-in menghindari local password hashing, tetapi parsing/verifikasi/OAuth tetap perlu budget CPU. Dilarang melemahkan keamanan crypto untuk memenuhi Free; bila library tidak memenuhi budget, evaluasi implementasi secara terukur atau jelaskan batas plan.

### Akses order guest

Token order guest random berentropi tinggi, scope ke order, disimpan hash-nya dan tidak boleh mudah ditebak. Jangan gunakan nomor order/email sebagai credential. Jangan masukkan token/PII ke log atau analytics; hindari kebocoran melalui referrer. Recovery/claim order guest bukan otomatis berdasarkan email sama; perlu bukti kepemilikan. UX pemulihan guest token belum ditetapkan dan harus dibahas sebelum menjanjikan pemulihan di UI.

## D7 — Caching SSR, API dan aset

| Resource | Default | Ketentuan |
| --- | --- | --- |
| Landing, about, kebijakan | Prerender + Static Assets | Update lewat build/deploy; tidak query D1 tiap kunjungan. |
| Produk/kategori dinamis | HTML SSR edge TTL 60 detik | Public HTML identik untuk semua user; admin read selalu fresh. |
| API katalog publik | Respons edge TTL 60 detik | Cache GET sukses yang dipilih eksplisit, bukan semua API. |
| Harga/stok browsing | Mengikuti cache katalog | Bukan jaminan availability/total checkout. |
| Referensi wilayah | Cache lebih panjang | TTL final berdasar karakter data dan API. |
| Checkout/payment/reservasi | Tidak cache | Server membaca authoritative state. |
| Auth/profil/order/API admin | private, no-store | Tidak masuk shared cache atau cache rules public. |
| JS/CSS hashed | public, max-age=31536000, immutable | Deploy menghasilkan URL baru. |
| HTML admin SPA | Revalidate | Jangan immutable setahun; shell menunjuk bundle deployment terbaru. |
| Foto produk | R2 custom domain + CDN, versioned URL | Default immutable untuk file yang benar-benar tidak ditimpa. |
| Invoice/attachment privat | R2 privat + authorization | Tidak di bucket/domain public media. |

SSR flow: cache lookup → hit mengembalikan HTML tanpa D1/render; miss membaca D1 dan render Astro lalu menyimpan public response. Harga/stock mutation dan data personal tidak dimasukkan ke response cache publik. Middleware auth global tidak boleh berjalan untuk seluruh katalog/aset.

Cache key memuat host/path dan parameter yang benar-benar memengaruhi output seperti pagination/filter/locale bila ada. Buang tracking parameter utm dari key, tetapi jangan membuang filter yang mengubah hasil. Batasi nilai filter, panjang search dan pagination supaya input arbitrary tidak menghancurkan hit rate. Jangan menambahkan private user identity ke public key sebagai cara mengamankan HTML yang sebenarnya personal.

Workers Cache API lokal per data center dan dapat evict sebelum TTL. Cache hit **tetap menjalankan Worker**; menghemat D1/render bukan semua kuota Worker. Cold misses lintas edge tetap terjadi. `stale-while-revalidate` dan `stale-if-error` tidak otomatis didukung cache.put/cache.match. Tidak menganggap KV/Cache API sebagai source of truth.

Default invalidation adalah TTL: update katalog publik dapat tertunda sekitar 60 detik, dengan browser HTML revalidation agar tidak menambah stale window panjang. `cache.delete()` hanya lokal; global purge harus memakai fasilitas Cloudflare yang benar dan diverifikasi jika nanti ditambahkan. Jangan menjanjikan update global instan dari delete lokal. Tanpa KV, tidak ada global cache lock; cold concurrent requests dapat membaca D1 lebih dari sekali.

Static Assets dilayani asset-first, bukan run_worker_first global. Header aset melalui _headers, header SSR/API melalui Worker; jangan menganggap _headers mengubah response generated Worker. R2 public media memakai custom domain produksi, bukan r2.dev. Varian gambar default disiapkan sebelum upload/build, bukan image resizing berat di Worker Free. Transformasi runtime opt-in setelah biaya/plan diverifikasi.

## D8 — Proteksi masuk website dan checkout

- Cloudflare edge memakai WAF/custom rule Managed Challenge berbasis risiko dalam kemampuan Free yang tersedia. Tidak ada CAPTCHA wajib setiap pengunjung atau mode blanket challenge sebagai default. Rules spesifik diuji agar browsing normal, SEO dan preview tidak terganggu.
- Turnstile Managed wajib untuk create-order/checkout; widget di browser, verifikasi Siteverify di Worker. Secret hanya Workers Secrets.
- Verifikasi success, hostname dan action yang diharapkan. Token berlaku 5 menit dan single-use sesuai dokumentasi; expired/failed token meminta token baru. Failure jaringan Siteverify tidak boleh membuka bypass checkout.
- Turnstile lolos bukan authorization, validasi harga, rate limiting atau idempotency. Guest checkout tetap dibatasi input/abuse dan server-side correctness.
- Webhook DOKU dikecualikan dari browser challenge/Turnstile/session login, tetapi bukan dari signature verification, batas payload dan pemeriksaan transaksi. Jangan mengekspos bypass challenge untuk semua /api hanya karena ada webhook.
- Cached public HTML tidak menanam session atau Turnstile token. Token dibuat client-side sehingga tidak dibagi melalui SSR cache.

## D9 — Webhook, outbox dan recovery

Worker menyediakan endpoint HTTPS publik untuk POST webhook. Pertahankan raw body dan header yang diperlukan untuk signature; canonicalization/signature/timestamp/replay policy mengikuti dokumentasi DOKU yang dipilih. Secret provider tidak berada di browser atau log.

Webhook invalid ditolak. Untuk webhook valid, event dan efek bisnis langsung yang pendek dapat dipersist dalam transaksi D1, lalu acknowledgment sesuai kontrak provider setelah sukses. Bila menerima event sebelum pemrosesan penuh, inbox/event harus durable dan memiliki recovery scanner. Jangan memberikan success lalu hanya mengandalkan waitUntil/queue tanpa bukti durable.

**Outbox dicatat atomik bersama perubahan bisnis.** Publisher mengirim outbox ke Queues; crash antara send dan marking sent dapat menyebabkan duplicate delivery dan harus aman. Consumer mencatat hasil dan mendeteksi efek yang sudah dijalankan. Database/queue/API eksternal tidak memiliki satu transaksi bersama; jangan menjanjikan exactly-once untuk seluruh sistem.

Cron memeriksa outbox belum selesai termasuk yang pernah terkirim tetapi tidak selesai, payment pending/unknown dan reservasi expiry. Scanner memakai index, backoff, batas attempt dan batch kecil. Error berulang masuk dead-letter/manual review dan alert, bukan retry tanpa batas. Consumer harus aman bila retry, DLQ redrive atau Cron mengirim ulang pekerjaan setelah queue retention 24 jam Free.

Efek eksternal seperti outbound email tidak selalu punya exactly-once/idempotency provider. Bila hasil kirim ambigu, catat kondisi dan reconcile bila API mendukung; jangan mengklaim pasti tidak ada email ganda. Side effect gagal tidak boleh menghapus paid order atau mengulang pengurangan stok.

## D10 — Email dan mode tanpa Paid

Inbound memakai Email Routing + Email Worker. Email Routing bukan mailbox Gmail/IMAP. Jika inbox support sepenuhnya di aplikasi dibuat, raw content/attachment ada di R2 privat, metadata/ticket/thread di D1; render email sebagai konten tidak tepercaya dengan sanitization dan pembatasan attachment.

Outbound Cloudflare Email Sending ke pelanggan **opt-in Workers Paid dan masih beta menurut dokumentasi saat desain**. Perlu onboard sending domain, DNS SPF/DKIM/DMARC dan verifikasi kuota/deliverability. Mode Free tidak menjanjikan order email, magic link, email invite atau reply support ke arbitrary customer. Pengiriman hanya ke verified destination pada Free bukan pengganti email pelanggan umum.

Tanpa outbound, customer melihat konfirmasi/status di website dan admin melalui dashboard. Tidak ada job outbound yang retry selamanya ketika fitur disabled. Aktivasi outbound tidak mengubah kemampuan dasar membeli. Lifecycle event tetap tercatat untuk audit, bukan alasan mengirim seluruh email historis otomatis ketika Paid diaktifkan.

## D11 — Schema D1 dan invariants penyimpanan

Nama tabel berikut adalah rancangan domain, bukan DDL/migration yang sudah diuji. Sesuaikan nama tabel auth dengan schema resmi versi Better Auth yang dipilih; jangan menebak schema internal library.

| Domain | Tabel | Data utama/constraint |
| --- | --- | --- |
| Katalog | products, product_variants, product_media | Unique slug/SKU, active/archive, harga integer, berat dan metadata varian. |
| PO | preorder_campaigns | Variant, periode, estimasi, quota nullable dan status; tidak overlapping aktif untuk variant yang sama. |
| Inventory | inventory, stock_reservations, inventory_movements | Counter fisik/reserved, reservation order-item, campaign allocation dan ledger reason. |
| Order | orders, order_items, order_shipping | Status, totals/currency, customer optional, guest token hash, snapshot item/alamat/layanan/PO. |
| Idempotency | checkout_requests atau record ekuivalen | Scoped key + payload fingerprint + order/result; unique constraint. |
| Payment | payment_attempts, payment_events | Stable merchant reference, provider identity, states, verified event/inbox, reconciliation metadata. |
| Fulfillment | shipments, order_events | Layanan/resi/status dan timeline append-only; baseline satu shipment per order. |
| Auth | Better Auth tables + role membership | Session user/account/verification sesuai library; admin authorization server-side. |
| Recovery | outbox_events, audit_logs, installation | Work status/attempt/next-run, actor/action, singleton bootstrap initialized. |

- Primary key aplikasi memakai identifier random yang collision-resistant. Nomor order publik adalah reference, bukan credential.
- Uang integer dalam unit yang disepakati eksplisit, default IDR rupiah bulat; adapter DOKU tidak boleh salah konversi unit. Kuantitas integer positif; berat/dimensi memakai satuan konsisten dan konversi boundary API yang diuji.
- Timestamp disimpan dalam konvensi UTC yang konsisten, default epoch milliseconds; tampilan Asia/Jakarta. Rentang tanggal estimasi adalah tanggal bisnis, tidak dikonversi sembarangan menjadi midnight lintas timezone.
- Foreign keys, CHECK/unique constraints dan indexes melindungi invariants. Available tidak negatif, reservation finite tidak melebihi kapasitas, total order adalah penjumlahan item + ongkir tanpa modul diskon/pajak.
- Snapshot order immutable untuk data komersial setelah pembayaran dibuat; perubahan alamat/ongkir setelah itu memerlukan flow eksplisit dan tidak boleh diam-diam mengubah transaksi DOKU. Nama, SKU, unit price, qty, alamat, tarif dan janji PO tidak diambil ulang dari katalog saat menampilkan history.
- Index utama mengikuti slug/SKU, order reference/customer, payment merchant/provider reference, pending payment expiry, reservation expiry, outbox status/next_run dan event ownership. List menggunakan pagination, bukan SELECT * seluruh tabel.
- Atomic batch/transaction D1 harus dibuktikan pada adapter/runtime yang dipakai. Tidak mengasumsikan transaksi interaktif Drizzle generik atau BEGIN manual bekerja pada D1. Konflik/zero affected rows harus menghasilkan rollback bisnis yang benar, bukan partial reserve.
- Business uniqueness mencegah dua payment confirmation menyebabkan double fulfillment. Nomor tracking bukan payment identity. Jangan memakai stale read replica untuk memutuskan stock/payment write.
- Data historis finansial/audit tidak hard-delete melalui aksi hapus produk. Retensi PII/log/email/guest token perlu policy eksplisit sebelum production; tidak berarti simpan semua data selamanya.

## D12 — Free-first, kapasitas dan layanan opt-in

Angka berikut berasal dari dokumentasi yang dibaca saat diskusi dan harus diperiksa lagi sebelum deploy. Kuota umumnya dibagi resource/account sesuai layanan, bukan per pengunjung atau satu Worker baru untuk setiap kuota.

| Layanan | Baseline/limit relevan | Konsekuensi |
| --- | --- | --- |
| Workers Free | 100.000 dynamic requests/hari; 10 ms CPU per HTTP request | Cache API tidak menghapus invocation. SSR/auth perlu profiling; I/O waiting berbeda dari CPU. |
| D1 Free | 5 juta rows read/hari; 100.000 rows written/hari; 500 MB/database, 5 GB total | Yang dihitung rows scanned/written, bukan jumlah query. Index memengaruhi biaya. Kuota habis dapat menghentikan query. |
| Queues Free | 10.000 operations/hari; retention 24 jam | Normal send/read/delete sekitar 3 operasi/pesan kecil sebelum retry. Durable outbox diperlukan. |
| R2 Standard allowance | 10 GB-month; 1 juta Class A dan 10 juta Class B operasi/bulan | Subscription harus diaktifkan; overage dapat ditagih terpisah dari Workers Paid. Egress gratis bukan semua operasi gratis. |
| Email Routing | Inbound tersedia Free | Bukan general mailbox/outbound transactional pelanggan. |
| Email Sending | Workers Paid, beta saat desain | Explicit opt-in; kuota/domain/deliverability diperiksa. |

Workers Paid capacity, outbound email, dan layanan optimasi gambar berbayar bukan otomatis aktif. Jangan menganggap semua produk Cloudflare Free karena account plan Free. Tidak ada jaminan Rp0 tanpa batas atau no-card khusus R2.

Concurrency ditangani cache public, transaksi pendek, query indexed, bounded batch dan background jobs. D1 per instance memproses query serial; menambah Worker bukan meningkatkan kapasitas database yang sama. Load test membedakan browsing, cache cold/hot, login, checkout dan webhook burst. Upgrade opt-in atau batas operasional dijelaskan bila Free tidak memenuhi target; jangan menyatakan load tinggi pasti aman tanpa pengukuran.

KV, Redis, Durable Objects, Workflows, external search dan service abstraction tambahan tidak dimasukkan default. Durable Objects baru dipertimbangkan jika contention/flash sale membutuhkan koordinasi yang terbukti; KV eventual consistency bukan lock/stok/payment truth atau solusi immediate session revocation.

## D13 — Operasional, observability, backup dan keamanan data

- Log technical error, correlation ID, order/payment reference nonsecret, transition dan queue attempt. Jangan log API key, cookie, OAuth token, guest access token, bootstrap secret, alamat lengkap atau raw email/payment payload tanpa redaction.
- Audit admin menyimpan actor, action, target, timestamp dan perubahan penting yang sudah direduksi/redacted.
- Pantau error/CPU, kuota D1/Workers/Queues/R2, payment unknown/pending terlalu lama, reservasi overdue, oldest unfinished outbox, DLQ dan kebutuhan manual review. Metode alert harus sesuai kemampuan Free; outbound alert bukan asumsi gratis.
- Gunakan D1 Time Travel sesuai plan dan backup/export terjadwal ke R2 privat. Default target backup harian jika biaya/resource memungkinkan; cara export snapshot konsisten tidak dipaksakan ke Cron CPU 10 ms. Pilih tooling Cloudflare yang didukung setelah diverifikasi.
- Uji restore ke resource terpisah, verifikasi integritas dan dokumentasikan prosedur recovery. Cadangan R2 dalam akun sama tidak melindungi account compromise; perlindungan akun/MFA/least privilege dan batas disaster recovery dijelaskan.
- Secret staging/production dan OAuth redirect dipisahkan. Sandbox payment tidak menyentuh pembayaran produksi. Migration produksi, deployment, billing activation dan perubahan shared infrastructure memerlukan otorisasi yang sesuai.
- Retensi/recovery guest access, target RPO/RTO dan mekanisme alert belum final. Jangan menyebut backup siap sebelum export + restore berhasil diuji.

## D14 — Hal yang secara eksplisit dihindari

1. Membuat order hanya setelah payment success; memakai HTTP 200/redirect sebagai bukti terbayar.
2. Menjalankan side effect kritis tanpa durable record, atau menganggap queue exactly-once.
3. Read-then-write stock tanpa atomicity; melepas reservasi saat status pembayaran ambigu; memproses duplicate webhook dua kali.
4. Memercayai harga/ongkir/role/customer identity dari browser.
5. Cache public terhadap session, PII, auth, order, admin API dan checkout; auth middleware global pada semua public asset.
6. Menganggap cache global, cache.delete global purge, SWR Cache API otomatis atau KV pengganti Redis lengkap.
7. Mandatory login customer, password customer, public admin signup, first wizard tanpa ownership proof, atau JWT/localStorage auth tanpa kebutuhan.
8. Claim guest order hanya dari email yang sama; memakai nomor order sebagai secret.
9. Browser challenge/Turnstile pada webhook provider; skip signature karena endpoint sudah dilindungi Cloudflare.
10. Bundle secret, log token/PII, bucket private document dijadikan public, atau r2.dev sebagai endpoint produksi.
11. Paid dependency wajib dalam baseline, auto-upgrade billing atau menganggap free allowance tidak dapat menimbulkan biaya.
12. Menambah refund/retur, voucher/diskon, tax engine, multi-gudang, split shipment, marketplace atau microservices sebelum scope baru disepakati.
13. Menjanjikan unlimited concurrency, instant revocation dengan cookie cache, email free ke semua customer atau compatibility auth/D1 yang belum diuji.

## Belum diverifikasi — bukan izin untuk mengarang kontrak API

| Tag | Area | Yang harus ditemukan/dibuktikan sebelum implementasi |
| --- | --- | --- |
| V1 | DOKU | Produk/flow, sandbox, signature raw request, merchant reference, identity event, acknowledge/retry policy, status lookup, expiry, currency units, timeout/idempotency dan event order. |
| V2 | RajaOngkir | Paket/API aktif, lokasi asal, ID wilayah, satuan/pembulatan, services, rate/usage limit dan validitas quote. |
| V3 | Better Auth | Versi, Google OAuth, schema/Drizzle D1 compatibility, transaksi auth, cookie-cache bypass, bootstrap dan CPU Free. |
| V4 | D1 checkout | Atomic reserve multi-item, constraint/error handling dan races expiry/webhook pada stack nyata, bukan hanya database mock. |
| V5 | Deploy/security | Free WAF rule quota/capabilities, route exceptions, cache on custom domains, Static Assets routing dan Siteverify behavior. |
| V6 | Operasional | Export/restore konsisten, jadwal/budget backup, alert Free, RPO/RTO, retensi PII dan UX guest token recovery. |
| V7 | Capacity | SKU/dataset representatif dan hasil load test; angka concurrent aman berdasarkan evidence, bukan klaim desain. |

## Acceptance checks sebelum production

- Guest checkout dapat selesai tanpa auth/outbound email/Paid binding; Google login customer tidak membuka admin.
- Dua bootstrap request bersamaan hanya menghasilkan satu initial admin; setup berikutnya ditolak.
- Tampered/expired session ditolak; revocation berlaku segera pada sensitive endpoints dan mengikuti TTL pada cached reads.
- Turnstile invalid/expired/replayed menolak checkout; retry token baru dengan key sama tidak membuat duplicate order.
- Dua customer berebut item terakhir tidak oversell; multi-item kegagalan tidak menghasilkan reservasi parsial; PO finite tidak overbook.
- Repeated create-payment, provider timeout, webhook sebelum API response, duplicate/out-of-order webhook dan expiry race menghasilkan state konsisten.
- Invalid signature/mismatch amount tidak mengonfirmasi order; late/duplicate payment menjadi manual review dan tidak double fulfill.
- Stale katalog tidak menentukan checkout total; stale ongkir/changed cart diminta quote ulang; API ongkir gagal tidak membuat gratis ongkir.
- Cache hit public menghindari query D1/render; query key tidak tertukar; user A tidak pernah menerima data user B melalui shared cache.
- Asset hash cache immutable, SPA shell mengikuti deploy, foto berversi dan dokumen privat tidak dapat diakses anonim.
- Queue outage/expiry/duplicate delivery dan crash sebelum/sesudah side effect dapat dipulihkan dari outbox tanpa double stock mutation.
- Load test public cold/hot, auth, checkout dan webhook burst melaporkan latency/error/CPU/rows/queue usage; test tidak hanya mengukur HTTP 200 katalog.
- Backup berhasil direstore dan resource/env produksi terisolasi dari sandbox. UI checkout menampilkan mixed PO shipping promise dan status pending dengan benar.

## Risiko dan tanda awal kegagalan desain

- **R1 — Free tidak cukup untuk SSR/auth/load.** Sinyal: CPU exceeded, kuota error atau latency checkout naik. Tindakan: profiling, query/cache tuning, bound input, lalu kapasitas Paid opt-in bila perlu; jangan mengurangi keamanan.
- **R2 — Pembayaran sukses tetapi stok sudah dilepas.** Sinyal: reconciliation late success. Tindakan: manual review, audit dan perbaiki expiry/grace; jangan mark failed atau silently fulfill.
- **R3 — Cache menyimpan data salah/personal.** Sinyal: URL/filter salah atau identitas lintas user. Tindakan: explicit cache allowlist, canonical key dan privacy test sebelum deploy.
- **R4 — Queue job hilang/duplicate.** Sinyal: outbox umur panjang/DLQ/side effect ulang. Tindakan: durable scanning, idempotent consumer, bounded retry dan operational review.
- **R5 — Recovery hanya ada di dokumen.** Sinyal: backup belum diuji restore atau batas R2/export terlampaui. Tindakan: uji nyata, ukur biaya/masa kehilangan data dan jangan mengklaim DR penuh.

## Sumber dan provenance

Keputusan bisnis/desain berasal dari thread yang ditautkan pada ringkasan, termasuk persetujuan atas default yang dipilih untuk lifecycle, PO, wizard, reliability dan schema. Dokumen provider DOKU/RajaOngkir **belum dibaca untuk kontrak implementasi**, sesuai keputusan bahwa pembacaan dilakukan nanti.

Sumber Cloudflare/Better Auth yang diperiksa dalam diskusi (limit dan status produk dapat berubah):

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/) dan [pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/) dan [activation](https://developers.cloudflare.com/r2/get-started/)
- [R2 public buckets/custom domain](https://developers.cloudflare.com/r2/buckets/public-buckets/)
- [Workers Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/)
- [Static Assets bindings/routing](https://developers.cloudflare.com/workers/static-assets/binding/) dan [headers](https://developers.cloudflare.com/workers/static-assets/headers/)
- [Cloudflare Email Service](https://developers.cloudflare.com/email-service/), [limits](https://developers.cloudflare.com/email-service/platform/limits/) dan [onboarding](https://developers.cloudflare.com/email-service/get-started/send-emails/)
- [Better Auth session management](https://www.better-auth.com/docs/concepts/session-management) dan [Drizzle adapter](https://www.better-auth.com/docs/adapters/drizzle)
- [Turnstile server-side validation](https://developers.cloudflare.com/turnstile/get-started/server-side-validation/) perlu diperiksa saat implementation gate V5.

Dokumen ini tidak mengotorisasi publish, push, production migration, deployment, pembelian layanan atau perubahan billing. Penyesuaian keputusan harus memperbarui dokumen ini dan menjelaskan alasan; unresolved implementation gates tidak boleh disamarkan sebagai fitur selesai.
