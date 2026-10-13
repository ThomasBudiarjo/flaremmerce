import { useEffect, useRef, useState } from "react";
import { api } from "../lib/cart";
import { money, date } from "../lib/catalog";
import OrderHistory from "./OrderHistory";
const labels: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Pembayaran terkonfirmasi",
  completed: "Pesanan selesai",
  cancelled: "Dibatalkan",
  processing: "Sedang dipersiapkan",
  shipped: "Sudah dikirim",
  delivered: "Sudah diterima",
  unfulfilled: "Belum diproses",
  preparing: "Persiapan",
  production: "Produksi",
  ready_to_ship: "Siap kirim",
};
export default function OrderStatus() {
  const [reference, setReference] = useState("");
  const [token, setToken] = useState("");
  const [data, setData] = useState<any>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [opened, setOpened] = useState<{ reference: string; token: string }>();
  const requestSequence = useRef(0);
  const ownerId = useRef<string | null | undefined>(undefined);
  const openedRef = useRef<{ reference: string; token: string } | undefined>(undefined);
  const accessRef = useRef<{ type: string; ownerId?: string } | undefined>(undefined);
  const detailRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (data?.order) {
      detailRef.current?.scrollIntoView({ block: "start" });
      detailRef.current?.focus({ preventScroll: true });
    }
  }, [data]);
  useEffect(() => {
    const returnedReference = new URLSearchParams(location.search).get("reference");
    let saved: { reference: string; token: string } | null = null;
    try {
      saved = JSON.parse(
        sessionStorage.getItem("flaremmerce-order-access") || "null",
      );
    } catch {
      /* Manual private access remains available. */
    }
    const ref = returnedReference || saved?.reference;
    if (ref) {
      const secret = saved?.reference === ref ? saved.token : "";
      setReference(ref);
      setToken(secret);
      void load(ref, secret);
    }
    return () => { ++requestSequence.current; };
  }, []);
  async function load(ref = reference, secret = token) {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError("");
    setData(undefined);
    accessRef.current = undefined;
    openedRef.current = { reference: ref, token: secret };
    setOpened({ reference: ref, token: secret });
    try {
      const result = await api("/api/orders/" + encodeURIComponent(ref), undefined, {
        "X-Order-Token": secret,
      });
      if (sequence !== requestSequence.current) return;
      if (result.access.type === "account" && ownerId.current !== undefined && result.access.ownerId !== ownerId.current) return;
      accessRef.current = result.access;
      setData(result);
    } catch (e) {
      if (sequence === requestSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === requestSequence.current) setBusy(false);
    }
  }
  const order = data?.order;
  return (
    <>
      <OrderHistory labels={labels} onOwnerChange={(owner) => {
        const changed = ownerId.current !== undefined && ownerId.current !== owner;
        ownerId.current = owner;
        const access = accessRef.current;
        if (!changed && !(access?.type === "account" && access.ownerId !== owner)) return;
        ++requestSequence.current;
        if (access?.type === "guest") { setBusy(false); return; }
        const pending = openedRef.current;
        setData(undefined); setError(""); setBusy(false); setOpened(undefined);
        accessRef.current = undefined;
        openedRef.current = undefined;
        if (!access && pending?.token) void load(pending.reference, pending.token);
      }} open={(ref) => {
        setReference(ref);
        setToken("");
        const url = new URL(location.href);
        url.searchParams.set("reference", ref);
        history.replaceState(null, "", url);
        void load(ref, "");
      }} />
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
          value={token}
          autoComplete="off"
          onChange={(e) => setToken(e.target.value)}
        />
        <p className="muted">
          Untuk guest, masukkan token privat. Akun pemilik boleh membaca melalui session Google. Jangan bagikan token atau
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
        <section ref={detailRef} className="panel" aria-label="Detail pesanan" tabIndex={-1}>
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
            {labels[order.fulfillment || order.fulfillmentStatus || data.fulfillment?.status] ||
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
              {i.campaign?.shipFrom && i.campaign?.shipTo && (
                <p>
                  Estimasi kirim: {date(i.campaign.shipFrom)} – {date(i.campaign.shipTo)}
                </p>
              )}
            </div>
          ))}
          {!!order.timeline?.length && <ol aria-label="Timeline pesanan">{order.timeline.map((event:any,n:number) => <li key={n}>{labels[event.kind] || event.kind} · {date(event.createdAt)}{event.details?.tracking && <p>Resi: {event.details.tracking}</p>}{event.details?.note && <p>{event.details.note}</p>}{event.details?.estimatedDate && <p>Estimasi: {date(event.details.estimatedDate)} (bukan jaminan tanggal)</p>}</li>)}</ol>}
          <div className="notice">
            Kembali dari penyedia pembayaran tidak berarti pembayaran berhasil.
            Status di atas berasal dari server. Jika hasil belum diketahui,
            jangan membayar ulang secara terpisah.
          </div>
          <button onClick={() => opened && load(opened.reference, opened.token)} disabled={busy}>
            Perbarui status
          </button>
        </section>
      )}
    </>
  );
}
