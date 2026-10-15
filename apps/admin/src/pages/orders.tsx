import { useEffect, useState } from "react";
import { toast } from "sonner";
import { useMutation } from "@/hooks/use-mutation";
import { HttpError } from "@/lib/api";
import { SearchIcon, DownloadIcon } from "lucide-react";
import { href, Link, useRoute } from "@/lib/router";
import { dateWIB, label, reviewReason } from "@/lib/format";
import type { OrderSummary } from "@/lib/types";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { MoneyText } from "@/components/money-text";
import { FulfillmentBadge, OrderStatusBadge } from "@/components/status-badge";
import { DataTable } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { LoadError } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const tabs = [
  ["all", "Semua"],
  ["pending_payment", "Belum dibayar"],
  ["to_fulfill", "Perlu diproses"],
  ["shipped", "Dikirim"],
  ["completed", "Selesai"],
  ["cancelled", "Dibatalkan"],
  ["held", "Ditahan"],
] as const;

export function OrdersPage() {
  const { route, navigate } = useRoute();
  const status = route.query.get("status") ?? "";
  const q = route.query.get("q") ?? "";
  const from = route.query.get("from") ?? "";
  const to = route.query.get("to") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);

  const filters: Record<string, string> = {};
  if (status) filters.status = status;
  if (q) filters.q = q;
  if (from) filters.from = from;
  if (to) filters.to = to;

  const list = usePagedList<OrderSummary>("/api/admin/orders", { listKey: "orders", cursor: "keyset", params: filters });

  const apply = (next: Record<string, string>) =>
    navigate(href("orders", {}, Object.fromEntries(Object.entries(next).filter(([, v]) => v))), true);

  const exporter = useMutation(
    async (query: string) => {
      const response = await fetch(`/api/admin/orders/export.csv?${query}`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new HttpError(response.status, data.error || "Ekspor gagal.");
      }
      const name = /filename="([^"]+)"/.exec(response.headers.get("Content-Disposition") ?? "")?.[1] ?? "orders.csv";
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return name;
    },
    { key: "orders-export", success: (name) => `Ekspor ${name} diunduh.` },
  );

  return (
    <>
      <PageHeader
        title="Pesanan"
        description="Kelola pembayaran, fulfillment, dan risiko pesanan."
        actions={
          <Button
            variant="outline"
            disabled={exporter.pending}
            onClick={() => {
              toast.info("Menyiapkan ekspor sesuai filter aktif…");
              void exporter.mutate(new URLSearchParams(filters).toString());
            }}
          >
            <DownloadIcon />
            {exporter.pending ? "Mengekspor…" : "Ekspor CSV"}
          </Button>
        }
      />
      <Tabs value={status || "all"} onValueChange={(value) => apply({ ...filters, status: value === "all" ? "" : value })}>
        <TabsList aria-label="Filter status pesanan" className="no-scrollbar max-w-full justify-start overflow-x-auto">
          {tabs.map(([value, label]) => (
            <TabsTrigger key={value} value={value}>
              {label}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <FilterBar>
        <form
          className="relative w-full sm:w-auto"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            apply({ ...filters, q: search.trim() });
          }}
        >
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Cari pesanan"
            className="w-full pl-9 sm:w-64"
            placeholder="Referensi, email, atau HP…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        <div className="flex items-center gap-2">
          <Label htmlFor="orders-from" className="text-sm text-muted-foreground">
            Dari
          </Label>
          <Input id="orders-from" type="date" className="w-40" value={from} onChange={(e) => apply({ ...filters, from: e.target.value })} />
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="orders-to" className="text-sm text-muted-foreground">
            Sampai
          </Label>
          <Input id="orders-to" type="date" className="w-40" value={to} onChange={(e) => apply({ ...filters, to: e.target.value })} />
        </div>
        {(q || from || to) && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              apply({ status });
            }}
          >
            Hapus filter
          </Button>
        )}
      </FilterBar>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[
          { head: "Referensi" },
          { head: "Tanggal" },
          { head: "Pelanggan" },
          { head: "Pembayaran" },
          { head: "Pengiriman" },
          { head: "Risiko" },
          { head: "Total", className: "text-right" },
        ]}
        empty={{ title: "Tidak ada pesanan", description: "Coba ubah filter atau rentang tanggal." }}
      >
        {list.items.map((order) => (
          <TableRow
            key={order.id}
            className="cursor-pointer"
            onClick={() => navigate(href("order-detail", { id: order.id }))}
          >
            <TableCell className="font-medium">
              <Link to={`/orders/${order.id}`} className="underline-offset-4 hover:underline">
                {order.reference}
              </Link>
            </TableCell>
            <TableCell className="whitespace-nowrap">{dateWIB(order.createdAt)}</TableCell>
            <TableCell>{order.contact?.name || "Guest"}</TableCell>
            <TableCell>
              <OrderStatusBadge value={order.status} />
            </TableCell>
            <TableCell>
              <FulfillmentBadge value={order.fulfillment} />
            </TableCell>
            <TableCell>
              {order.hold && (
                <Badge variant="destructive" title={order.openReviewReasons.map((r) => label(reviewReason, r)).join(", ")}>
                  Ditahan
                </Badge>
              )}
            </TableCell>
            <TableCell className="text-right">
              <MoneyText value={order.total} currency={order.currency} />
            </TableCell>
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
