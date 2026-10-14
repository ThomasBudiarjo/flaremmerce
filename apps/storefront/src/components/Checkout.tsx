import { useEffect, useRef, useState } from "react";
import { api, google, readCart, writeCart, type CartItem } from "../lib/cart";
import { type Product, money, date } from "../lib/catalog";
import Turnstile from "./Turnstile";
import { normalizePhone } from "../../../../src/shared";
type Destination = { id: string; label: string; city: string; postalCode: string };
type Quote = {
  id: string;
  service: string;
  amount: number;
  expiresAt: string | number;
};
export default function Checkout() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [config, setConfig] = useState<{
    turnstileSiteKey?: string;
    googleEnabled?: boolean;
  }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quoteId, setQuoteId] = useState("");
  const [search, setSearch] = useState("");
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const searchVersion = useRef(0);
  const quoteVersion = useRef(0);
  const [token, setToken] = useState("");
  const [reset, setReset] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  // City and postal code come from the server-side destination record, never from this form.
  const [address, setAddress] = useState({ line: "", destination: "" });
  const [result, setResult] = useState<any>();
  const key = useRef("");
  const locked = useRef(false);
  const fingerprint = useRef("");
  useEffect(() => {
    const cart = readCart();
    setItems(cart);
    const loadProducts = async () => {
      const products: Product[] = [];
      let cursor: string | null = null;
      do {
        const page = await api(`/api/catalog?limit=90${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`);
        products.push(...page.products);
        cursor = page.nextCursor;
      } while (cursor && cart.some(item => !products.some(p => p.variants.some(v => v.id === item.variantId))));
      return products;
    };
    Promise.all([loadProducts(), api("/api/config")])
      .then(([c, f]) => {
        setProducts(c);
        setConfig(f);
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const lines = items.map((i) => ({
    ...i,
    product: products.find((p) => p.variants.some((v) => v.id === i.variantId)),
    variant: products
      .flatMap((p) => p.variants)
      .find((v) => v.id === i.variantId),
  }));
  const subtotal = lines.reduce(
    (s, l) => s + (l.variant?.price || 0) * l.quantity,
    0,
  );
  const quote = quotes.find((q) => q.id === quoteId);
  const selectedDestination = destinations.find((d) => d.id === address.destination);
  const invalid = lines.some(
    (l) =>
      !l.variant ||
      l.variant.stockLevel === "out" ||
      (l.variant.maxPerOrder != null && l.quantity > l.variant.maxPerOrder),
  );
  const preorders = lines.filter((l) => l.variant?.mode === "preorder");
  const campaignMissing = preorders.some((l) => !l.variant?.campaign);
  const latest = preorders.reduce(
    (value, l) =>
      Math.max(value, new Date(l.variant?.campaign?.shipTo || 0).getTime()),
    0,
  );
  function changeCart(next: CartItem[]) {
    try {
      writeCart(next);
      setItems(next);
      quoteVersion.current++;
      setQuotes([]);
      setQuoteId("");
      setAccepted(false);
    } catch {
      setError("Tas tidak dapat disimpan di browser.");
    }
  }
  function invalidateQuotes() {
    quoteVersion.current++;
    setQuotes([]);
    setQuoteId("");
    setAccepted(false);
  }
  async function searchDestinations() {
    const version = ++searchVersion.current;
    invalidateQuotes();
    setAddress((a) => ({ ...a, destination: "" }));
    setDestinations([]);
    setSearching(true);
    setSearchMessage("");
    try {
      const data = await api("/api/shipping/destinations", { search });
      if (version !== searchVersion.current) return;
      setDestinations(data.destinations);
      setSearchMessage(data.destinations.length ? `${data.destinations.length} wilayah ditemukan. Pilih wilayah tujuan. Jika belum sesuai, gunakan kata pencarian lebih spesifik.` : "Wilayah tidak ditemukan. Coba nama kelurahan, kecamatan, atau kode pos lain.");
    } catch {
      if (version === searchVersion.current) setSearchMessage("Pencarian wilayah belum tersedia. Silakan coba lagi; ongkir tidak dapat dihitung tanpa tujuan.");
    } finally {
      if (version === searchVersion.current) setSearching(false);
    }
  }
  async function shipping() {
    if (locked.current || !address.destination) return;
    const version = ++quoteVersion.current;
    setBusy(true);
    setError("");
    setQuotes([]);
    setQuoteId("");
    setAccepted(false);
    try {
      const data = await api("/api/shipping/quote", {
        destination: address.destination,
        items,
      });
      if (version !== quoteVersion.current) return;
      setQuotes(data.quotes);
      if (!data.quotes.length)
        setError("Tidak ada layanan tersedia untuk tujuan ini.");
    } catch (e) {
      if (version === quoteVersion.current) setError((e as Error).message);
    } finally {
      if (version === quoteVersion.current) setBusy(false);
    }
  }
  async function checkout(e: React.FormEvent) {
    e.preventDefault();
    if (locked.current) return;
    if (!address.destination || !quote || new Date(quote.expiresAt).getTime() <= Date.now()) {
      setError("Quote pengiriman kedaluwarsa. Periksa ongkir kembali.");
      setQuoteId("");
      return;
    }
    if (!normalizePhone(contact.phone)) {
      setError("Nomor HP tidak valid. Gunakan nomor seluler Indonesia, misalnya 0812… atau +62812….");
      return;
    }
    locked.current = true;
    setBusy(true);
    setError("");
    const payload = {
      items,
      shippingQuoteId: quote.id,
      contact,
      address,
      expectedTotal: subtotal + quote.amount,
    };
    const fp = JSON.stringify(payload);
    if (!key.current || fingerprint.current !== fp) {
      key.current = crypto.randomUUID();
      fingerprint.current = fp;
    }
    try {
      const data = await api("/api/checkout", {
        ...payload,
        idempotencyKey: key.current,
        turnstileToken: token,
      });
      setResult(data);
      if (data.order?.guestToken) {
        try {
          sessionStorage.setItem(
            "flaremmerce-order-access",
            JSON.stringify({
              reference: data.order.reference,
              token: data.order.guestToken,
            }),
          );
        } catch {
          /* Token remains visible in confirmation even without browser storage. */
        }
      }
      try {
        writeCart([]);
      } catch {
        /* Confirmed order must remain visible. */
      }
    } catch (e) {
      const status = (e as Error & { status?: number }).status;
      // A definite refusal (validation, limits, blocklist) never created a payment; only unclear failures need the warning.
      setError(
        status && status >= 400 && status < 500
          ? (e as Error).message
          : (e as Error).message + " Jika hasil pembayaran belum diketahui, jangan membuat pembayaran baru secara terpisah.",
      );
    } finally {
      setToken("");
      setReset((r) => r + 1);
      locked.current = false;
      setBusy(false);
    }
  }
  if (loading) return <p role="status">Menyiapkan tas belanja…</p>;
  if (result)
    return (
      <div className="panel">
        <span className="badge">Order tercatat · bukan bukti terbayar</span>
        <h2 style={{ marginTop: 20 }}>Referensi {result.order.reference}</h2>
        <p>
          Status: {result.order.status} · Pembayaran:{" "}
          {result.paymentState || "Belum terkonfirmasi"}
        </p>
        <p className="price">{money(result.order.total)}</p>
        <div className="notice">
          Pembayaran hanya berhasil setelah konfirmasi server. Jika status belum
          diketahui, jangan membayar ulang secara terpisah.
        </div>
        {result.order.guestToken && (
          <>
            <label htmlFor="guest-token">
              Simpan token akses ini secara privat
            </label>
            <input id="guest-token" readOnly value={result.order.guestToken} />
            <p>
              Token diperlukan untuk melihat pesanan. Tidak ada pemulihan token
              atau email otomatis yang dijanjikan.
            </p>
          </>
        )}
        {result.paymentUrl && /^https:\/\//.test(result.paymentUrl) && (
          <a className="button" href={result.paymentUrl} rel="noreferrer">
            Lanjut ke penyedia pembayaran ↗
          </a>
        )}{" "}
        <a className="button" href="/order">
          Lihat status pesanan
        </a>
      </div>
    );
  if (!items.length)
    return (
      <div className="panel">
        {error && <p role="alert">{error}</p>}
        <h2>Tas masih kosong.</h2>
        <p>Ada ruang untuk favorit barumu.</p>
        <a className="button" href="/catalog">
          Lihat koleksi ↗
        </a>
      </div>
    );
  return (
    <form onSubmit={checkout}>
      <div className="checkout">
        <div>
          <div className="panel">
            <h2>Pilihanmu</h2>
            {lines.map((l) => (
              <div className="line" key={l.variantId}>
                <div className="row">
                  <div>
                    <strong>
                      {l.product?.name || "Produk tidak tersedia"}
                    </strong>
                    <p className="muted">
                      {l.variant?.name} ·{" "}
                      {l.variant?.mode === "preorder"
                        ? "Pre-order"
                        : "Ready stock"}
                    </p>
                  </div>
                  <span>{money((l.variant?.price || 0) * l.quantity)}</span>
                </div>
                <div className="row">
                  <input
                    aria-label={"Jumlah " + (l.product?.name || l.variantId)}
                    type="number"
                    min="1"
                    max={l.variant?.maxPerOrder ?? 99}
                    value={l.quantity}
                    disabled={busy}
                    onChange={(e) =>
                      changeCart(
                        items.map((i) =>
                          i.variantId === l.variantId
                            ? {
                                ...i,
                                quantity: Math.max(
                                  1,
                                  Math.floor(Number(e.target.value) || 1),
                                ),
                              }
                            : i,
                        ),
                      )
                    }
                  />
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      changeCart(
                        items.filter((i) => i.variantId !== l.variantId),
                      )
                    }
                  >
                    Hapus
                  </button>
                </div>
              </div>
            ))}
          </div>
          <div className="panel">
            <h2>Kontak & alamat</h2>
            <p>Checkout tamu. Akun tidak diperlukan.</p>
            {config.googleEnabled && (
              <button
                type="button"
                onClick={() =>
                  google(location.origin + "/cart").catch((e) =>
                    setError(e.message),
                  )
                }
              >
                Opsional: lanjut dengan Google
              </button>
            )}
            {(["name", "email", "phone"] as const).map((f, index) => (
              <div key={f}>
                <label htmlFor={f}>
                  {["Nama penerima", "Email", "Nomor telepon"][index]}
                </label>
                <input
                  id={f}
                  required
                  disabled={busy}
                  type={
                    f === "email" ? "email" : f === "phone" ? "tel" : "text"
                  }
                  autoComplete={
                    f === "name" ? "name" : f === "email" ? "email" : "tel"
                  }
                  value={contact[f]}
                  onChange={(e) =>
                    setContact({ ...contact, [f]: e.target.value })
                  }
                />
              </div>
            ))}
            <label htmlFor="line">Alamat lengkap (jalan, nomor, RT/RW)</label>
            <input
              id="line"
              required
              disabled={busy}
              value={address.line}
              onChange={(e) => {
                setAddress({ ...address, line: e.target.value });
                invalidateQuotes();
              }}
            />
            <label htmlFor="destination-search">Cari wilayah pengiriman</label>
            <input
              id="destination-search"
              value={search}
              disabled={busy}
              maxLength={100}
              aria-describedby="destination-help destination-status"
              onKeyDown={(e) => {
                if (e.key === "Enter") { e.preventDefault(); if (search.trim().length >= 3) void searchDestinations(); }
              }}
              onChange={(e) => {
                searchVersion.current++;
                setSearch(e.target.value);
                setSearching(false);
                setSearchMessage("");
                setDestinations([]);
                setAddress({ ...address, destination: "" });
                invalidateQuotes();
              }}
            />
            <p id="destination-help" className="muted">Masukkan nama kota, kecamatan, kelurahan, atau kode pos (minimal 3 karakter), lalu cari dan pilih wilayah yang sesuai alamat.</p>
            <button type="button" disabled={busy || searching || search.trim().length < 3} onClick={searchDestinations}>
              {searching ? "Mencari wilayah…" : "Cari wilayah"}
            </button>
            <p id="destination-status" role="status" aria-live="polite">{searching ? "Mencari wilayah…" : searchMessage}</p>
            <label htmlFor="destination">Wilayah tujuan pengiriman</label>
            <select id="destination" required disabled={busy || searching || !destinations.length} value={address.destination} onChange={(e) => {
              const selected = destinations.find((d) => d.id === e.target.value);
              setAddress({ ...address, destination: selected?.id || "" });
              invalidateQuotes();
            }}>
              <option value="">Pilih wilayah sesuai alamat</option>
              {destinations.map((d) => <option key={d.id} value={d.id}>{d.label} — {d.postalCode}</option>)}
            </select>
            {selectedDestination && <p className="muted" aria-live="polite">Tujuan: {selectedDestination.label} · {selectedDestination.postalCode}</p>}
            <button
              type="button"
              disabled={busy || invalid || !address.destination}
              onClick={shipping}
            >
              {busy ? "Memproses…" : "Periksa ongkir"}
            </button>
          </div>
        </div>
        <aside>
          <div className="panel">
            <h2>Ringkasan</h2>
            <div className="notice">
              <strong>
                {preorders.length
                  ? "Satu pengiriman, mengikuti pre-order."
                  : "Seluruh item ready stock."}
              </strong>
              <br />
              {preorders.length ? (
                campaignMissing ? (
                  "Estimasi belum tersedia; item ini belum dapat dibayar."
                ) : (
                  <>
                    Estimasi kirim paling lambat: {date(latest)}.{" "}
                    {preorders.map((l) => (
                      <div key={l.variantId}>
                        {l.product?.name}: {date(l.variant!.campaign!.shipFrom)}{" "}
                        – {date(l.variant!.campaign!.shipTo)}
                      </div>
                    ))}
                  </>
                )
              ) : (
                "Waktu pengiriman mengikuti proses persiapan dan layanan yang dipilih."
              )}
              <br />
              Estimasi bukan jaminan tanggal. Split shipment tidak tersedia.
            </div>
            <label htmlFor="shipping">Layanan pengiriman</label>
            <select
              id="shipping"
              required
              disabled={busy || !quotes.length}
              value={quoteId}
              onChange={(e) => {
                setQuoteId(e.target.value);
                setAccepted(false);
              }}
            >
              <option value="">Pilih layanan</option>
              {quotes.map((q) => (
                <option value={q.id} key={q.id}>
                  {q.service} — {money(q.amount)}
                </option>
              ))}
            </select>
            <div className="line row">
              <span>Subtotal</span>
              <span>{money(subtotal)}</span>
            </div>
            <div className="line row">
              <span>Ongkir</span>
              <span>{quote ? money(quote.amount) : "Belum dipilih"}</span>
            </div>
            <div className="line row">
              <strong>Total</strong>
              <strong>{money(subtotal + (quote?.amount || 0))}</strong>
            </div>
            <label>
              <input
                type="checkbox"
                required
                disabled={busy}
                checked={accepted}
                onChange={(e) => setAccepted(e.target.checked)}
              />{" "}
              Saya menyetujui total dan estimasi satu pengiriman di atas.
            </label>
            {config.turnstileSiteKey ? (
              <Turnstile
                siteKey={config.turnstileSiteKey}
                onToken={setToken}
                reset={reset}
              />
            ) : (
              <p role="alert">
                Verifikasi checkout belum tersedia. Pembayaran tidak dapat
                dilanjutkan.
              </p>
            )}
            {invalid && (
              <p role="alert">
                Ada varian yang habis atau jumlah melebihi batas per pesanan.
              </p>
            )}
            {error && (
              <div className="notice error" role="alert">
                {error}
              </div>
            )}
            <button
              type="submit"
              disabled={
                busy ||
                invalid ||
                campaignMissing ||
                !quote ||
                !token ||
                !accepted
              }
              style={{ width: "100%", marginTop: 20 }}
            >
              {busy ? "Memproses…" : "Buat pesanan & lanjut pembayaran ↗"}
            </button>
            <p className="muted">
              Harga, stok, dan ongkir diperiksa kembali oleh server.
            </p>
          </div>
        </aside>
      </div>
    </form>
  );
}
