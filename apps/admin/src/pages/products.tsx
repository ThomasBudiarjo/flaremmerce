import { useEffect, useState } from "react";
import { Archive, Copy, ExternalLink, ImageIcon, MoreHorizontal, Pencil, Plus, RotateCcw, SearchIcon } from "lucide-react";
import { patch } from "@/lib/api";
import { href, Link, useRoute } from "@/lib/router";
import type { Category, Product } from "@/lib/types";
import { money, number } from "@/lib/format";
import { useRememberList } from "@/lib/list-memory";
import { useMutation } from "@/hooks/use-mutation";
import { usePagedList } from "@/hooks/use-paged-list";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { DataTable, LinkRow } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { LoadError } from "@/components/field";
import { LoadMoreButton } from "@/components/loading";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { TableCell } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

const LOW_DEFAULT = 5;

/** Stock summary for the list: ready-stock available units, and whether any variant is at/below its threshold. */
export function stockSummary(product: Product) {
  const stock = product.variants.filter((v) => v.mode === "stock");
  const available = stock.reduce((sum, v) => sum + (v.available ?? 0), 0);
  const low = stock.some((v) => v.active && (v.available ?? 0) <= (v.lowStockThreshold ?? LOW_DEFAULT));
  return { available, low, preorder: product.variants.length - stock.length };
}

/** "Rp 10.000" or "Rp 10.000 – Rp 25.000" across the product's variants. */
export function priceRange(product: Product) {
  if (!product.variants.length) return "—";
  const prices = product.variants.map((v) => v.price);
  const min = Math.min(...prices), max = Math.max(...prices);
  return min === max ? money(min) : `${money(min)} – ${money(max)}`;
}

/** The catalog search needs at least 2 characters; the input's maxLength keeps it inside D1's LIKE limit. */
const searchable = (term: string) => term.length === 0 || (term.length >= 2 && term.length <= 48);

