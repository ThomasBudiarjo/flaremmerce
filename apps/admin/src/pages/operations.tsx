import { RefreshCw } from "lucide-react";
import { href, Link } from "@/lib/router";
import { age, label, number, operationSection, outboxStatus, paymentStatus, timeWIB } from "@/lib/format";
import type { OperationsSnapshot } from "@/lib/types";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { LoadError } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const statusMaps: Record<string, Record<string, string>> = { payments: paymentStatus, outbox: outboxStatus, orders: { pending_payment: "Menunggu pembayaran" }, reviews: { open: "Terbuka" } };

export function OperationsPage() {
  const resource = useResource<OperationsSnapshot>("/api/admin/operations");
  const data = resource.data;
  return (
    <>
      <PageHeader
        title="Operasional"
        description="Sampel tertua (maks. 20 per bagian), bukan jumlah total. Ambiguitas tidak membuktikan pembayaran gagal; halaman ini tidak menjalankan pemulihan."
        actions={
          <Button variant="outline" disabled={resource.loading} onClick={() => void resource.reload()}>
            <RefreshCw className={resource.loading ? "animate-spin motion-reduce:animate-none" : undefined} />
            {resource.loading ? "Memuat…" : "Perbarui status"}
          </Button>
        }
      />
      {resource.error && <LoadError message="Status tidak tersedia. Periksa akses admin lalu coba lagi." onRetry={() => void resource.reload()} />}
      {resource.loading && !data && <Skeleton className="h-48" role="status" aria-label="Memuat status" />}
      {data && <p className="text-sm text-muted-foreground">Snapshot {timeWIB(data.now)} WIB. Umur dihitung server saat snapshot.</p>}
      {data && (
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
      )}
    </>
  );
}
