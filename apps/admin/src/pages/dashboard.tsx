import { useCallback, useEffect, useState } from "react";
import { Link } from "@/lib/router";
import { get } from "@/lib/api";
import { money, number, dateWIB } from "@/lib/format";
import { useSession } from "@/lib/auth";
import { useLatestRequest } from "@/hooks/use-latest-request";
import type { OperationsSnapshot, OrderSummary, Summary } from "@/lib/types";
import { PageHeader } from "@/components/page-header";
import { MoneyText } from "@/components/money-text";
import { OrderStatusBadge, FulfillmentBadge } from "@/components/status-badge";
import { DataTable } from "@/components/data-table";
import { TableRow, TableCell } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";

const ranges = [
  ["today", "Hari ini"],
  ["7d", "7 hari"],
  ["30d", "30 hari"],
] as const;

export function DashboardPage() {
  const { can } = useSession();
  const [range, setRange] = useState<(typeof ranges)[number][0]>("today");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [orders, setOrders] = useState<OrderSummary[] | null>(null);
  const [paymentsUnknown, setPaymentsUnknown] = useState<number | null>(null);
  const [error, setError] = useState("");
  const begin = useLatestRequest();
  const ops = can("ops");

  const load = useCallback(async () => {
    if (!ops) return;
    const controller = begin();
    setError("");
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
    } catch (e) {
      if (!controller.signal.aborted) setError((e as Error).message);
    }
  }, [begin, range, ops]);

  useEffect(() => {
    setSummary(null);
    setOrders(null);
    void load();
  }, [load]);

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
      {!ops ? (
        <Card className="max-w-xl">
          <CardHeader>
            <CardTitle>Selamat bekerja</CardTitle>
            <CardDescription>
              Peran katalog mengelola produk, kategori, inventori, dan pre-order dari menu di samping.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/products">Kelola produk</Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/inventory?low=1">Stok menipis</Link>
            </Button>
          </CardContent>
        </Card>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}{" "}
              <Button variant="outline" size="sm" onClick={load}>
                Muat ulang
              </Button>
            </p>
          )}
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
                  <CardTitle className="text-2xl tabular-nums">
                    {value ?? <Skeleton className="h-7 w-24" />}
                  </CardTitle>
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
                      <CardTitle className="text-2xl tabular-nums">
                        {count == null ? <Skeleton className="h-7 w-12" /> : number(count)}
                      </CardTitle>
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
              loading={orders === null && !error}
              columns={[
                { head: "Referensi" },
                { head: "Tanggal" },
                { head: "Pelanggan" },
                { head: "Pembayaran" },
                { head: "Pengiriman" },
                { head: "Total", className: "text-right" },
              ]}
              empty={{ title: "Belum ada pesanan", description: "Pesanan baru akan muncul di sini." }}
            >
              {(orders ?? []).map((order) => (
                <TableRow key={order.id}>
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
                </TableRow>
              ))}
            </DataTable>
          </section>
        </>
      )}
    </>
  );
}
