import { useEffect, useState } from "react";
import { type Product, type Variant, money, date } from "../lib/catalog";
import { MAX_CART_LINES, MAX_LINE_QUANTITY, readCart, syncCartCount, writeCart } from "../lib/cart";

const stockText = (v: Variant) =>
  v.stockLevel === "out" ? "Habis" : v.stockLevel === "low" ? "Stok terbatas" : v.mode === "preorder" ? "Kuota tersedia" : "Ready stock";

export default function ProductPicker({ product }: { product: Product }) {
  const [id, setId] = useState(product.variants[0]?.id);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState("");
  useEffect(() => syncCartCount(), []);
  const v = product.variants.find((v) => v.id === id);
  if (!v) return <p className="notice">Varian belum tersedia.</p>;
  const max = Math.min(v.maxPerOrder ?? MAX_LINE_QUANTITY, MAX_LINE_QUANTITY);
  // Switching to a variant with a lower limit keeps the typed number within that limit.
  const units = Math.min(quantity, max);
  const unavailable = v.stockLevel === "out";
  const tone = v.stockLevel === "out" ? "out" : v.stockLevel === "low" ? "low" : v.mode === "preorder" ? "preorder" : "stock";
  return (
    <div className="picker">
      <p className="price" aria-live="polite">
        {money(v.price)}
        {product.variants.length > 1 && <span className="muted"> · {v.name}</span>}
      </p>
      <div className="picker-badges">
        {v.mode === "preorder" && <span className="badge preorder">Pre-order</span>}
        <span className={`badge ${tone}`}>{stockText(v)}</span>
      </div>
      {product.variants.length > 1 && (
        <fieldset className="variant-field">
          <legend>Pilih varian</legend>
          <div className="choices">
            {product.variants.map((x) => (
              <button
                type="button"
                key={x.id}
                aria-pressed={id === x.id}
                className={x.stockLevel === "out" ? "is-out" : undefined}
                onClick={() => {
                  setId(x.id);
                  setMessage("");
                }}
              >
                <span>{x.name}</span>
                <small>{x.stockLevel === "out" ? "Habis" : money(x.price)}</small>
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <div className="notice availability-note">
        {v.mode === "preorder" ? (
          v.campaign ? (
            <>
              <strong>Pre-order · estimasi kirim {date(v.campaign.shipFrom)} – {date(v.campaign.shipTo)}</strong>
              <br />
              Pemesanan dibuka sampai {date(v.campaign.endsAt)}.
            </>
          ) : (
            <strong>Pre-order · estimasi belum tersedia; checkout akan memvalidasi campaign.</strong>
          )
        ) : (
          <strong>{v.stockLevel === "out" ? "Stok habis untuk varian ini." : "Ready stock · dikirim setelah pembayaran terkonfirmasi."}</strong>
        )}
        <br />
        Ketersediaan diperiksa kembali saat checkout. Jika digabung dengan pre-order, satu pengiriman mengikuti item paling lambat.
      </div>
      <label htmlFor="quantity">Jumlah</label>
      <div className="quantity-row">
        <input
          id="quantity"
          type="number"
          min="1"
          max={max}
          value={units}
          aria-describedby="quantity-help"
          onChange={(e) => setQuantity(Math.min(max, Math.max(1, Math.floor(Number(e.target.value) || 1))))}
        />
        <button
          className="cta"
          disabled={unavailable}
          onClick={() => {
            try {
              const cart = readCart();
              const existing = cart.find((i) => i.variantId === id);
              if (existing) {
                // Over 100 units the cart preview refuses the whole cart; over the per-order limit checkout refuses it.
                if (existing.quantity >= max) {
                  setMessage(`Keranjang sudah berisi ${max} unit, jumlah maksimal untuk varian ini.`);
                  return;
                }
                const added = Math.min(units, max - existing.quantity);
                existing.quantity += added;
                if (added < units) {
                  writeCart(cart);
                  setMessage(`Ditambahkan ${added} unit; keranjang kini berisi jumlah maksimal ${max}.`);
                  return;
                }
              } else if (cart.length >= MAX_CART_LINES) {
                setMessage(`Keranjang maksimal ${MAX_CART_LINES} varian berbeda.`);
                return;
              } else cart.push({ variantId: v.id, quantity: units });
              writeCart(cart);
              setMessage("Ditambahkan ke keranjang.");
            } catch {
              setMessage("Penyimpanan browser tidak tersedia. Izinkan penyimpanan untuk menggunakan keranjang.");
            }
          }}
        >
          {v.stockLevel === "out" ? "Habis" : "Tambah ke keranjang"}
        </button>
      </div>
      <p id="quantity-help" className="field-hint">
        {v.maxPerOrder != null ? `Maksimal ${v.maxPerOrder} per pesanan.` : "Jumlah akhir diperiksa saat checkout."}
      </p>
      <p role="status" className="picker-status">
        {message}{" "}
        {message.startsWith("Ditambahkan") && <a href="/cart">Lihat keranjang →</a>}
      </p>
    </div>
  );
}
