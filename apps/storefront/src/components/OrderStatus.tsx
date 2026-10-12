import { useEffect, useState } from "react";
import { api } from "../lib/cart";
import { money, date } from "../lib/catalog";
const labels: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Pembayaran terkonfirmasi",
  completed: "Pesanan selesai",
  cancelled: "Dibatalkan",
  processing: "Sedang dipersiapkan",
  shipped: "Sudah dikirim",
  delivered: "Sudah diterima",
  unfulfilled: "Belum diproses",
};
export default function OrderStatus() {
  const [reference, setReference] = useState("");
  const [token, setToken] = useState("");
  const [data, setData] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    try {
      const saved = JSON.parse(
        sessionStorage.getItem("flaremmerce-order-access") || "null",
      );
      if (saved) {
        setReference(saved.reference);
        setToken(saved.token);
        load(saved.reference, saved.token);
      }
    } catch {
      /* Manual private access remains available. */
    }
  }, []);
  async function load(ref = reference, secret = token) {
    setBusy(true);
    setError("");
    setData(undefined);
    try {
      setData(
        await api("/api/orders/" + encodeURIComponent(ref), undefined, {
          "X-Order-Token": secret,
        }),
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const order = data?.order;
  return (
    <>
      <form
        className="panel"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <label htmlFor="reference">Referensi pesanan</label>
        <input
          id="reference"
          required
          value={reference}
          onChange={(e) => setReference(e.target.value)}
        />
        <label htmlFor="token">Token akses privat</label>
        <input
          id="token"
          type="password"
          required
          value={token}
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="muted">
          Token hanya dikirim melalui header privat. Jangan bagikan token atau
          tangkapan layar yang memuat token.
        </p>
        <button disabled={busy}>
          {busy ? "Memeriksa…" : "Periksa status"}
        </button>
      </form>
      {error && (
        <div role="alert" className="notice error">
          {error}
        </div>
      )}
      {order && (
        <section className="panel">
          <span className="badge">{order.reference}</span>
          <h2 style={{ marginTop: 20 }}>
            {labels[order.status] || order.status}
          </h2>
          <p className="price">{money(order.total)}</p>
          <p>
            Pembayaran:{" "}
            {data.paymentState ||
              order.paymentStatus ||
              "Lihat status order di atas"}
          </p>
          <p>
            Pengiriman:{" "}
            {labels[order.fulfillmentStatus || data.fulfillment?.status] ||
              order.fulfillmentStatus ||
              data.fulfillment?.status ||
              "Belum ada pembaruan"}
          </p>
          {(order.tracking || data.fulfillment?.tracking) && (
            <p>Resi: {order.tracking || data.fulfillment.tracking}</p>
          )}
          {(order.items || data.items)?.map((i: any, n: number) => (
            <div className="line" key={i.id || n}>
              {i.name || i.productName || i.variantName || i.sku} × {i.quantity}
              {i.shipFrom && i.shipTo && (
                <p>
                  Estimasi kirim: {date(i.shipFrom)} – {date(i.shipTo)}
                </p>
              )}
            </div>
          ))}
          <div className="notice">
            Kembali dari penyedia pembayaran tidak berarti pembayaran berhasil.
            Status di atas berasal dari server. Jika hasil belum diketahui,
            jangan membayar ulang secara terpisah.
          </div>
          <button onClick={() => load()} disabled={busy}>
            Perbarui status
          </button>
        </section>
      )}
    </>
  );
}
