import { useEffect, useRef, useState } from "react";
import { api, confirmationText, definiteRefusal, downloadText, google, readCart, syncCartCount, writeCart, type ApiError, type CartItem } from "../lib/cart";
import { money, date } from "../lib/catalog";
import Turnstile from "./Turnstile";
import RequiredMark from "./RequiredMark";
import { labels, paymentLabels } from "../lib/labels";
import { normalizePhone } from "../../../../src/shared";
type Destination = { id: string; label: string; city?: string; postalCode: string };
type Quote = { id: string; service: string; amount: number; expiresAt: string | number };
type Campaign = { shipFrom: string; shipTo: string; endsAt: number } | null;
type Line =
  | { variantId: string; quantity: number; available: false }
  | { variantId: string; quantity: number; available: true; sku: string; name: string; productName: string; productSlug: string; price: number; lineTotal: number;
      mode: "stock" | "preorder"; stockLevel: "in_stock" | "low" | "out"; enough: boolean; maxPerOrder: number | null; campaign: Campaign };
type Preview = { lines: Line[]; subtotal: number; shipPromise: { shipFrom: string | null; shipTo: string | null }; problems: { variantId: string | null; message: string }[] };
type SavedAddress = { id: string; label: string; name: string; phone: string; line: string; destination: string; destinationLabel: string; city: string; postalCode: string };
type Payload = { items: CartItem[]; shippingQuoteId: string; contact: { name: string; email: string; phone: string }; address: { line: string; destination: string }; expectedTotal: number };
const expiry = (q: Quote) => new Date(q.expiresAt).getTime();

