import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";

export function ReviewDetail({ id, api, refresh }: { id: string; api: (path: string, body?: unknown, method?: string) => Promise<any>; refresh: () => void }) {
  const [detail, setDetail] = useState<any>();
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const route = `/api/admin/review/${encodeURIComponent(id)}`;
  async function load() {
    setBusy(true); setError(""); setDetail(undefined);
    try { const data = await api(route); setDetail(data); setNote(data.item.note); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  async function save(status: "open" | "resolved") {
    setBusy(true); setError("");
    try { await api(route, { version: detail.item.version, status, note }, "PATCH"); await load(); refresh(); }
    catch (e) { setError((e as Error).message + " Muat ulang bukti sebelum mencoba lagi."); }
    finally { setBusy(false); }
  }
  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm">Bukti & tindakan</Button></DialogTrigger>
    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Pemeriksaan pembayaran</DialogTitle><DialogDescription>Resolved berarti sudah ditangani secara eksternal. Tidak menandai terbayar, refund, melepas stok, atau mengubah pesanan.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      <Button variant="outline" disabled={busy} onClick={load}>Muat ulang bukti</Button>
      {detail && <>
        <p>{detail.item.reason} · {detail.item.status} · versi {detail.item.version}</p>
        <h3 className="font-semibold">Ringkasan pesanan / percobaan pembayaran</h3>
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify({ order: detail.order, attempt: detail.attempt }, null, 2)}</pre>
        <h3 className="font-semibold">Event pembayaran terverifikasi (maks. 100 terbaru)</h3>
        <pre className="overflow-auto rounded-md bg-muted p-3 text-xs">{JSON.stringify(detail.events, null, 2)}</pre>
        <Label htmlFor={`note-${id}`}>Catatan operator / penyelesaian (wajib)</Label>
        <Textarea id={`note-${id}`} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || !note.trim()} onClick={() => save(detail.item.status)}>Simpan catatan</Button>
          <Button disabled={busy || !note.trim()} onClick={() => save(detail.item.status === "open" ? "resolved" : "open")}>{detail.item.status === "open" ? "Tandai ditangani eksternal" : "Buka kembali"}</Button>
        </div>
        <h3 className="font-semibold">Riwayat audit</h3>
        {detail.history.map((entry: any, i: number) => <div key={i} className="rounded-md border p-3 text-sm"><p>{entry.actor} · {new Date(entry.createdAt).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" })} · {entry.details.fromStatus} → {entry.details.status}</p><p className="whitespace-pre-wrap">{entry.details.note}</p></div>)}
      </>}
    </DialogContent>
  </Dialog>;
}
