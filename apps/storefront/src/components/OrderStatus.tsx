import { useEffect, useRef, useState } from "react";
import { api, confirmationText, downloadText, syncCartCount, type ApiError } from "../lib/cart";
import { labels, paymentLabels } from "../lib/labels";
import { money, date } from "../lib/catalog";
import OrderHistory from "./OrderHistory";
import RequiredMark from "./RequiredMark";
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
    syncCartCount();
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
  const [cancelState, setCancelState] = useState("");
  async function cancel() {
    if (!opened || !confirm("Batalkan pesanan ini? Stok akan dilepas dan pesanan tidak dapat dibayar lagi.")) return;
    setBusy(true);
    setCancelState("");
    try {
      await api("/api/orders/" + encodeURIComponent(opened.reference) + "/cancel", {}, { "X-Order-Token": opened.token });
      setCancelState("Pesanan dibatalkan.");
      await load(opened.reference, opened.token);
    } catch (e) {
      const status = (e as ApiError).status;
      setCancelState(status === 409 ? "Pembayaran sudah tercatat berhasil, jadi pesanan tidak dapat dibatalkan. Status diperbarui."
        : status === 503 ? "Status pembayaran belum dapat dipastikan. Pesanan belum dibatalkan; coba lagi beberapa saat lagi."
        : (e as Error).message);
      setBusy(false);
      if (status === 409) void load(opened.reference, opened.token);
    }
  }
  const order = data?.order;
  const receipt = order && (order.status === "paid" || order.status === "completed");
  const itemsTotal = order?.items?.reduce((sum: number, i: any) => sum + i.price * i.quantity, 0) ?? 0;
  const fulfillment: string = order ? order.fulfillment || order.fulfillmentStatus || data.fulfillment?.status || "" : "";
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
        className="panel no-print"
        onSubmit={(e) => {
          e.preventDefault();
          load();
        }}
      >
        <label htmlFor="reference">Referensi pesanan<RequiredMark /></label>
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
        <div role="alert" className="notice error no-print">
          {error}
        </div>
      )}
      {order && (
        <section ref={detailRef} className="panel" aria-label="Detail pesanan" tabIndex={-1}>
          <div className="order-head">
            <span className="badge">{order.reference}</span>
            <span className="muted">Dibuat {date(order.createdAt)}</span>
          </div>
          <h2>{labels[order.status] || order.status}</h2>
          <OrderStepper status={order.status} fulfillment={fulfillment} />
          <dl className="order-facts">
            <div><dt>Total</dt><dd className="price">{money(order.total)}</dd></div>
            <div><dt>Pembayaran</dt><dd>{paymentLabels[data.paymentState] || data.paymentState || "Lihat status order di atas"}</dd></div>
            <div><dt>Pengiriman</dt><dd>{labels[fulfillment] || fulfillment || "Belum ada pembaruan"}</dd></div>
          </dl>
          {order.tracking && (
            <div className="tracking-card" aria-label="Informasi pengiriman" role="group">
              <span className="muted">Nomor resi{order.tracking.courierName ? ` · ${order.tracking.courierName}` : ""}</span>
              <p>
                Resi {order.tracking.courierName ? `${order.tracking.courierName} ` : ""}<strong>{order.tracking.number}</strong>
              </p>
              {order.tracking.url && /^https:\/\//.test(order.tracking.url) && (
                <p className="muted"><a href={order.tracking.url} target="_blank" rel="noreferrer noopener">Lacak di situs kurir ↗</a> (tempel nomor resi di halaman tersebut)</p>
              )}
            </div>
          )}
          {(order.items || data.items)?.map((i: any, n: number) => (
            <div className="line" key={i.id || n}>
              {i.productName && i.name ? `${i.productName} — ${i.name}` : i.name || i.productName || i.variantName || i.sku} × {i.quantity}
              {i.campaign?.shipFrom && i.campaign?.shipTo && (
                <p>
                  Estimasi kirim: {date(i.campaign.shipFrom)} – {date(i.campaign.shipTo)}
                </p>
              )}
            </div>
          ))}
          {!!order.timeline?.length && <ol className="timeline" aria-label="Timeline pesanan">{order.timeline.map((event:any,n:number) => <li key={n}>{labels[event.kind] || event.kind} · {date(event.createdAt)}{event.details?.tracking && <p>Resi: {event.details.tracking}</p>}{event.details?.note && <p>{event.details.note}</p>}{event.details?.estimatedDate && <p>Estimasi: {date(event.details.estimatedDate)} (bukan jaminan tanggal)</p>}</li>)}</ol>}
          <div className="notice">
            Kembali dari penyedia pembayaran tidak berarti pembayaran berhasil.
            Status di atas berasal dari server. Jika hasil belum diketahui,
            jangan membayar ulang secara terpisah.
          </div>
          {receipt && (
            <section className="receipt" aria-label="Struk pembelian">
              <h3>Struk pembelian</h3>
              <p>Referensi {order.reference} · {date(order.createdAt)}</p>
              <table>
                <thead><tr><th>Item</th><th>Jumlah</th><th>Harga</th><th>Subtotal</th></tr></thead>
                <tbody>
                  {order.items.map((i: any) => (
                    <tr key={i.id}><td>{i.productName} — {i.name} ({i.sku})</td><td>{i.quantity}</td><td>{money(i.price)}</td><td>{money(i.price * i.quantity)}</td></tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={3}>Subtotal</td><td>{money(itemsTotal)}</td></tr>
                  <tr><td colSpan={3}>Ongkir {order.shipping?.service}</td><td>{money(order.shipping?.amount ?? order.total - itemsTotal)}</td></tr>
                  <tr><th colSpan={3}>Total dibayar</th><th>{money(order.total)}</th></tr>
                </tfoot>
              </table>
              {order.contact?.name && <p>Penerima: {order.contact.name} · {order.contact.phone}</p>}
              {order.address?.line && <p>Alamat: {order.address.line}, {order.address.label}</p>}
              {order.shipping?.shipTo && <p>Estimasi kirim: {date(order.shipping.shipFrom)} – {date(order.shipping.shipTo)} (satu pengiriman)</p>}
            </section>
          )}
          {order.status === "pending_payment" && !(typeof data.paymentUrl === "string" && /^https:\/\//.test(data.paymentUrl)) && (
            <div className="notice error no-print" role="status">
              Link pembayaran gagal dibuat, batalkan lalu pesan ulang.
            </div>
          )}
          {cancelState && <p role="status">{cancelState}</p>}
          <div className="actions no-print">
            {order.status === "pending_payment" && data.paymentState === "pending" &&
              typeof data.paymentUrl === "string" && /^https:\/\//.test(data.paymentUrl) && (
              <a className="button" href={data.paymentUrl} rel="noreferrer">
                Lanjutkan pembayaran yang sama
              </a>
            )}
            <button className="secondary" onClick={() => opened && load(opened.reference, opened.token)} disabled={busy}>
              Perbarui status
            </button>
            {receipt && <button className="secondary" onClick={() => window.print()}>Cetak struk</button>}
            {data.access?.type === "guest" && opened?.token && (
              <button className="secondary" onClick={() => downloadText(`pesanan-${order.reference}.txt`, confirmationText(order.reference, opened.token, location.origin))}>Simpan konfirmasi</button>
            )}
            {order.status === "pending_payment" && (
              <button className="danger" onClick={cancel} disabled={busy}>Batalkan pesanan</button>
            )}
          </div>
        </section>
      )}
    </>
  );
}

