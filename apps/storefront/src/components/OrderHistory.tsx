import { useEffect, useState } from "react";
import { google } from "../lib/cart";
import { date, money } from "../lib/catalog";

type Summary = { reference: string; status: string; fulfillment: string; total: number; currency: string; createdAt: number };
export default function OrderHistory({ open }: { open: (reference: string) => void }) {
  const [orders, setOrders] = useState<Summary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState("");
  async function load(after?: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/orders" + (after ? "?cursor=" + encodeURIComponent(after) : ""), { credentials: "same-origin", cache: "no-store" });
      if (response.status === 401) {
        setAnonymous(true); setOrders([]); setCursor(null);
        return;
      }
      if (!response.ok) throw new Error("Riwayat pesanan tidak dapat dimuat. Silakan coba lagi.");
      const page = await response.json();
      setAnonymous(false);
      setOrders((previous) => after ? [...previous, ...page.orders] : page.orders);
      setCursor(page.nextCursor);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, []);
  return <section className="panel" aria-label="Riwayat pesanan">
    <h2>Riwayat pesanan saya</h2>
    <p className="muted">Hanya pesanan yang dibuat dengan akun ini. Pesanan guest tetap memerlukan token privat, meskipun email sama.</p>
    {anonymous && <button disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await google(location.pathname + location.search); }
      catch (e) { setError((e as Error).message); setBusy(false); }
    }}>Masuk dengan Google</button>}
    {busy && <p role="status">Memuat riwayat…</p>}
    {error && <div role="alert" className="notice error">{error}</div>}
    {!anonymous && !busy && !error && orders.length === 0 && <p>Belum ada pesanan untuk akun ini.</p>}
    {orders.map((order) => <div className="line" key={order.reference}>
      <button disabled={busy} onClick={() => open(order.reference)}>{order.reference}</button>
      <p>{date(order.createdAt)} · {money(order.total)} · {order.status} · {order.fulfillment}</p>
    </div>)}
    {!anonymous && error && <button disabled={busy} onClick={() => load(cursor || undefined)}>Coba lagi</button>}
    {!anonymous && cursor && !error && <button disabled={busy} onClick={() => load(cursor)}>Muat lebih banyak</button>}
  </section>;
}
