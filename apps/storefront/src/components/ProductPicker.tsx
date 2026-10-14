import { useState } from "react";
import { type Product, money, date } from "../lib/catalog";
import { MAX_CART_LINES, readCart, writeCart } from "../lib/cart";
export default function ProductPicker({ product }: { product: Product }) {
  const [id, setId] = useState(product.variants[0]?.id);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState("");
  const v = product.variants.find((v) => v.id === id);
  if (!v) return <p>Varian belum tersedia.</p>;
  const unavailable = v.stockLevel === "out" || (v.maxPerOrder != null && quantity > v.maxPerOrder);
  const stockNote = v.stockLevel === "out" ? " Habis." : v.stockLevel === "low" ? " Stok terbatas." : "";
  return (
    <>
      <p className="price">{money(v.price)}</p>
      {product.variants.length > 1 && (
        <>
          <label>Varian</label>
          <div className="choices">
            {product.variants.map((x) => (
              <button
                key={x.id}
                aria-pressed={id === x.id}
                onClick={() => {
                  setId(x.id);
                  setMessage("");
                }}
              >
                {x.name}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="notice">
        {v.mode === "preorder" ? (
          <>
            Pre-order ·{" "}
            {v.campaign ? (
              <>
                Estimasi kirim {date(v.campaign.shipFrom)} –{" "}
                {date(v.campaign.shipTo)}. Pemesanan sampai{" "}
                {date(v.campaign.endsAt)}.
                {stockNote}
              </>
            ) : (
              "Estimasi belum tersedia; checkout akan memvalidasi campaign."
            )}
          </>
        ) : (
          `Ready stock ·${stockNote} Ketersediaan diperiksa kembali saat checkout.`
        )}
        <br />
        Satu pengiriman mengikuti item paling lambat jika digabung dengan
        pre-order.
      </div>
      <label htmlFor="quantity">Jumlah</label>
      <input
        id="quantity"
        type="number"
        min="1"
        max={v.maxPerOrder ?? 99}
        value={quantity}
        onChange={(e) =>
          setQuantity(Math.max(1, Math.floor(Number(e.target.value) || 1)))
        }
        style={{ maxWidth: 100, marginBottom: 20 }}
      />
      <br />
      <button
        disabled={unavailable}
        onClick={() => {
          try {
            const cart = readCart();
            const existing = cart.find((i) => i.variantId === id);
            if (existing) existing.quantity += quantity;
            else if (cart.length >= MAX_CART_LINES) {
              setMessage(`Tas belanja maksimal ${MAX_CART_LINES} varian berbeda.`);
              return;
            } else cart.push({ variantId: v.id, quantity });
            writeCart(cart);
            setMessage("Ditambahkan ke tas belanja.");
          } catch {
            setMessage(
              "Penyimpanan browser tidak tersedia. Izinkan penyimpanan untuk menggunakan tas belanja.",
            );
          }
        }}
      >
        {v.stockLevel === "out" ? "Habis" : unavailable ? "Melebihi batas per pesanan" : "Tambah ke tas ↗"}
      </button>
      <p role="status">
        {message}{" "}
        {message.startsWith("Ditambahkan") && <a href="/cart">Lihat tas →</a>}
      </p>
    </>
  );
}
