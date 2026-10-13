import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';

type Item = { id: string; orderId?: string; reference?: string; status: string; attempts?: number; createdAt: number; ageMs: number };
type Snapshot = { now: number; sections: Record<string, { items: Item[]; hasMore: boolean; atLeast: number }> };
const labels: Record<string, string> = { orders: 'Menunggu pembayaran', payments: 'Percobaan pembayaran', outbox: 'Outbox belum selesai', reviews: 'Review terbuka' };
export function OperationalStatus({ api }: { api: (path: string) => Promise<any> }) {
  const [data, setData] = useState<Snapshot | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const sequence = useRef(0);
  async function refresh() {
    const current = ++sequence.current;
    setData(null); setError(''); setBusy(true);
    try {
      const result = await api('/api/admin/operations');
      if (current === sequence.current) setData(result);
    } catch {
      if (current === sequence.current) { setData(null); setError('Status tidak tersedia. Periksa akses admin lalu coba lagi.'); }
    } finally { if (current === sequence.current) setBusy(false); }
  }
  useEffect(() => { void refresh(); return () => { ++sequence.current; }; }, [api]);
  return <div className="grid gap-4">
    <h2 className="text-xl font-semibold">Status operasional</h2>
    <p>Sampel tertua, maksimum 20 per bagian; bukan jumlah total. Ambiguitas tidak membuktikan pembayaran gagal. Tidak ada tindakan pemulihan otomatis dari halaman ini.</p>
    <Button className="justify-self-start" disabled={busy} onClick={refresh}>{busy ? 'Memuat…' : 'Perbarui status'}</Button>
    {error && <p role="alert">{error}</p>}
    {data && <p>Snapshot: {new Date(data.now).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB. Umur dihitung oleh server saat snapshot.</p>}
    {data && Object.entries(data.sections).map(([name, section]) => <Card key={name}>
      <CardHeader><CardTitle>{labels[name]} — {section.items.length} ditampilkan{section.hasMore ? `; setidaknya ${section.atLeast} belum selesai` : ''}</CardTitle></CardHeader>
      <CardContent className="overflow-x-auto">
        {!section.items.length ? <p>Tidak ada backlog dalam bagian ini.</p> : <Table><TableHeader><TableRow><TableHead>ID / referensi</TableHead><TableHead>Status</TableHead><TableHead>Percobaan</TableHead><TableHead>Dibuat (WIB)</TableHead><TableHead>Umur</TableHead></TableRow></TableHeader><TableBody>{section.items.map(item => <TableRow key={item.id}>
          <TableCell>{item.reference || item.id}{item.orderId && <div>Order: {item.orderId}</div>}</TableCell><TableCell>{item.status}</TableCell><TableCell>{item.attempts ?? '—'}{item.attempts !== undefined && item.attempts >= 8 ? ' (habis)' : ''}</TableCell><TableCell>{new Date(item.createdAt).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })}</TableCell><TableCell>{Math.floor(item.ageMs / 60000)} menit</TableCell>
        </TableRow>)}</TableBody></Table>}
      </CardContent>
    </Card>)}
  </div>;
}
