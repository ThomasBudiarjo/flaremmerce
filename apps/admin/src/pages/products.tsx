import { useEffect, useState } from "react";
import { ImageIcon, Plus, SearchIcon } from "lucide-react";
import { href, Link, useRoute } from "@/lib/router";
import type { Category, Product } from "@/lib/types";
import { number } from "@/lib/format";
import { usePagedList } from "@/hooks/use-paged-list";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { LoadError } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const LOW_DEFAULT = 5;

/** Stock summary for the list: ready-stock available units, and whether any variant is at/below its threshold. */
export function stockSummary(product: Product) {
  const stock = product.variants.filter((v) => v.mode === "stock");
  const available = stock.reduce((sum, v) => sum + (v.available ?? 0), 0);
  const low = stock.some((v) => v.active && (v.available ?? 0) <= (v.lowStockThreshold ?? LOW_DEFAULT));
  return { available, low, preorder: product.variants.length - stock.length };
}

export function ProductsPage() {
  const { route, navigate } = useRoute();
  const q = route.query.get("q") ?? "";
  const category = route.query.get("category") ?? "";
  const status = route.query.get("status") ?? "all";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  const categories = useResource<{ categories: Category[] }>("/api/admin/categories");
  const params: Record<string, string> = {};
  if (q) params.q = q;
  if (category) params.category = category;
  const list = usePagedList<Product>("/api/admin/products", { listKey: "products", cursor: "slug", params, limit: 30 });
  const apply = (next: Record<string, string>) =>
    navigate(href("products", {}, Object.fromEntries(Object.entries({ q, category, status, ...next }).filter(([k, v]) => v && !(k === "status" && v === "all")))), true);
  // Archive state is not a server filter; it narrows the pages already loaded.
  const rows = list.items.filter((p) => (status === "active" ? p.active : status === "archived" ? !p.active : true));

  return (
    <>
      <PageHeader
        title="Produk"
        description="Kelola produk, varian, harga, dan stok katalog."
        actions={
          <Button asChild>
            <Link to={href("product-new")}>
              <Plus />
              Tambah produk
            </Link>
          </Button>
        }
      />
      <Tabs value={status} onValueChange={(value) => apply({ status: value })}>
        <TabsList aria-label="Filter status produk">
          <TabsTrigger value="all">Semua</TabsTrigger>
          <TabsTrigger value="active">Aktif</TabsTrigger>
          <TabsTrigger value="archived">Diarsipkan</TabsTrigger>
        </TabsList>
      </Tabs>
      <FilterBar>
        <form
          className="relative w-full sm:w-auto"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            apply({ q: search.trim() });
          }}
        >
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input aria-label="Cari produk" className="w-full pl-9 sm:w-64" placeholder="Cari nama produk…" value={search} onChange={(e) => setSearch(e.target.value)} />
        </form>
        <NativeSelect aria-label="Filter kategori" value={category} onChange={(e) => apply({ category: e.target.value })}>
          <NativeSelectOption value="">Semua kategori</NativeSelectOption>
          {categories.data?.categories.map((c) => (
            <NativeSelectOption key={c.id} value={c.slug}>
              {c.name}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        {(q || category) && (
          <Button variant="ghost" size="sm" onClick={() => apply({ q: "", category: "" })}>
            Hapus filter
          </Button>
        )}
      </FilterBar>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[{ head: <span className="sr-only">Foto</span>, className: "w-14" }, { head: "Produk" }, { head: "Status" }, { head: "Kategori" }, { head: "Varian", className: "text-right" }, { head: "Stok", className: "text-right" }]}
        empty={{ title: q || category ? "Tidak ada produk yang cocok" : "Belum ada produk", description: q || category ? "Ubah pencarian atau filter." : "Tambahkan produk pertama untuk mulai berjualan." }}
      >
        {rows.map((product) => {
          const stock = stockSummary(product);
          return (
            <TableRow key={product.id} className="cursor-pointer" onClick={() => navigate(href("product-edit", { id: product.id }))}>
              <TableCell>
                {product.imageUrl ? (
                  <img src={product.imageUrl} alt="" className="size-10 rounded-md border object-cover" loading="lazy" />
                ) : (
                  <span className="flex size-10 items-center justify-center rounded-md border bg-muted text-muted-foreground">
                    <ImageIcon className="size-4" />
                  </span>
                )}
              </TableCell>
              <TableCell className="whitespace-normal">
                <Link to={href("product-edit", { id: product.id })} className="font-medium underline-offset-4 hover:underline" onClick={(e) => e.stopPropagation()}>
                  {product.name}
                </Link>
                <div className="text-xs text-muted-foreground">/{product.slug}</div>
              </TableCell>
              <TableCell>{product.active ? <Badge>Aktif</Badge> : <Badge variant="outline">Diarsipkan</Badge>}</TableCell>
              <TableCell>{product.category?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell className="text-right tabular-nums">{product.variants.length}</TableCell>
              <TableCell className="text-right">
                <span className="tabular-nums">{number(stock.available)}</span>
                {stock.preorder > 0 && <span className="text-xs text-muted-foreground"> + {stock.preorder} PO</span>}
                {stock.low && (
                  <Badge variant="destructive" className="ml-2">
                    Menipis
                  </Badge>
                )}
              </TableCell>
            </TableRow>
          );
        })}
      </DataTable>
      {list.cursor && (
        <Button variant="outline" className="self-center" disabled={list.loadingMore} onClick={list.loadMore}>
          {list.loadingMore ? "Memuat…" : "Muat lebih banyak"}
        </Button>
      )}
    </>
  );
}