export function ProductsPage() {
  const { route, navigate } = useRoute();
  const q = route.query.get("q") ?? "";
  const category = route.query.get("category") ?? "";
  const status = route.query.get("status") ?? "all";
  const [search, setSearch] = useState(q);
  const [toggle, setToggle] = useState<Product | null>(null);
  useEffect(() => setSearch(q), [q]);
  const categories = useResource<{ categories: Category[] }>("/api/admin/categories");
  const params: Record<string, string> = {};
  if (q) params.q = q;
  if (category) params.category = category;
  if (status !== "all") params.status = status;
  const list = usePagedList<Product>("/api/admin/products", { listKey: "products", cursor: "slug", params, limit: 30 });
  useRememberList("products", list.loading ? null : list.items.map((p) => p.id));
  const apply = (next: Record<string, string>) =>
    navigate(href("products", {}, Object.fromEntries(Object.entries({ q, category, status, ...next }).filter(([k, v]) => v && !(k === "status" && v === "all")))), true);

  const term = search.trim();
  useEffect(() => {
    if (term === q || !searchable(term)) return;
    const timer = setTimeout(() => apply({ q: term }), 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term, q]);

  const setActive = useMutation(
    (product: Product) => patch<{ product: Omit<Product, "variants" | "category"> }>(`/api/admin/products/${encodeURIComponent(product.id)}`, { active: !product.active, version: product.version }),
    {
      key: "product-list-active",
      success: (result) => (result.product.active ? "Produk diaktifkan." : "Produk diarsipkan."),
      onSuccess: (result) =>
        list.setItems((items) =>
          items
            .map((p) => (p.id === result.product.id ? { ...p, ...result.product } : p))
            .filter((p) => status === "all" || p.active === (status === "active")),
        ),
      onConflict: () => void list.reload(),
    },
  );

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
          className="grid w-full gap-1 sm:w-auto"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            if (searchable(term)) apply({ q: term });
          }}
        >
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
            <Input aria-label="Cari produk" className="w-full pl-9 sm:w-64" placeholder="Cari nama produk…" maxLength={48} value={search} onChange={(e) => setSearch(e.target.value)} />
          </div>
          {term.length === 1 && <p className="text-xs text-muted-foreground">Ketik minimal 2 karakter.</p>}
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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setSearch("");
              apply({ q: "", category: "" });
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
          { head: <span className="sr-only">Foto</span>, className: "w-14", mobileHidden: true },
          { head: "Produk" },
          { head: "Status", mobileHidden: true },
          { head: "Kategori", mobileHidden: true },
          { head: "Harga", className: "text-right" },
          { head: "Varian", className: "text-right", mobileHidden: true },
          { head: "Stok", className: "text-right" },
          { head: <span className="sr-only">Aksi</span> },
        ]}
        empty={
          q || category || status !== "all"
            ? { title: "Tidak ada produk yang cocok", description: "Ubah pencarian, status, atau filter kategori." }
            : { title: "Belum ada produk", description: "Tambahkan produk pertama untuk mulai berjualan." }
        }
      >
        {list.items.map((product) => {
          const stock = stockSummary(product);
          return (
            <LinkRow key={product.id} to={href("product-edit", { id: product.id })}>
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
                <Link to={href("product-edit", { id: product.id })} className="font-medium underline-offset-4 hover:underline">
                  {product.name}
                </Link>
                <div className="text-xs break-all text-muted-foreground">/{product.slug}</div>
                <div className="mt-1 md:hidden">{product.active ? <Badge>Aktif</Badge> : <Badge variant="outline">Diarsipkan</Badge>}</div>
              </TableCell>
              <TableCell>{product.active ? <Badge>Aktif</Badge> : <Badge variant="outline">Diarsipkan</Badge>}</TableCell>
              <TableCell>{product.category?.name ?? <span className="text-muted-foreground">—</span>}</TableCell>
              <TableCell className="min-w-24 text-right whitespace-normal tabular-nums">{priceRange(product)}</TableCell>
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
              <TableCell className="text-right">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="icon-sm" aria-label={`Aksi untuk ${product.name}`}>
                      <MoreHorizontal />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onSelect={() => navigate(href("product-edit", { id: product.id }))}>
                      <Pencil />
                      Edit
                    </DropdownMenuItem>
                    {product.active && (
                      <DropdownMenuItem asChild>
                        <a href={`/products/${encodeURIComponent(product.slug)}`} target="_blank" rel="noreferrer">
                          <ExternalLink />
                          Lihat di toko
                        </a>
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuItem onSelect={() => navigate(href("product-new", {}, { duplicate: product.id }))}>
                      <Copy />
                      Duplikat
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant={product.active ? "destructive" : "default"} onSelect={() => setToggle(product)}>
                      {product.active ? <Archive /> : <RotateCcw />}
                      {product.active ? "Arsipkan" : "Aktifkan"}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </TableCell>
            </LinkRow>
          );
        })}
      </DataTable>
      {list.cursor && (
        <LoadMoreButton loading={list.loadingMore} onClick={list.loadMore} />
      )}
      <AlertDialog open={!!toggle} onOpenChange={(open) => !open && setToggle(null)}>
        {toggle && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{toggle.active ? `Arsipkan ${toggle.name}?` : `Aktifkan ${toggle.name}?`}</AlertDialogTitle>
              <AlertDialogDescription>
                {toggle.active
                  ? "Produk disembunyikan dari toko. Pesanan yang sudah ada tidak berubah. Kamu bisa mengaktifkannya lagi kapan saja."
                  : "Produk tampil lagi di toko dan bisa dibeli."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Batal</AlertDialogCancel>
              <AlertDialogAction variant={toggle.active ? "destructive" : "default"} disabled={setActive.pending} onClick={() => void setActive.mutate(toggle)}>
                {toggle.active ? "Arsipkan" : "Aktifkan"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
