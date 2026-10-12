import { useState } from "react";
import { type Product, money, date } from "../lib/catalog";
import { readCart, writeCart } from "../lib/cart";
export default function ProductPicker({ product }: { product: Product }) {
  const [id, setId] = useState(product.variants[0]?.id);
  const [quantity, setQuantity] = useState(1);
  const [message, setMessage] = useState("");
  const v = product.variants.find((v) => v.id === id);
  if (!v) return <p>Varian belum tersedia.</p>;
  const unavailable = v.available !== null && v.available < quantity;
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
              </>
            ) : (
              "Estimasi belum tersedia; checkout akan memvalidasi campaign."
            )}
          </>
        ) : (
          "Ready stock · Ketersediaan diperiksa kembali saat checkout."
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
        max={v.available ?? 99}
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
            else cart.push({ variantId: v.id, quantity });
            writeCart(cart);
            setMessage("Ditambahkan ke tas belanja.");
          } catch {
            setMessage(
              "Penyimpanan browser tidak tersedia. Izinkan penyimpanan untuk menggunakan tas belanja.",
            );
          }
        }}
      >
        {unavailable ? "Tidak tersedia" : "Tambah ke tas ↗"}
      </button>
      <p role="status">
        {message}{" "}
        {message.startsWith("Ditambahkan") && <a href="/cart">Lihat tas →</a>}
      </p>
    </>
  );
}