export default function Checkout() {
  const [items, setItems] = useState<CartItem[]>([]);
  const [view, setView] = useState<Preview | null>(null);
  const [config, setConfig] = useState<{ turnstileSiteKey?: string | null; turnstile?: boolean; googleEnabled?: boolean; payments?: boolean; shipping?: boolean }>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quotes, setQuotes] = useState<Quote[]>([]);
  const [quoteId, setQuoteId] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [search, setSearch] = useState("");
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchMessage, setSearchMessage] = useState("");
  const [token, setToken] = useState("");
  const [reset, setReset] = useState(0);
  const [accepted, setAccepted] = useState(false);
  const [contact, setContact] = useState({ name: "", email: "", phone: "" });
  // City and postal code come from the server-side destination record, never from this form.
  const [address, setAddress] = useState({ line: "", destination: "" });
  const [result, setResult] = useState<any>();
  // Authoritative total from a 409 price change; the shopper must re-confirm before it is sent.
  const [confirmedTotal, setConfirmedTotal] = useState<number | null>(null);
  const [priceChange, setPriceChange] = useState<{ from: number; to: number } | null>(null);
  const [ambiguous, setAmbiguous] = useState(false);
  const [saved, setSaved] = useState<SavedAddress[] | null>(null);
  const [addressLabel, setAddressLabel] = useState("Rumah");
  const [addressStatus, setAddressStatus] = useState("");
  const [phoneError, setPhoneError] = useState("");
  const phoneRef = useRef<HTMLInputElement>(null);
  const searchVersion = useRef(0), quoteVersion = useRef(0), previewVersion = useRef(0);
  const key = useRef("");
  // After an ambiguous failure the exact payload is resent with the same key, so the server returns the
  // order it may already have created instead of making a second one.
  const frozen = useRef<Payload | null>(null);
  const locked = useRef(false);

  async function refresh(next: CartItem[]) {
    const version = ++previewVersion.current;
    if (!next.length) { setView(null); return; }
    try {
      const data = await api("/api/cart/preview", { items: next });
      if (version === previewVersion.current) setView(data);
    } catch (e) {
      if (version === previewVersion.current) { setView(null); setError((e as Error).message || "Harga terbaru belum dapat diperiksa."); }
    }
  }
  useEffect(() => {
    const cart = readCart();
    setItems(cart);
    Promise.all([
      refresh(cart),
      api("/api/config").then(setConfig),
      // 401 means a guest; the address book is simply not offered.
      api("/api/account/addresses").then((data) => setSaved(data.addresses), () => setSaved(null)),
    ]).catch((e) => setError(e.message)).finally(() => setLoading(false));
    syncCartCount(cart);
    const timer = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(timer);
  }, []);

  const lines = view?.lines ?? [];
  const subtotal = view?.subtotal ?? 0;
  const liveQuotes = quotes.filter((q) => expiry(q) > now);
  const quote = liveQuotes.find((q) => q.id === quoteId);
  const quoteExpired = !!quoteId && !quote;
  const total = quote ? confirmedTotal ?? subtotal + quote.amount : null;
  const selectedDestination = destinations.find((d) => d.id === address.destination);
  const invalid = !view || view.problems.length > 0;
  const preorders = lines.filter((l): l is Extract<Line, { available: true }> => l.available && l.mode === "preorder");
  const promise = view?.shipPromise;
  const frozenInputs = busy || ambiguous;
  // Older servers omit the flags; only an explicit false disables checkout or the widget.
  const unavailable = config.payments === false || config.shipping === false;
  const needsToken = config.turnstile !== false;

  function invalidateQuotes() {
    quoteVersion.current++;
    setQuotes([]);
    setQuoteId("");
    setAccepted(false);
    setConfirmedTotal(null);
    setPriceChange(null);
  }
  function changeCart(next: CartItem[]) {
    try {
      writeCart(next);
      setItems(next);
      invalidateQuotes();
      void refresh(next);
    } catch {
      setError("Tas tidak dapat disimpan di browser.");
    }
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
    setConfirmedTotal(null);
    setPriceChange(null);
    try {
      const data = await api("/api/shipping/quote", { destination: address.destination, items });
      if (version !== quoteVersion.current) return;
      setNow(Date.now());
      setQuotes(data.quotes);
      if (!data.quotes.length) setError("Tidak ada layanan tersedia untuk tujuan ini.");
    } catch (e) {
      if (version === quoteVersion.current) setError((e as Error).message);
    } finally {
      if (version === quoteVersion.current) setBusy(false);
    }
  }
  function applySaved(id: string) {
    const entry = saved?.find((a) => a.id === id);
    if (!entry) return;
    setContact((c) => ({ ...c, name: entry.name, phone: entry.phone }));
    setDestinations([{ id: entry.destination, label: entry.destinationLabel, city: entry.city, postalCode: entry.postalCode }]);
    setSearchMessage("");
    if (entry.destination !== address.destination) invalidateQuotes();
    setAddress({ line: entry.line, destination: entry.destination });
  }
  async function saveAddress() {
    setAddressStatus("");
    try {
      const data = await api("/api/account/addresses", { label: addressLabel, name: contact.name, phone: contact.phone, line: address.line, destination: address.destination });
      setSaved((list) => [...(list ?? []), data.address]);
      setAddressStatus("Alamat disimpan ke buku alamat.");
    } catch (e) {
      setAddressStatus((e as Error).message);
    }
  }
  async function checkout(e: React.FormEvent) {
    e.preventDefault();
    if (locked.current) return;
    let payload = frozen.current;
    if (!payload) {
      if (!address.destination || !quote || total === null) {
        setError("Ongkir kedaluwarsa. Periksa ongkir kembali.");
        return;
      }
      if (!normalizePhone(contact.phone)) {
        setPhoneError("Nomor HP tidak valid. Gunakan nomor seluler Indonesia, misalnya 0812… atau +62812….");
        phoneRef.current?.focus();
        return;
      }
      payload = { items, shippingQuoteId: quote.id, contact, address, expectedTotal: total };
    }
    if (!key.current) key.current = crypto.randomUUID();
    locked.current = true;
    setBusy(true);
    setError("");
    try {
      const data = await api("/api/checkout", { ...payload, idempotencyKey: key.current, turnstileToken: token });
      key.current = "";
      frozen.current = null;
      setAmbiguous(false);
      setResult(data);
      if (data.order?.guestToken) {
        try {
          sessionStorage.setItem("flaremmerce-order-access", JSON.stringify({ reference: data.order.reference, token: data.order.guestToken }));
        } catch {
          /* Token remains visible in confirmation even without browser storage. */
        }
      }
      try {
        writeCart([]);
      } catch {
        /* Confirmed order must remain visible. */
      }
    } catch (err) {
      const failure = err as ApiError;
      if (definiteRefusal(failure)) {
        // The server refused without creating an order: the next attempt is a new request with a new key.
        key.current = "";
        frozen.current = null;
        setAmbiguous(false);
        if (failure.status === 409 && typeof failure.details?.total === "number") {
          setPriceChange({ from: payload.expectedTotal, to: failure.details.total });
          setConfirmedTotal(failure.details.total);
          setAccepted(false);
          void refresh(payload.items);
        } else setError(failure.message);
      } else {
        frozen.current = payload;
        setAmbiguous(true);
        setError(`${failure.message || "Koneksi terputus."} Hasil pesanan belum pasti. Jangan membuat pembayaran baru secara terpisah.`);
      }
    } finally {
      setToken("");
      setReset((r) => r + 1);
      locked.current = false;
      setBusy(false);
    }
  }

  if (loading) return <p role="status">Menyiapkan keranjang…</p>;
  if (result) {
    const shipment = result.order.shipPromise;
    return (
      <div className="panel confirmation">
        <span className="badge">Order tercatat · bukan bukti terbayar</span>
        <h2>Referensi {result.order.reference}</h2>
        <p>
          Status: {labels[result.order.status] || result.order.status} · Pembayaran:{" "}
          {paymentLabels[result.paymentState] || result.paymentState || "Belum terkonfirmasi"}
        </p>
        <p className="price">{money(result.order.total)}</p>
        <div className="notice" aria-label="Janji pengiriman">
          {shipment?.shipTo
            ? <>Satu pengiriman mengikuti item pre-order paling lambat. Estimasi kirim {date(shipment.shipFrom)} – {date(shipment.shipTo)} (bukan jaminan tanggal).</>
            : "Ready stock: dikirim setelah pembayaran terkonfirmasi dan pesanan disiapkan."}
        </div>
        <div className="notice">
          Pembayaran hanya berhasil setelah konfirmasi server. Jika status belum diketahui, jangan membayar ulang secara terpisah.
        </div>
        {result.order.guestToken && (
          <div className="token-box">
            <label htmlFor="guest-token">Simpan token akses ini secara privat</label>
            <input id="guest-token" readOnly value={result.order.guestToken} aria-describedby="guest-token-help" />
            <p id="guest-token-help" className="field-hint">Token diperlukan untuk melihat pesanan. Tidak ada pemulihan token atau email otomatis yang dijanjikan.</p>
            <button type="button" className="secondary" onClick={() => downloadText(`pesanan-${result.order.reference}.txt`, confirmationText(result.order.reference, result.order.guestToken, location.origin))}>
              Simpan konfirmasi
            </button>
          </div>
        )}
        <div className="actions">
          {result.paymentUrl && /^https:\/\//.test(result.paymentUrl) && (
            <a className="button" href={result.paymentUrl} rel="noreferrer">Lanjut ke penyedia pembayaran ↗</a>
          )}
          <a className="button secondary" href="/order">Lihat status pesanan</a>
        </div>
      </div>
    );
  }
  if (!items.length)
    return (
      <div className="empty-state">
        {error && <p role="alert" className="notice error">{error}</p>}
        <svg viewBox="0 0 48 48" aria-hidden="true"><path d="M10 14h28l2 26H8l2-26Z M18 16v-4a6 6 0 0 1 12 0v4" /></svg>
        <h2>Keranjang masih kosong</h2>
        <p>Ada ruang untuk favorit barumu.</p>
        <a className="button" href="/catalog">Lihat katalog</a>
      </div>
    );
  const contactDone = !!(contact.name && contact.email && contact.phone);
  const addressDone = !!(address.line && address.destination);
  const steps = (n: number, title: string, done: boolean, id: string) => (
    <h2 id={id} className="step-title">
      <span className="step-number" aria-hidden="true">{n}</span>
      <span>{title}</span>
      {done && <span className="step-done">Lengkap</span>}
    </h2>
  );
  return (
    <form onSubmit={checkout} className="checkout-form">
      {unavailable && (
        <div className="notice error" role="alert">
          <strong>Checkout belum tersedia di lingkungan ini.</strong> {config.payments === false && config.shipping === false ? "Pembayaran dan ongkir" : config.payments === false ? "Pembayaran" : "Ongkir"} belum dikonfigurasi; keranjang tetap tersimpan.
        </div>
      )}
      <div className="checkout">
        <div className="checkout-main">
          <section className="panel" aria-labelledby="cart-heading">
            <h2 id="cart-heading">Isi keranjang</h2>
            {!view && <p role="alert">Harga dan stok terbaru belum dapat diperiksa. Muat ulang halaman.</p>}
            {lines.map((l) => (
              <div className="line" key={l.variantId}>
                <div className="row">
                  <div>
                    <strong>{l.available ? l.productName : "Produk tidak tersedia"}</strong>
                    {l.available && (
                      <p className="muted">
                        {l.name} · {l.sku} · {l.mode === "preorder" ? "Pre-order" : "Ready stock"}
                        {l.stockLevel === "low" && l.enough && " · Stok terbatas"}
                        {l.campaign && <> · Estimasi kirim {date(l.campaign.shipFrom)} – {date(l.campaign.shipTo)}</>}
                      </p>
                    )}
                    {view?.problems.filter((p) => p.variantId === l.variantId).map((p) => <p key={p.message} className="muted error-text" role="alert">{p.message}</p>)}
                  </div>
                  <span className="line-total">{l.available ? money(l.lineTotal) : "—"}</span>
                </div>
                <div className="row line-controls">
                  <input
                    aria-label={"Jumlah " + (l.available ? l.productName : l.variantId)}
                    type="number"
                    min="1"
                    max={(l.available && l.maxPerOrder) || 99}
                    value={l.quantity}
                    disabled={frozenInputs}
                    onChange={(e) => changeCart(items.map((i) => i.variantId === l.variantId ? { ...i, quantity: Math.max(1, Math.min(100, Math.floor(Number(e.target.value) || 1))) } : i))}
                  />
                  {l.available && l.maxPerOrder != null && <span className="field-hint">Maks. {l.maxPerOrder} per pesanan</span>}
                  <button type="button" disabled={frozenInputs} onClick={() => changeCart(items.filter((i) => i.variantId !== l.variantId))}>Hapus</button>
                </div>
              </div>
            ))}
            {view?.problems.filter((p) => p.variantId === null).map((p) => <p key={p.message} role="alert">{p.message}</p>)}
          </section>
          <section className="panel step" aria-labelledby="step-contact">
            {steps(1, "Kontak", contactDone, "step-contact")}
            {saved === null ? (
              <div className="step-intro">
                <p>Checkout tamu. Akun tidak diperlukan.</p>
                {config.googleEnabled && (
                  <button type="button" className="secondary" onClick={() => google(location.origin + "/cart").catch((e) => setError(e.message))}>
                    Opsional: lanjut dengan Google
                  </button>
                )}
              </div>
            ) : (
              <p className="step-intro">Masuk dengan akun. Alamat tersimpan dapat dipilih di langkah berikutnya.</p>
            )}
            <div className="field-grid">
              {(["name", "email", "phone"] as const).map((f, index) => (
                <div key={f} className={f === "name" ? "field wide" : "field"}>
                  <label htmlFor={f}>{["Nama penerima", "Email", "Nomor HP"][index]}<RequiredMark /></label>
                  <input
                    id={f}
                    ref={f === "phone" ? phoneRef : undefined}
                    required
                    disabled={frozenInputs}
                    type={f === "email" ? "email" : f === "phone" ? "tel" : "text"}
                    autoComplete={f === "name" ? "name" : f === "email" ? "email" : "tel"}
                    inputMode={f === "phone" ? "tel" : undefined}
                    aria-describedby={f === "phone" ? (phoneError ? "phone-help phone-error" : "phone-help") : f === "email" ? "email-help" : undefined}
                    aria-invalid={f === "phone" && phoneError ? true : undefined}
                    value={contact[f]}
                    onChange={(e) => {
                      if (f === "phone") setPhoneError("");
                      setContact({ ...contact, [f]: e.target.value });
                    }}
                  />
                  {f === "email" && <p id="email-help" className="field-hint">Untuk informasi pesanan; tidak dipakai untuk promosi.</p>}
                  {f === "phone" && <p id="phone-help" className="field-hint">Nomor seluler Indonesia, misalnya 0812… atau +62812….</p>}
                  {f === "phone" && phoneError && <p id="phone-error" className="field-error" role="alert">{phoneError}</p>}
                </div>
              ))}
            </div>
          </section>
          <section className="panel step" aria-labelledby="step-address">
            {steps(2, "Alamat", addressDone, "step-address")}
            {saved !== null && saved.length > 0 && (
              <>
                <label htmlFor="saved-address">Alamat tersimpan</label>
                <select id="saved-address" disabled={frozenInputs} defaultValue="" onChange={(e) => applySaved(e.target.value)}>
                  <option value="">Pilih dari buku alamat</option>
                  {saved.map((a) => <option key={a.id} value={a.id}>{a.label} — {a.line}, {a.destinationLabel}</option>)}
                </select>
              </>
            )}
            <label htmlFor="line">Alamat lengkap (jalan, nomor, RT/RW)<RequiredMark /></label>
            {/* The street line is not part of the shipping tariff; editing it keeps the selected quote. */}
            <input id="line" required disabled={frozenInputs} autoComplete="street-address" value={address.line} onChange={(e) => setAddress({ ...address, line: e.target.value })} />
            <label htmlFor="destination-search">Cari wilayah pengiriman</label>
            <div className="inline-search">
              <input
                id="destination-search"
                value={search}
                disabled={frozenInputs}
                maxLength={100}
                aria-describedby="destination-help destination-status"
                onKeyDown={(e) => {
                  if (e.key === "Enter") { e.preventDefault(); if (!unavailable && search.trim().length >= 3) void searchDestinations(); }
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
              <button type="button" className="secondary" disabled={frozenInputs || unavailable || searching || search.trim().length < 3} onClick={searchDestinations}>
                {searching ? "Mencari wilayah…" : "Cari wilayah"}
              </button>
            </div>
            <p id="destination-help" className="field-hint">Masukkan nama kota, kecamatan, kelurahan, atau kode pos (minimal 3 karakter), lalu cari dan pilih wilayah yang sesuai alamat.</p>
            <p id="destination-status" className="field-hint" role="status" aria-live="polite">{searching ? "Mencari wilayah…" : searchMessage}</p>
            <label htmlFor="destination">Wilayah tujuan pengiriman<RequiredMark /></label>
            <select id="destination" required disabled={frozenInputs || searching || !destinations.length} value={address.destination} onChange={(e) => {
              const selected = destinations.find((d) => d.id === e.target.value);
              setAddress({ ...address, destination: selected?.id || "" });
              invalidateQuotes();
            }}>
              <option value="">Pilih wilayah sesuai alamat</option>
              {destinations.map((d) => <option key={d.id} value={d.id}>{d.label} — {d.postalCode}</option>)}
            </select>
            {selectedDestination && <p className="muted" aria-live="polite">Tujuan: {selectedDestination.label} · {selectedDestination.postalCode}</p>}
            {saved !== null && saved.length < 5 && (
              <div className="saved-address">
                <label htmlFor="address-label">Label alamat</label>
                <div className="inline-search">
                  <input id="address-label" maxLength={50} value={addressLabel} onChange={(e) => setAddressLabel(e.target.value)} />
                  <button type="button" className="secondary" disabled={busy || !addressLabel.trim() || !contact.name || !contact.phone || !address.line || !address.destination} onClick={saveAddress}>
                    Simpan ke buku alamat
                  </button>
                </div>
                {addressStatus && <p role="status">{addressStatus}</p>}
              </div>
            )}
          </section>
          <section className="panel step" aria-labelledby="step-shipping">
            {steps(3, "Pengiriman", !!quote, "step-shipping")}
            <p className="step-intro" id="shipping-help">
              {address.destination ? "Periksa ongkir untuk wilayah tujuan, lalu pilih layanan." : "Pilih wilayah tujuan di langkah 2 untuk menghitung ongkir."}
            </p>
            <button type="button" disabled={frozenInputs || unavailable || invalid || !address.destination} onClick={shipping}>
              {busy ? "Memproses…" : "Periksa ongkir"}
            </button>
            <label htmlFor="shipping">Layanan pengiriman<RequiredMark /></label>
            <select id="shipping" required aria-describedby="shipping-help" disabled={frozenInputs || !liveQuotes.length} value={quote ? quoteId : ""} onChange={(e) => {
              setQuoteId(e.target.value);
              setAccepted(false);
              setConfirmedTotal(null);
              setPriceChange(null);
            }}>
              <option value="">Pilih layanan</option>
              {liveQuotes.map((q) => <option value={q.id} key={q.id}>{q.service} — {money(q.amount)}</option>)}
            </select>
            {quoteExpired && !ambiguous && <p role="alert" className="field-error">Ongkir kedaluwarsa. Periksa ongkir kembali untuk tarif terbaru.</p>}
            <div className="notice">
              <strong>{preorders.length ? "Satu pengiriman, mengikuti pre-order." : "Seluruh item ready stock."}</strong>
              <br />
              {preorders.length && promise?.shipTo ? (
                <>
                  Estimasi kirim paling lambat: {date(promise.shipFrom!)} – {date(promise.shipTo)}.
                  {preorders.map((l) => <div key={l.variantId}>{l.productName}: {date(l.campaign!.shipFrom)} – {date(l.campaign!.shipTo)}</div>)}
                </>
              ) : preorders.length ? "Estimasi belum tersedia; item ini belum dapat dibayar." : "Waktu pengiriman mengikuti proses persiapan dan layanan yang dipilih."}
              <br />
              Estimasi bukan jaminan tanggal. Split shipment tidak tersedia.
            </div>
          </section>
        </div>
        <aside className="checkout-summary" aria-labelledby="step-summary">
          <div className="panel step">
            {steps(4, "Ringkasan & Pembayaran", false, "step-summary")}
            <ul className="summary-items" role="list">
              {lines.map((l) => (
                <li key={l.variantId}>
                  <span>{l.available ? `${l.productName} — ${l.name}` : "Produk tidak tersedia"} × {l.quantity}</span>
                  <span>{l.available ? money(l.lineTotal) : "—"}</span>
                </li>
              ))}
            </ul>
            <div className="line row"><span>Subtotal</span><span>{money(subtotal)}</span></div>
            <div className="line row"><span>Ongkir</span><span>{quote ? money(quote.amount) : "Belum dipilih"}</span></div>
            <div className="line row summary-total">
              <strong>Total</strong>
              <strong>{total === null ? "Pilih ongkir" : money(total)}</strong>
            </div>
            {priceChange && (
              <div className="notice" role="alert">
                Total berubah dari {money(priceChange.from)} menjadi {money(priceChange.to)}. Periksa kembali, lalu centang persetujuan untuk melanjutkan.
              </div>
            )}
            <label className="consent">
              <input type="checkbox" required disabled={busy} checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />{" "}
              <span>Saya menyetujui total dan estimasi satu pengiriman di atas.<RequiredMark /></span>
            </label>
            {!needsToken ? null : config.turnstileSiteKey ? (
              <Turnstile siteKey={config.turnstileSiteKey} onToken={setToken} reset={reset} />
            ) : (
              <p role="alert">Verifikasi checkout belum tersedia. Pembayaran tidak dapat dilanjutkan.</p>
            )}
            {error && <div className="notice error" role="alert">{error}</div>}
            {ambiguous && (
              <div className="notice" role="status">
                Data pesanan dikunci agar tidak membuat pesanan ganda. Kirim ulang memakai kunci pesanan yang sama.{" "}
                <a href="/order">Periksa status pesanan</a>
              </div>
            )}
            <button
              type="submit"
              className="cta"
              disabled={busy || unavailable || (needsToken && !token) || !accepted || (!ambiguous && (invalid || !quote))}
            >
              {busy ? "Memproses…" : ambiguous ? "Kirim ulang pesanan yang sama" : "Buat pesanan & lanjut pembayaran ↗"}
            </button>
            <p className="muted">Harga, stok, dan ongkir diperiksa kembali oleh server.</p>
          </div>
        </aside>
      </div>
    </form>
  );
}
