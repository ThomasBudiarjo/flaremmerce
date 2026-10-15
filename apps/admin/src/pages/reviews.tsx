import { href, Link, useRoute } from "@/lib/router";
import { label, number, reviewReason } from "@/lib/format";
import { useRememberList } from "@/lib/list-memory";
import { useSummary } from "@/lib/summary";
import type { ReviewItem } from "@/lib/types";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { DataTable, LinkRow } from "@/components/data-table";
import { LoadError } from "@/components/field";
import { RelativeTime } from "@/components/relative-time";
import { ReviewStatusBadge } from "@/components/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { TableCell } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

export function ReviewsPage() {
  const { route, navigate } = useRoute();
  const { summary } = useSummary();
  const status = route.query.get("status") === "resolved" ? "resolved" : "open";
  const list = usePagedList<ReviewItem>("/api/admin/review", { listKey: "items", cursor: "keyset", params: { status } });
  useRememberList("reviews", list.items.map((item) => item.id));
  const now = Date.now();
  return (
    <>
      <PageHeader title="Review" description="Kasus risiko dan pembayaran yang perlu diperiksa operator. Review terbuka menahan pengiriman pesanan." />
      <Tabs value={status} onValueChange={(value) => navigate(href("reviews", {}, value === "resolved" ? { status: "resolved" } : {}), true)}>
        <TabsList aria-label="Filter status review">
          <TabsTrigger value="open">
            Terbuka
            {summary?.openReviews ? (
              <Badge variant="secondary" className="ml-1 tabular-nums" aria-label={`${summary.openReviews} review`}>
                {number(summary.openReviews)}
              </Badge>
            ) : null}
          </TabsTrigger>
          <TabsTrigger value="resolved">Selesai</TabsTrigger>
        </TabsList>
      </Tabs>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[
          { head: "Alasan" },
          { head: "Pesanan" },
          { head: "Usia" },
          { head: "Status", mobileHidden: true },
          { head: "Catatan terakhir", mobileHidden: true },
        ]}
        empty={status === "open" ? { title: "Tidak ada review terbuka", description: "Semua kasus sudah ditangani." } : { title: "Belum ada review selesai" }}
      >
        {list.items.map((item) => (
          <LinkRow key={item.id} to={href("review-detail", { id: item.id })}>
            <TableCell className="whitespace-normal">
              <Link to={href("review-detail", { id: item.id })} className="font-medium underline-offset-4 hover:underline">
                {label(reviewReason, item.reason)}
              </Link>
            </TableCell>
            <TableCell>
              {item.orderId ? (
                <Link to={href("order-detail", { id: item.orderId })} className="underline-offset-4 hover:underline">
                  {item.reference ?? item.orderId}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </TableCell>
            <TableCell>
              <RelativeTime value={item.createdAt} now={now} />
            </TableCell>
            <TableCell>
              <ReviewStatusBadge value={item.status} />
            </TableCell>
            <TableCell className="max-w-64 truncate text-muted-foreground">{item.note || "—"}</TableCell>
          </LinkRow>
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
