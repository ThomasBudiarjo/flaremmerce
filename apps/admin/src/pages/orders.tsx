import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { DownloadIcon, ListFilter, Play, Printer, SearchIcon, X } from "lucide-react";
import { cn } from "cn";
import { useMutation, runLocked } from "@/hooks/use-mutation";
import { get, HttpError, patch } from "@/lib/api";
import { href, Link, useRoute } from "@/lib/router";
import { dateWIB, label, number, reviewReason, shiftDay, todayWIB } from "@/lib/format";
import { useRememberList } from "@/lib/list-memory";
import { markSummaryStale, useSummary } from "@/lib/summary";
import type { OrderDetail, OrderSummary } from "@/lib/types";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { MoneyText } from "@/components/money-text";
import { FulfillmentBadge, OrderStatusBadge } from "@/components/status-badge";
import { DataTable, LinkRow, SelectCell } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { LoadError } from "@/components/field";
import { PrintView, usePrint } from "@/components/print-view";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { TableCell } from "@/components/ui/table";
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

/** Server bulk print fetches each order's PII (audited per order); keep a batch reviewable. */
export const MAX_BULK_PRINT = 30;

/** WIB calendar ranges for the date presets; `to` is inclusive like the date inputs. */
export function presetRange(preset: "today" | "7d" | "30d" | "month", today = todayWIB()) {
  if (preset === "today") return { from: today, to: today };
  if (preset === "7d") return { from: shiftDay(today, -6), to: today };
  if (preset === "30d") return { from: shiftDay(today, -29), to: today };
  return { from: `${today.slice(0, 8)}01`, to: today };
}
const presets = [
  ["today", "Hari ini"],
  ["7d", "7 hari"],
  ["30d", "30 hari"],
  ["month", "Bulan ini"],
] as const;

type BulkResult = { done: number; skipped: string[]; failed: string[] };
export function bulkSummary({ done, skipped, failed }: BulkResult) {
  const parts = [`${done} diproses`];
  if (skipped.length) parts.push(`${skipped.length} dilewati (${[...new Set(skipped)].join(", ")})`);
  if (failed.length) parts.push(`${failed.length} gagal`);
  return parts.join(", ");
}
const skipReason = (order: OrderSummary) => (order.hold ? "ditahan" : order.status !== "paid" || order.fulfillment !== "unfulfilled" ? "sudah diproses" : null);

