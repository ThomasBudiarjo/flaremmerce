import { useEffect, useRef, useState } from "react";
import { google } from "../lib/cart";
import { date, money } from "../lib/catalog";

type Summary = { reference: string; status: string; fulfillment: string; total: number; currency: string; createdAt: number };
export default function OrderHistory({ open, labels, onOwnerChange }: { open: (reference: string) => void; labels: Record<string, string>; onOwnerChange: (owner: string | null) => void }) {
  const [orders, setOrders] = useState<Summary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState("");
  // Unknown until /api/config answers; only an explicit false (no Google credentials) hides sign-in.
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);
  const ownerId = useRef<string | null>(null);
  const onOwnerChangeRef = useRef(onOwnerChange);
  onOwnerChangeRef.current = onOwnerChange;
  const requestSequence = useRef(0);
  async function load(after?: string) {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/orders" + (after ? "?cursor=" + encodeURIComponent(after) : ""), { credentials: "same-origin", cache: "no-store" });
      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        onOwnerChangeRef.current(null);
        ownerId.current = null;
        setAnonymous(true); setOrders([]); setCursor(null);
        return;
      }
      if (!response.ok) throw new Error("Riwayat pesanan tidak dapat dimuat. Silakan coba lagi.");
      const page = await response.json();
      if (sequence !== requestSequence.current) return;
      onOwnerChangeRef.current(page.ownerId);
      if (after && page.ownerId !== ownerId.current) {
        ownerId.current = null;
        setOrders([]); setCursor(null);
        await load();
        return;
      }
      ownerId.current = page.ownerId;
      setAnonymous(false);
      setOrders((previous) => after ? [...previous, ...page.orders] : page.orders);
      setCursor(page.nextCursor);
    } catch (e) { if (sequence === requestSequence.current) setError((e as Error).message); }
    finally { if (sequence === requestSequence.current) setBusy(false); }
  }
  useEffect(() => {
    void load();
    fetch("/api/config", { credentials: "same-origin", cache: "no-store" }).then((r) => r.json()).then((c) => setGoogleEnabled(c?.googleEnabled !== false), () => setGoogleEnabled(true));
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      ++requestSequence.current;
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);
  return <section className="panel" aria-label="Riwayat pesanan">
    <h2>Riwayat pesanan saya</h2>
    <p className="muted">Hanya pesanan yang dibuat dengan akun ini. Pesanan guest tetap memerlukan token privat, meskipun email sama.</p>
    {anonymous && googleEnabled === false && <p className="muted">Login akun belum tersedia di lingkungan ini.</p>}
    {anonymous && googleEnabled && <button disabled={busy} onClick={async () => {
      setBusy(true); setError("");
      try { await google(location.pathname + location.search); }
      catch (e) { setError((e as Error).message); setBusy(false); }
    }}>Masuk dengan Google</button>}
    {busy && <p role="status">Memuat riwayat…</p>}
    {error && <div role="alert" className="notice error">{error}</div>}
    {!anonymous && !busy && !error && orders.length === 0 && <p>Belum ada pesanan untuk akun ini.</p>}
    {orders.map((order) => <div className="line" key={order.reference}>
      <button disabled={busy} onClick={() => open(order.reference)}>{order.reference}</button>
      <p>{date(order.createdAt)} · {money(order.total)} · {labels[order.status] || order.status} · {labels[order.fulfillment] || order.fulfillment}</p>
    </div>)}
    {!anonymous && error && <button disabled={busy} onClick={() => load()}>Coba lagi</button>}
    {!anonymous && cursor && !error && <button disabled={busy} onClick={() => load(cursor)}>Muat lebih banyak</button>}
  </section>;
}
