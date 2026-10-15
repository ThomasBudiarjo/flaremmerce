import { useState } from "react";
import { History, SearchIcon, SlidersHorizontal } from "lucide-react";
import { useSession } from "@/lib/auth";
import { href, Link, useRoute } from "@/lib/router";
import { number, timeWIB } from "@/lib/format";
import type { InventoryMovement, LowStockRow, Product, VariantSearchResult } from "@/lib/types";
import { usePagedList } from "@/hooks/use-paged-list";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { LoadError } from "@/components/field";
import { StockAdjustDialog, type StockTarget } from "@/components/stock-adjust-dialog";
import { VariantPicker } from "@/components/variant-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

/** Store default when a variant has no own threshold; mirrors LOW_STOCK_DEFAULT's default on the server. */
const LOW_DEFAULT = 5;

type Row = { variantId: string; sku: string; name: string; productId: string; productName: string; onHand: number; reserved: number; available: number; threshold?: number; low?: boolean };
type Target = StockTarget;

function Ledger({ target, onClose }: { target: Target | null; onClose: () => void }) {
  const { can } = useSession();
  const list = usePagedList<InventoryMovement>("/api/admin/inventory", {
    listKey: "movements",
    cursor: "keyset",
    params: { variantId: target?.variantId ?? "" },
    enabled: !!target,
    limit: 20,
  });
  return (
    <Sheet open={!!target} onOpenChange={(open) => !open && onClose()}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>Riwayat stok {target?.sku}</SheetTitle>
          <SheetDescription>{target ? `${target.productName} · ${target.name}` : ""}</SheetDescription>
        </SheetHeader>
        <div className="grid gap-3 px-4 pb-4">
          {list.error && <LoadError message={list.error} onRetry={list.reload} />}
          <DataTable
            loading={list.loading}
            columns={[{ head: "Waktu (WIB)" }, { head: "Selisih", className: "text-right" }, { head: "Alasan" }, { head: "Oleh" }]}
            empty={{ title: "Belum ada pergerakan stok" }}
          >
            {list.items.map((m) => (
              <TableRow key={m.id}>
                <TableCell className="text-xs whitespace-nowrap">{timeWIB(m.createdAt)}</TableCell>
                <TableCell className={`text-right tabular-nums ${m.delta < 0 ? "text-destructive" : ""}`}>
                  {m.delta > 0 ? "+" : ""}
                  {number(m.delta)}
                </TableCell>
                <TableCell className="whitespace-normal">
                  {m.reason}
                  {m.orderId && (
                    <div className="text-xs text-muted-foreground">
                      {can("ops") ? (
                        <Link to={href("order-detail", { id: m.orderId })} className="underline underline-offset-4" onClick={onClose}>
                          Lihat pesanan
                        </Link>
                      ) : (
                        `Pesanan ${m.orderId}`
                      )}
                    </div>
                  )}
                </TableCell>
                <TableCell className="max-w-28 truncate text-xs text-muted-foreground" title={m.actor}>
                  {m.actor || "Sistem"}
                </TableCell>
              </TableRow>
            ))}
          </DataTable>
          {list.cursor && (
            <Button variant="outline" disabled={list.loadingMore} onClick={list.loadMore}>
              {list.loadingMore ? "Memuat…" : "Muat lebih banyak"}
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function rowsFromProducts(products: Product[]): Row[] {
  return products.flatMap((p) =>
    p.variants
      .filter((v) => v.mode === "stock")
      .map((v) => {
        const threshold = v.lowStockThreshold ?? LOW_DEFAULT, available = v.onHand - v.reserved;
        return { variantId: v.id, sku: v.sku, name: v.name, productId: p.id, productName: p.name, onHand: v.onHand, reserved: v.reserved, available, threshold, low: v.active && p.active && available <= threshold };
      }),
  );
}

export function InventoryPage() {
  const { route, navigate } = useRoute();
  const low = route.query.get("low") === "1";
  const [adjusting, setAdjusting] = useState<Target | null>(null);
  const [ledger, setLedger] = useState<Target | null>(null);
  const [picked, setPicked] = useState<VariantSearchResult | null>(null);
  const [filter, setFilter] = useState("");
  const lowList = useResource<{ lowStock: LowStockRow[] }>(low ? "/api/admin/inventory?low=1" : null);
  const all = usePagedList<Product>("/api/admin/products", { listKey: "products", cursor: "slug", limit: 30, enabled: !low });
  const term = filter.trim().toLowerCase();
  const rows: Row[] = low
    ? (lowList.data?.lowStock ?? []).map((row) => ({ ...row, low: true }))
    : rowsFromProducts(all.items).filter((row) => !term || `${row.sku} ${row.name} ${row.productName}`.toLowerCase().includes(term));
  const loading = low ? lowList.loading : all.loading;
  const error = low ? lowList.error : all.error;

  const applyAdjustment = (variantId: string, inventory: { onHand: number; reserved: number }) => {
    if (low) void lowList.reload({ keep: true });
    all.setItems((products) =>
      products.map((p) => ({ ...p, variants: p.variants.map((v) => (v.id === variantId ? { ...v, ...inventory, available: inventory.onHand - inventory.reserved } : v)) })),
    );
  };

  return (
    <>
      <PageHeader title="Inventori" description="Saldo stok ready stock, penyesuaian dengan alasan, dan riwayat pergerakan." />
      <Tabs value={low ? "low" : "all"} onValueChange={(value) => navigate(href("inventory", {}, value === "low" ? { low: "1" } : {}), true)}>
        <TabsList aria-label="Filter inventori">
          <TabsTrigger value="all">Semua</TabsTrigger>
          <TabsTrigger value="low">Stok menipis</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="grid gap-4 md:grid-cols-2 md:items-end">
        {!low && (
          <div className="relative max-w-md">
            <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Saring varian yang dimuat" className="pl-9" placeholder="Saring varian yang dimuat…" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
        )}
        <div className="max-w-md">
        <VariantPicker
          id="inventory-variant"
          label="Cari varian untuk disesuaikan"
          mode="stock"
          selected={picked}
          onSelect={(variant) => {
            setPicked(variant);
            if (variant) setAdjusting({ variantId: variant.id, sku: variant.sku, name: variant.name, productName: variant.productName });
          }}
        />
        </div>
      </div>
      {error && <LoadError message={error} onRetry={() => (low ? void lowList.reload() : all.reload())} />}
      <DataTable
        loading={loading}
        columns={[
          { head: "Varian" },
          { head: "Tersedia", className: "text-right" },
          { head: "Direservasi", className: "text-right", mobileHidden: true },
          { head: "Fisik", className: "text-right", mobileHidden: true },
          { head: <span className="sr-only">Aksi</span> },
        ]}
        empty={
          low
            ? { title: "Tidak ada stok menipis", description: "Semua varian aktif di atas ambang." }
            : term
              ? { title: "Tidak ada varian yang cocok", description: "Penyaringan hanya mencakup produk yang sudah dimuat. Muat lebih banyak atau cari varian di atas." }
              : { title: "Belum ada varian ready stock" }
        }
      >
        {rows.map((row) => {
          const target = { variantId: row.variantId, sku: row.sku, name: row.name, productName: row.productName };
          return (
            <TableRow key={row.variantId}>
              <TableCell className="whitespace-normal">
                <Link to={href("product-edit", { id: row.productId })} className="font-medium underline-offset-4 hover:underline">
                  {row.productName}
                </Link>
                <div className="text-xs text-muted-foreground">
                  {row.name} · {row.sku}
                </div>
              </TableCell>
              <TableCell className="text-right tabular-nums">
                {number(row.available)}
                {row.low && row.threshold !== undefined && (
                  <Badge variant="destructive" className="ml-2" title={`Ambang stok menipis ${row.threshold}`}>
                    ≤ {row.threshold}
                  </Badge>
                )}
              </TableCell>
              <TableCell className="text-right tabular-nums">{number(row.reserved)}</TableCell>
              <TableCell className="text-right tabular-nums">{number(row.onHand)}</TableCell>
              <TableCell className="text-right whitespace-nowrap">
                <Button variant="outline" size="sm" onClick={() => setAdjusting(target)}>
                  <SlidersHorizontal />
                  Sesuaikan<span className="sr-only"> {row.sku}</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setLedger(target)}>
                  <History />
                  Riwayat<span className="sr-only"> {row.sku}</span>
                </Button>
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>
      {!low && all.cursor && (
        <Button variant="outline" className="self-center" disabled={all.loadingMore} onClick={all.loadMore}>
          {all.loadingMore ? "Memuat…" : "Muat lebih banyak"}
        </Button>
      )}
      <StockAdjustDialog
        target={adjusting}
        onClose={() => {
          setAdjusting(null);
          setPicked(null);
        }}
        onAdjusted={applyAdjustment}
      />
      <Ledger target={ledger} onClose={() => setLedger(null)} />
    </>
  );
}