const STEPS = ["Menunggu pembayaran", "Dibayar", "Diproses", "Dikirim", "Selesai"];
const PROCESSING = new Set(["preparing", "production", "processing", "ready_to_ship"]);
function stepIndex(status: string, fulfillment: string) {
  if (status === "completed") return 4;
  if (status === "pending_payment") return 0;
  if (fulfillment === "shipped" || fulfillment === "delivered") return 3;
  if (PROCESSING.has(fulfillment)) return 2;
  return 1;
}
function OrderStepper({ status, fulfillment }: { status: string; fulfillment: string }) {
  if (status === "cancelled")
    return <ol className="stepper cancelled" aria-label="Progres pesanan"><li aria-current="step" data-state="cancelled"><span aria-hidden="true">×</span>Dibatalkan</li></ol>;
  const current = stepIndex(status, fulfillment);
  return (
    <ol className="stepper" aria-label="Progres pesanan">
      {STEPS.map((label, n) => {
        const state = n < current || (n === current && n === STEPS.length - 1) ? "done" : n === current ? "current" : "todo";
        return (
          <li key={label} data-state={state} aria-current={n === current ? "step" : undefined}>
            <span aria-hidden="true">{state === "done" ? "✓" : n + 1}</span>
            {label}
            {state === "done" && <span className="sr-only"> (selesai)</span>}
          </li>
        );
      })}
    </ol>
  );
}
