import { useEffect, useRef, useState } from "react";
import { google } from "../lib/cart";
import { date, money } from "../lib/catalog";
import { DEFAULT_PAGE_SIZE, PAGE_SIZES } from "../../../../src/shared";

type Summary = { reference: string; status: string; fulfillment: string; total: number; currency: string; createdAt: number };

/** Page size lives in ?limit= so a reload or shared link keeps it; the page itself restarts at one. */
function sizeFromUrl() {
  const size = Number(new URLSearchParams(location.search).get("limit"));
  return (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE;
}
function sizeToUrl(size: number) {
  const url = new URL(location.href);
  if (size === DEFAULT_PAGE_SIZE) url.searchParams.delete("limit");
  else url.searchParams.set("limit", String(size));
  history.replaceState(history.state, "", url);
}

export default function OrderHistory({ open, labels, onOwnerChange }: { open: (reference: string) => void; labels: Record<string, string>; onOwnerChange: (owner: string | null) => void }) {
  const [orders, setOrders] = useState<Summary[]>([]);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [hasNext, setHasNext] = useState(false);
  // Keyset pages are reached by walking forward: trail[i] is the cursor that opens page i + 1 ("" = first page).
  const trail = useRef<string[]>([""]);
  const shown = useRef({ page: 1, size: DEFAULT_PAGE_SIZE });
  const [busy, setBusy] = useState(true);
  const [anonymous, setAnonymous] = useState(false);
  const [error, setError] = useState("");
  // Unknown until /api/config answers; only an explicit false (no Google credentials) hides sign-in.
  const [googleEnabled, setGoogleEnabled] = useState<boolean | null>(null);
  const ownerId = useRef<string | null>(null);
  const onOwnerChangeRef = useRef(onOwnerChange);
  onOwnerChangeRef.current = onOwnerChange;
  const requestSequence = useRef(0);
  async function load(target = shown.current.page, size = shown.current.size) {
    const sequence = ++requestSequence.current;
    setBusy(true);
    setError("");
    if (trail.current[target - 1] === undefined) target = 1;
    const after = trail.current[target - 1];
    try {
      const query = new URLSearchParams({ limit: String(size) });
      if (after) query.set("cursor", after);
      const response = await fetch(`/api/orders?${query}`, { credentials: "same-origin", cache: "no-store" });
      if (sequence !== requestSequence.current) return;
      if (response.status === 401) {
        onOwnerChangeRef.current(null);
        ownerId.current = null;
        trail.current = [""];
        shown.current = { page: 1, size };
        setAnonymous(true); setOrders([]); setPage(1); setHasNext(false);
        return;
      }
      if (!response.ok) throw new Error("Riwayat pesanan tidak dapat dimuat. Silakan coba lagi.");
      const result = await response.json();
      if (sequence !== requestSequence.current) return;
      onOwnerChangeRef.current(result.ownerId);
      // Another account signed in since the cursor was issued: its cursors do not apply, start over.
      if (after && result.ownerId !== ownerId.current) {
        ownerId.current = null;
        trail.current = [""];
        await load(1, size);
        return;
      }
      ownerId.current = result.ownerId;
      trail.current = trail.current.slice(0, target);
      if (result.nextCursor) trail.current[target] = result.nextCursor;
      shown.current = { page: target, size };
      setAnonymous(false);
      setOrders(result.orders);
      setPage(target);
      setPageSize(size);
      setHasNext(!!result.nextCursor);
    } catch (e) { if (sequence === requestSequence.current) setError((e as Error).message); }
    finally { if (sequence === requestSequence.current) setBusy(false); }
  }
  function changeSize(size: number) {
    sizeToUrl(size);
    trail.current = [""];
    void load(1, size);
  }
  useEffect(() => {
    void load(1, sizeFromUrl());
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
    {!anonymous && !error && (page > 1 || hasNext || orders.length > PAGE_SIZES[0]) && <nav className="pager" aria-label="Halaman riwayat pesanan">
      <label className="page-size">
        <span className="muted">Tampilkan</span>
        <select value={pageSize} disabled={busy} onChange={(e) => changeSize(Number(e.target.value))}>
          {PAGE_SIZES.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
        <span className="muted">per halaman</span>
      </label>
      <div className="pages">
        <button className="secondary" disabled={busy || page <= 1} onClick={() => load(page - 1)} aria-label="Halaman sebelumnya">← Sebelumnya</button>
        <span className="muted" aria-live="polite">Halaman {page}</span>
        <button className="secondary" disabled={busy || !hasNext} onClick={() => load(page + 1)} aria-label="Halaman berikutnya">Berikutnya →</button>
      </div>
    </nav>}
  </section>;
}
