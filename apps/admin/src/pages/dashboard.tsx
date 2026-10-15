import { useCallback, useEffect, useState } from "react";
import { cn } from "cn";
import { RefreshCw } from "lucide-react";
import { href, Link } from "@/lib/router";
import { get } from "@/lib/api";
import { clockWIB, money, number, dateWIB, rangeWIB } from "@/lib/format";
import { useSummary } from "@/lib/summary";
import { useSession } from "@/lib/auth";
import { useLatestRequest } from "@/hooks/use-latest-request";
import type { OperationsSnapshot, OrderSummary, Summary } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { MoneyText } from "@/components/money-text";
import { OrderStatusBadge, FulfillmentBadge } from "@/components/status-badge";
import { DataTable, LinkRow } from "@/components/data-table";
import { LoadError } from "@/components/field";
import { TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const ranges = [
  ["today", "Hari ini"],
  ["7d", "7 hari"],
  ["30d", "30 hari"],
] as const;

export function DashboardPage() {
  const { can, config } = useSession();
  const disabled = config.environment === "staging"
    ? ([[config.payments, "Pembayaran DOKU"], [config.shipping, "Ongkir RajaOngkir"], [config.googleEnabled, "Login Google"], [config.turnstile, "Turnstile"]] as const)
        .filter(([enabled]) => enabled === false).map(([, label]) => label)
    : [];
  const [range, setRange] = useState<(typeof ranges)[number][0]>("today");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [paymentsUnknown, setPaymentsUnknown] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const ops = can("ops");
  const [loading, setLoading] = useState(ops);
  const begin = useLatestRequest();
  const { lowStock } = useSummary();

  const load = useCallback(async () => {
    if (!ops) return;
    const controller = begin();
    setError("");
    setLoading(true);
    try {
      const [nextSummary, recent, operations] = await Promise.all([
        get<Summary>(`/api/admin/summary?range=${range}`, controller.signal),
        get<{ orders: OrderSummary[] }>("/api/admin/orders?limit=10", controller.signal),
        get<OperationsSnapshot>("/api/admin/operations", controller.signal),
      ]);
      if (controller.signal.aborted) return;
      setSummary(nextSummary);
      setOrders(recent.orders);
      setPaymentsUnknown(operations.sections.payments?.items.filter((i) => i.status === "unknown").length ?? 0);
      setLoadedAt(Date.now());
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [begin, range, ops]);

  // A range switch keeps the previous figures on screen, dimmed, until the new ones arrive.
  useEffect(() => {
    void load();
  }, [load]);
  const stale = cn("transition-opacity duration-200", loading && summary && "is-stale");
  const placeholder = (className: string) => (error ? "—" : <Skeleton className={className} />);

  return (
    <>
      <PageHeader
        title="Beranda"
        description="Ringkasan penjualan dan hal yang perlu tindakan."
        actions={
          ops ? (
            <Tabs value={range} onValueChange={(v) => setRange(v as typeof range)}>
              <TabsList aria-label="Rentang waktu">
                {ranges.map(([value, label]) => (
                  <TabsTrigger key={value} value={value}>
                    {label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : undefined
        }
      />
      {disabled.length > 0 && (
        <Alert>
          <AlertTitle>Staging: integrasi belum dikonfigurasi</AlertTitle>
          <AlertDescription>{disabled.join(", ")} nonaktif di lingkungan ini.</AlertDescription>
        </Alert>
      )}
      {!ops ? (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Selamat bekerja</CardTitle>
            <CardDescription>
              Peran katalog mengelola produk, kategori, inventori, dan pre-order dari menu di samping.
            </CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4">
            <div className="text-sm" role="status">
              {lowStock == null ? (
                <Skeleton className="h-5 w-48" />
              ) : lowStock === 0 ? (
                "Tidak ada varian ready stock di bawah ambang."
              ) : (
                <>
                  <span className="text-2xl font-semibold tabular-nums">{lowStock >= 100 ? "100+" : number(lowStock)}</span> varian stok menipis
                </>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="outline">
                <Link to={href("products")}>Kelola produk</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={href("inventory", {}, { low: "1" })}>Stok menipis</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to={href("inventory")}>Inventori</Link>
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
            {summary ? <span className={stale}>{rangeWIB(summary.since, summary.now)}</span> : <Skeleton className="h-4 w-36" />}
            {loadedAt && <span>Diperbarui {clockWIB(loadedAt)}</span>}
            <Button variant="ghost" size="sm" disabled={loading} onClick={() => void load()}>
              <RefreshCw className={loading ? "animate-spin motion-reduce:animate-none" : undefined} />
              {loading ? "Memuat…" : "Perbarui"}
            </Button>
          </div>
          {error && <LoadError message={error} onRetry={() => void load()} />}
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(
              [
                ["Penjualan", summary ? money(summary.revenue) : null],
                ["Pesanan dibayar", summary ? number(summary.paidOrders) : null],
                ["Rata-rata pesanan", summary ? money(summary.averageOrderValue) : null],
                ["Menunggu pembayaran", summary ? number(summary.pendingPayment) : null],
              ] as const
            ).map(([title, value]) => (
              <Card key={title}>
                <CardHeader>
                  <CardDescription>{title}</CardDescription>
                  <CardTitle className={cn("text-2xl tabular-nums", stale)}>{value ?? placeholder("h-7 w-24")}</CardTitle>
                </CardHeader>
              </Card>
            ))}
          </div>
          <section aria-label="Perlu tindakan">
            <h2 className="mb-3 text-lg font-semibold">Perlu tindakan</h2>
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {(
                [
                  ["Siap diproses", summary?.toFulfill, "/orders?status=to_fulfill", "Pesanan terbayar menunggu diproses atau dikirim."],
                  ["Review terbuka", summary?.openReviews, "/reviews", "Kasus risiko dan pembayaran yang menahan pesanan."],
                  ["Stok menipis", summary?.lowStock, "/inventory?low=1", "Varian ready stock di bawah ambang."],
                  ["Pembayaran belum pasti", paymentsUnknown, "/operations", "Percobaan dengan status belum diketahui di penyedia."],
                ] as const
              ).map(([title, count, to, description]) => (
                <Card key={title} className="transition-colors hover:border-foreground/30">
                  <Link to={to} className="block h-full">
                    <CardHeader>
                      <CardDescription>{title}</CardDescription>
                      <CardTitle className={cn("text-2xl tabular-nums", stale)}>{count == null ? placeholder("h-7 w-12") : number(count)}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">{description}</CardContent>
                  </Link>
                </Card>
              ))}
            </div>
          </section>
          <section aria-label="Pesanan terbaru" className="grid gap-3">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Pesanan terbaru</h2>
              <Button asChild variant="outline" size="sm">
                <Link to="/orders">Semua pesanan</Link>
              </Button>
            </div>
            <DataTable
              loading={loading}
              columns={[
                { head: "Referensi" },
                { head: "Tanggal", mobileHidden: true },
                { head: "Pelanggan" },
                { head: "Pembayaran", mobileHidden: true },
                { head: "Pengiriman", mobileHidden: true },
                { head: "Total", className: "text-right" },
              ]}
              empty={{ title: "Belum ada pesanan", description: "Pesanan baru akan muncul di sini." }}
            >
              {(orders ?? []).map((order) => (
                <LinkRow key={order.id} to={href("order-detail", { id: order.id })}>
                  <TableCell className="p-2 font-medium">
                    <Link to={`/orders/${order.id}`} className="underline-offset-4 hover:underline">
                      {order.reference}
                    </Link>
                  </TableCell>
                  <TableCell className="p-2 whitespace-nowrap">{dateWIB(order.createdAt)}</TableCell>
                  <TableCell className="p-2">{order.contact?.name || "Guest"}</TableCell>
                  <TableCell className="p-2">
                    <OrderStatusBadge value={order.status} />
                  </TableCell>
                  <TableCell className="p-2">
                    <FulfillmentBadge value={order.fulfillment} />
                  </TableCell>
                  <TableCell className="p-2 text-right">
                    <MoneyText value={order.total} currency={order.currency} />
                  </TableCell>
                </LinkRow>
              ))}
            </DataTable>
          </section>
        </>
      )}
    </>
  );
}