export function OrdersPage() {
  const { route, navigate } = useRoute();
  const { summary } = useSummary();
  const status = route.query.get("status") ?? "";
  const q = route.query.get("q") ?? "";
  const from = route.query.get("from") ?? "";
  const to = route.query.get("to") ?? "";
  const [search, setSearch] = useState(q);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [printJob, setPrintJob] = usePrint<OrderDetail[]>();
  useEffect(() => setSearch(q), [q]);

  const filters: Record<string, string> = {};
  if (status) filters.status = status;
  if (q) filters.q = q;
  if (from) filters.from = from;
  if (to) filters.to = to;
  const signature = JSON.stringify(filters);

  const list = usePagedList<OrderSummary>("/api/admin/orders", { listKey: "orders", cursor: "keyset", params: filters });
  useRememberList("orders", list.items.map((o) => o.id));
  useEffect(() => setSelected(new Set()), [signature]);

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

  const bulkMode = status === "to_fulfill";
  const chosen = useMemo(() => list.items.filter((o) => selected.has(o.id)), [list.items, selected]);
  const willSkip = chosen.filter((o) => skipReason(o)).length;

  const processBulk = useMutation(
    async (orders: OrderSummary[]) => {
      const result: BulkResult = { done: 0, skipped: [], failed: [] };
      // One request at a time: each is its own compare-and-set transition, under the same lock
      // the order detail page takes, so a detail tab and the bulk action cannot race.
      for (const order of orders) {
        const reason = skipReason(order);
        if (reason) {
          result.skipped.push(reason);
          continue;
        }
        const outcome = await runLocked(`fulfillment:${order.id}`, () =>
          patch(`/api/admin/orders/${encodeURIComponent(order.id)}/fulfillment`, { status: "processing" }).then(
            () => null,
            (e: Error) => e.message,
          ),
        );
        if (outcome.locked) result.skipped.push("sedang diproses");
        else if (outcome.result === null) result.done++;
        else result.failed.push(`${order.reference}: ${outcome.result}`);
      }
      return result;
    },
    {
      key: "orders-bulk-process",
      success: false,
      onSuccess: (result) => {
        const text = bulkSummary(result);
        if (result.failed.length) toast.warning(text, { description: result.failed.join("\n") });
        else toast.success(text);
        setSelected(new Set());
        void list.reload();
        markSummaryStale();
      },
    },
  );

  const printBulk = useMutation(
    async (orders: OrderSummary[]) => {
      const details: OrderDetail[] = [];
      for (const order of orders.slice(0, MAX_BULK_PRINT)) details.push((await get<{ order: OrderDetail }>(`/api/admin/orders/${encodeURIComponent(order.id)}`)).order);
      return details;
    },
    { key: "orders-bulk-print", success: false, onSuccess: (details) => setPrintJob(details) },
  );

  const activePreset = presets.find(([value]) => {
    const range = presetRange(value);
    return range.from === from && range.to === to;
  })?.[0];
  const counts: Record<string, number | undefined> = { to_fulfill: summary?.toFulfill, pending_payment: summary?.pendingPayment };
  const now = Date.now();

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
          {tabs.map(([value, text]) => (
            <TabsTrigger key={value} value={value}>
              {text}
              {counts[value] ? (
                <Badge variant="secondary" className="ml-1 tabular-nums" aria-label={`${counts[value]} pesanan`}>
                  {number(counts[value]!)}
                </Badge>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <FilterBar>
        <form
          className="grid w-full gap-1 sm:w-auto"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            apply({ ...filters, q: search.trim() });
          }}
        >
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input
              aria-label="Cari pesanan"
              aria-describedby="orders-search-hint"
              className="w-full pl-9 sm:w-72"
              placeholder="Referensi lengkap, email, atau HP…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <p id="orders-search-hint" className="text-xs text-muted-foreground">
            Harus cocok persis. Tekan Enter untuk mencari.
          </p>
        </form>
        <Button variant="outline" size="sm" className="md:hidden" aria-expanded={filtersOpen} onClick={() => setFiltersOpen((open) => !open)}>
          <ListFilter />
          Filter{from || to ? " (aktif)" : ""}
        </Button>
        <div className={cn("flex w-full flex-wrap items-center gap-2 md:contents", !filtersOpen && "max-md:hidden")}>
          <div className="flex flex-wrap gap-1" role="group" aria-label="Rentang tanggal cepat">
            {presets.map(([value, text]) => (
              <Button key={value} variant={activePreset === value ? "secondary" : "ghost"} size="sm" aria-pressed={activePreset === value} onClick={() => apply({ ...filters, ...presetRange(value) })}>
                {text}
              </Button>
            ))}
          </div>
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
        selection={bulkMode ? { ids: list.items.map((o) => o.id), selected, onChange: setSelected } : undefined}
        columns={[
          { head: "Referensi" },
          { head: "Tanggal", mobileHidden: true },
          { head: "Usia", mobileHidden: true },
          { head: "Pelanggan" },
          { head: "Pembayaran", mobileHidden: true },
          { head: "Pengiriman", mobileHidden: true },
          { head: "Risiko", mobileHidden: true },
          { head: "Total", className: "text-right" },
        ]}
        empty={
          q
            ? { title: "Tidak ada pesanan yang cocok", description: "Pencarian harus referensi lengkap, email, atau nomor HP." }
            : { title: "Tidak ada pesanan", description: "Coba ubah filter atau rentang tanggal." }
        }
      >
        {list.items.map((order) => (
          <LinkRow key={order.id} to={href("order-detail", { id: order.id })} data-state={selected.has(order.id) ? "selected" : undefined}>
            <SelectCell id={order.id} label={order.reference} />
            <TableCell className="font-medium">
              <Link to={href("order-detail", { id: order.id })} className="underline-offset-4 hover:underline">
                {order.reference}
              </Link>
            </TableCell>
            <TableCell className="whitespace-nowrap">{dateWIB(order.createdAt)}</TableCell>
            <TableCell>
              <RelativeTime value={order.createdAt} now={now} />
            </TableCell>
            <TableCell className="whitespace-normal">
              <div>{order.contact?.name || "Guest"}</div>
              {order.shipping?.service && <div className="text-xs text-muted-foreground">{order.shipping.service.toUpperCase()}</div>}
              <div className="mt-1 flex flex-wrap gap-1 md:hidden">
                <OrderStatusBadge value={order.status} />
                <FulfillmentBadge value={order.fulfillment} />
                {order.hold && <Badge variant="destructive">Ditahan</Badge>}
              </div>
            </TableCell>
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
          </LinkRow>
        ))}
      </DataTable>
      {list.cursor && (
        <Button variant="outline" className="self-center" disabled={list.loadingMore} onClick={list.loadMore}>
          {list.loadingMore ? "Memuat…" : "Muat lebih banyak"}
        </Button>
      )}
      {bulkMode && chosen.length > 0 && (
        <div role="region" aria-label="Aksi massal" className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t bg-background p-3 md:-mx-6 lg:-mx-8 print:hidden">
          <span className="text-sm font-medium">{number(chosen.length)} dipilih</span>
          {willSkip > 0 && <span className="text-sm text-muted-foreground">{number(willSkip)} akan dilewati (ditahan atau sudah diproses)</span>}
          <div className="ml-auto flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => setSelected(new Set())}>
              <X />
              Batal pilih
            </Button>
            <Button
              variant="outline"
              disabled={printBulk.pending || chosen.length > MAX_BULK_PRINT}
              title={chosen.length > MAX_BULK_PRINT ? `Maksimal ${MAX_BULK_PRINT} pesanan per cetak` : undefined}
              onClick={() => void printBulk.mutate(chosen)}
            >
              <Printer />
              {printBulk.pending ? "Menyiapkan…" : `Cetak packing slip (${chosen.length})`}
            </Button>
            <Button disabled={processBulk.pending} onClick={() => void processBulk.mutate(chosen)}>
              <Play />
              {processBulk.pending ? "Memproses…" : `Mulai proses (${chosen.length})`}
            </Button>
          </div>
        </div>
      )}
      {printJob && <PrintView mode="packing" orders={printJob} />}
    </>
  );
}
