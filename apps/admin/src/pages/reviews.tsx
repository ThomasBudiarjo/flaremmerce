import { href, Link, useRoute } from "@/lib/router";
import { label, reviewReason, timeWIB } from "@/lib/format";
import type { ReviewItem } from "@/lib/types";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { LoadError } from "@/components/field";
import { ReviewStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ReviewsPage() {
  const { route, navigate } = useRoute();
  const status = route.query.get("status") === "resolved" ? "resolved" : "open";
  const list = usePagedList<ReviewItem>("/api/admin/review", { listKey: "items", cursor: "keyset" });
  // The review API pages all cases newest-first; the tab narrows what has been loaded.
  const rows = list.items.filter((item) => item.status === status);
  return (
    <>
      <PageHeader title="Review" description="Kasus risiko dan pembayaran yang perlu diperiksa operator. Review terbuka menahan pengiriman pesanan." />
      <Tabs value={status} onValueChange={(value) => navigate(href("reviews", {}, value === "resolved" ? { status: "resolved" } : {}), true)}>
        <TabsList aria-label="Filter status review">
          <TabsTrigger value="open">Terbuka</TabsTrigger>
          <TabsTrigger value="resolved">Selesai</TabsTrigger>
        </TabsList>
      </Tabs>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[{ head: "Alasan" }, { head: "Pesanan" }, { head: "Dicatat (WIB)" }, { head: "Status" }, { head: "Catatan terakhir" }]}
        empty={status === "open" ? { title: "Tidak ada review terbuka", description: "Semua kasus yang dimuat sudah ditangani." } : { title: "Belum ada review selesai di halaman yang dimuat" }}
      >
        {rows.map((item) => (
          <TableRow key={item.id} className="cursor-pointer" onClick={() => navigate(href("review-detail", { id: item.id }))}>
            <TableCell className="whitespace-normal">
              <Link to={href("review-detail", { id: item.id })} className="font-medium underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
                {label(reviewReason, item.reason)}
              </Link>
            </TableCell>
            <TableCell>
              {item.orderId ? (
                <Link to={href("order-detail", { id: item.orderId })} className="underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
                  {item.reference ?? item.orderId}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell className="text-xs whitespace-nowrap">{timeWIB(item.createdAt)}</TableCell>
            <TableCell>
              <ReviewStatusBadge value={item.status} />
            </TableCell>
            <TableCell className="max-w-64 truncate text-muted-foreground">{item.note || "—"}</TableCell>
          </TableRow>
        ))}
      </DataTable>
      {list.cursor && (
        <Button variant="outline" className="self-center" disabled={list.loadingMore} onClick={list.loadMore}>
          {list.loadingMore ? "Memuat…" : "Muat lebih banyak"}
        </Button>
      )}
    </>
  );
}
