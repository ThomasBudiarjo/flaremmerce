import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogTrigger } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";

export const reviewReasons: Record<string, string> = {
  payment_mismatch: "Nominal atau mata uang tidak cocok",
  unknown_reference: "Referensi pembayaran tidak dikenal",
  additional_payment_confirmation: "Konfirmasi pembayaran tambahan",
  late_payment: "Pembayaran setelah reservasi dilepas",
  reconciliation_exhausted: "Rekonsiliasi perlu ditindaklanjuti",
  outbox_exhausted: "Pekerjaan latar perlu ditindaklanjuti",
};
const statuses: Record<string, string> = {
  pending_payment: "Menunggu pembayaran", paid: "Terbayar", completed: "Selesai", cancelled: "Dibatalkan",
  created: "Dibuat", pending: "Menunggu", unknown: "Belum diketahui", succeeded: "Berhasil", failed: "Gagal", expired: "Kedaluwarsa", ignored: "Diabaikan",
};
const time = (value: number) => new Date(value).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });
const amount = (value: number, currency: string) => new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: 0 }).format(value);

export function ReviewDetail({ id, api, refresh }: { id: string; api: (path: string, body?: unknown, method?: string) => Promise<any>; refresh: () => Promise<void> }) {
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
    try { await api(route, { version: detail.item.version, status, note }, "PATCH"); await load(); await refresh(); }
    catch (e) { setError((e as Error).message + " Muat ulang bukti sebelum mencoba lagi."); }
    finally { setBusy(false); }
  }
  return <Dialog onOpenChange={(open) => { if (open) void load(); }}>
    <DialogTrigger asChild><Button variant="outline" size="sm">Bukti & tindakan</Button></DialogTrigger>
    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Pemeriksaan pembayaran</DialogTitle><DialogDescription>Ditangani berarti sudah ditindaklanjuti secara eksternal. Tidak menandai terbayar, refund, melepas stok, atau mengubah pesanan.</DialogDescription></DialogHeader>
      {error && <p role="alert" className="text-destructive">{error}</p>}
      {busy && <p role="status">Memuat atau menyimpan pemeriksaan…</p>}
      <Button variant="outline" disabled={busy} onClick={load}>Muat ulang bukti</Button>
      {detail && <>
        <div className="flex flex-wrap items-center gap-2"><Badge variant={detail.item.status === "open" ? "outline" : "secondary"}>{detail.item.status === "open" ? "Perlu ditangani" : "Ditangani"}</Badge><span className="text-sm">{reviewReasons[detail.item.reason] || detail.item.reason}</span></div>
        <dl className="grid gap-2 rounded-md border p-3 text-sm">
          <div><dt className="text-muted-foreground">Pesanan</dt><dd className="break-all font-medium">{detail.order?.reference || "Tidak ditemukan"}</dd></div>
          {detail.order && <div><dt className="text-muted-foreground">Total dan status pesanan</dt><dd>{amount(detail.order.total, detail.order.currency)} · {statuses[detail.order.status] || detail.order.status}</dd></div>}
          <div><dt className="text-muted-foreground">Percobaan pembayaran</dt><dd className="break-all">{detail.attempt ? `${detail.attempt.reference} · ${statuses[detail.attempt.status] || detail.attempt.status}` : "Tidak ditemukan"}</dd></div>
          <div><dt className="text-muted-foreground">Kasus dicatat (WIB)</dt><dd>{time(detail.item.createdAt)}</dd></div>
        </dl>
        <h3 className="font-semibold">Event pembayaran terverifikasi (maks. 100 terbaru)</h3>
        {detail.events.length ? <Table>
          <TableHeader><TableRow><TableHead>Event / waktu (WIB)</TableHead><TableHead>Nominal</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
          <TableBody>{detail.events.map((event: any) => <TableRow key={event.eventKey}><TableCell className="max-w-56 whitespace-normal break-all"><div>{event.eventKey}</div><div className="text-xs text-muted-foreground">{time(event.createdAt)}</div></TableCell><TableCell>{amount(event.amount, event.currency)}</TableCell><TableCell>{statuses[event.status] || event.status}</TableCell></TableRow>)}</TableBody>
        </Table> : <p className="text-sm text-muted-foreground">Belum ada event pembayaran terverifikasi untuk kasus ini.</p>}
        <Label htmlFor={`note-${id}`}>Catatan operator / penyelesaian (wajib)</Label>
        <Textarea id={`note-${id}`} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} />
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" disabled={busy || !note.trim()} onClick={() => save(detail.item.status)}>Simpan catatan</Button>
          <Button disabled={busy || !note.trim()} onClick={() => save(detail.item.status === "open" ? "resolved" : "open")}>{detail.item.status === "open" ? "Tandai ditangani eksternal" : "Buka kembali"}</Button>
        </div>
        <h3 className="font-semibold">Riwayat audit (maks. 100 terbaru)</h3>
        {!detail.history.length && <p className="text-sm text-muted-foreground">Belum ada tindakan operator.</p>}
        {detail.history.map((entry: any, i: number) => <div key={i} className="rounded-md border p-3 text-sm"><p><span className="break-all">{entry.actor}</span> · <span className="whitespace-nowrap">{time(entry.createdAt)}</span> · {entry.details.status === "resolved" ? "Ditangani" : "Perlu ditangani"}</p><p className="whitespace-pre-wrap break-words">{entry.details.note}</p></div>)}
      </>}
    </DialogContent>
  </Dialog>;
}
