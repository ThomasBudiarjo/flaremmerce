import { useEffect, useState } from "react";
import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { href, Link } from "@/lib/router";
import { age, label, number, operationSection, outboxStatus, paymentStatus, timeWIB } from "@/lib/format";
import type { OperationsSnapshot } from "@/lib/types";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { LoadError } from "@/components/field";
import { RelativeTime } from "@/components/relative-time";
import { CardGridSkeleton, Reveal } from "@/components/loading";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const statusMaps: Record<string, Record<string, string>> = { payments: paymentStatus, outbox: outboxStatus, orders: { pending_payment: "Menunggu pembayaran" }, reviews: { open: "Terbuka" } };

export function OperationsPage() {
  const resource = useResource<OperationsSnapshot>("/api/admin/operations");
  const data = resource.data;
  const [auto, setAuto] = useState(false);
  const { reload } = resource;
  useEffect(() => {
    if (!auto) return;
    // A hidden tab skips its refresh; the next visible tick (or becoming visible) catches up.
    const tick = () => {
      if (document.visibilityState === "visible") void reload({ keep: true });
    };
    const timer = setInterval(tick, 30_000);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [auto, reload]);
  return (
    <>
      <PageHeader
        title="Operasional"
        description="Sampel tertua (maks. 20 per bagian), bukan jumlah total. Ambiguitas tidak membuktikan pembayaran gagal; halaman ini tidak menjalankan pemulihan."
        actions={
          <>
            <Label className="font-normal">
              <Checkbox checked={auto} onCheckedChange={(checked) => setAuto(checked === true)} />
              Perbarui otomatis tiap 30 detik
            </Label>
            <Button variant="outline" disabled={resource.loading} onClick={() => void resource.reload({ keep: true })}>
              <RefreshCw className={resource.loading ? "animate-spin motion-reduce:animate-none" : undefined} />
              {resource.loading ? "Memuat…" : "Perbarui status"}
            </Button>
          </>
        }
      />
      {resource.error && <LoadError message="Status tidak tersedia. Periksa akses admin lalu coba lagi." onRetry={() => void resource.reload()} />}
      {resource.loading && !data && <CardGridSkeleton label="Memuat status" count={4} className="xl:grid-cols-2" />}
      {data && (
        <Reveal aria-busy={resource.loading || undefined} className={cn("flex flex-col gap-6 transition-opacity duration-200", resource.loading && "is-stale")}>
          <p className="text-sm text-muted-foreground">
            Snapshot <RelativeTime value={data.now} /> ({timeWIB(data.now)} WIB). Umur dihitung server saat snapshot.
          </p>
          <div className="grid gap-6 xl:grid-cols-2">
            {Object.entries(data.sections).map(([name, section]) => (
              <Card key={name}>
                <CardHeader>
                  <CardTitle className="flex flex-wrap items-center gap-2">
                    {label(operationSection, name)}
                    <Badge variant={section.items.length ? "secondary" : "outline"}>{number(section.items.length)} ditampilkan</Badge>
                  </CardTitle>
                  <CardDescription>
                    {section.hasMore ? `${section.items.length} ditampilkan; setidaknya ${section.atLeast} belum selesai` : section.items.length ? "Semua item belum selesai ditampilkan." : "Tidak ada backlog."}
                  </CardDescription>
                </CardHeader>
                {section.items.length > 0 && (
                  <CardContent className="overflow-x-auto">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>ID / referensi</TableHead>
                          <TableHead>Status</TableHead>
                          <TableHead className="text-right">Percobaan</TableHead>
                          <TableHead>Umur</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {section.items.map((item) => {
                          const orderId = name === "orders" ? item.id : item.orderId;
                          return (
                            <TableRow key={item.id}>
                              <TableCell className="max-w-56 break-all whitespace-normal">
                                {orderId ? (
                                  <Link to={href("order-detail", { id: orderId })} className="underline-offset-4 hover:underline">
                                    {item.reference || item.id}
                                  </Link>
                                ) : name === "reviews" ? (
                                  <Link to={href("review-detail", { id: item.id })} className="underline-offset-4 hover:underline">
                                    {item.id}
                                  </Link>
                                ) : (
                                  item.reference || item.id
                                )}
                                {name === "reviews" && item.orderId && <div className="text-xs text-muted-foreground">Order: {item.orderId}</div>}
                              </TableCell>
                              <TableCell>{label(statusMaps[name] ?? {}, item.status)}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {item.attempts ?? "—"}
                                {item.attempts !== undefined && item.attempts >= 8 ? " (habis)" : ""}
                              </TableCell>
                              <TableCell className="whitespace-nowrap" title={`${timeWIB(item.createdAt)} WIB`}>
                                {age(item.ageMs)}
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </CardContent>
                )}
              </Card>
            ))}
          </div>
        </Reveal>
      )}
    </>
  );
}
