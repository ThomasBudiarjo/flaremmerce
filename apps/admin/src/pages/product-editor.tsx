import { useEffect, useMemo, useState } from "react";
import { Archive, ArrowLeft, ImageIcon, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import { patch, post } from "@/lib/api";
import { href, Link, useNavigationGuard, useRoute } from "@/lib/router";
import { money, number, variantMode } from "@/lib/format";
import type { Category, Product, Variant } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { PhotoUpload } from "@/components/photo-upload";
import { ConflictBanner } from "@/components/conflict-banner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, LoadError, NumberField, RequiredMark, TextField } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

export const MAX_VARIANTS = 30;
const slugPattern = "[a-z0-9]+(-[a-z0-9]+)*";

type ProductDraft = { slug: string; name: string; description: string; categoryId: string | null; imageUrl: string | null };
export type VariantDraft = {
  sku: string;
  name: string;
  price: number | null;
  weight: number | null;
  mode: "stock" | "preorder";
  maxPerOrder: number | null;
  maxPerCustomer: number | null;
  lengthCm: number | null;
  widthCm: number | null;
  heightCm: number | null;
  lowStockThreshold: number | null;
  active: boolean;
};
type NewVariant = Omit<VariantDraft, "active"> & { key: string; stock: number | null };

const productKeys = ["slug", "name", "description", "categoryId", "imageUrl"] as const;
const variantKeys = ["sku", "name", "price", "weight", "mode", "maxPerOrder", "maxPerCustomer", "lengthCm", "widthCm", "heightCm", "lowStockThreshold", "active"] as const;

/** Only the fields that differ from the server entity; the editor never resends untouched values. */
export function changedFields<T extends Record<string, unknown>>(base: T, draft: T, keys: readonly (keyof T)[]) {
  const out: Partial<T> = {};
  for (const key of keys) if (draft[key] !== base[key]) out[key] = draft[key];
  return out;
}

const productDraft = (p: Product): ProductDraft => ({ slug: p.slug, name: p.name, description: p.description, categoryId: p.categoryId, imageUrl: p.imageUrl });
const variantDraft = (v: Variant): VariantDraft => ({
  sku: v.sku,
  name: v.name,
  price: v.price,
  weight: v.weight,
  mode: v.mode,
  maxPerOrder: v.maxPerOrder,
  maxPerCustomer: v.maxPerCustomer,
  lengthCm: v.lengthCm,
  widthCm: v.widthCm,
  heightCm: v.heightCm,
  lowStockThreshold: v.lowStockThreshold,
  active: v.active,
});
let sequence = 0;
const blankVariant = (): NewVariant => ({
  key: `new-${++sequence}`,
  sku: "",
  name: "Default",
  price: null,
  weight: null,
  mode: "stock",
  stock: 0,
  maxPerOrder: null,
  maxPerCustomer: null,
  lengthCm: null,
  widthCm: null,
  heightCm: null,
  lowStockThreshold: null,
});
/** Server variant entity → list shape (the PATCH/POST response has no `available`). */
const withAvailable = (v: Variant): Variant => ({ ...v, available: v.mode === "stock" ? (v.onHand ?? 0) - (v.reserved ?? 0) : (v.available ?? null) });

/** All variant attributes. `stock` appears only when creating. */
function VariantFields<T extends Omit<VariantDraft, "active"> & { active?: boolean; stock?: number | null }>({
  value,
  onChange,
  disabled,
}: {
  value: T;
  onChange: (next: T) => void;
  disabled?: boolean;
}) {
  const set = <K extends keyof T>(key: K, v: T[K]) => onChange({ ...value, [key]: v });
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="SKU" required maxLength={100} value={value.sku} disabled={disabled} onChange={(e) => set("sku", e.target.value)} />
        <TextField label="Nama varian" required maxLength={200} value={value.name} disabled={disabled} onChange={(e) => set("name", e.target.value)} />
        <NumberField label="Harga (IDR)" required min={0} max={1_000_000_000} value={value.price} disabled={disabled} onValueChange={(v) => set("price", v as T["price"])} />
        <NumberField label="Berat (gram)" required min={1} max={1_000_000} value={value.weight} disabled={disabled} onValueChange={(v) => set("weight", v as T["weight"])} />
        <Field label="Mode penjualan">
          {(id) => (
            <NativeSelect id={id} className="w-full" value={value.mode} disabled={disabled} onChange={(e) => set("mode", e.target.value as T["mode"])}>
              <NativeSelectOption value="stock">{variantMode.stock}</NativeSelectOption>
              <NativeSelectOption value="preorder">{variantMode.preorder}</NativeSelectOption>
            </NativeSelect>
          )}
        </Field>
        {"stock" in value && (
          <NumberField label="Stok awal" min={0} max={1_000_000} value={value.stock ?? null} disabled={disabled} onValueChange={(v) => set("stock", v as T["stock"])} />
        )}
      </div>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Batas pembelian</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <NumberField label="Maks. per pesanan" hint="Kosong = tanpa batas" min={1} max={1_000_000} value={value.maxPerOrder} disabled={disabled} onValueChange={(v) => set("maxPerOrder", v as T["maxPerOrder"])} />
          <NumberField label="Maks. per pelanggan" hint="Kosong = tanpa batas" min={1} max={1_000_000} value={value.maxPerCustomer} disabled={disabled} onValueChange={(v) => set("maxPerCustomer", v as T["maxPerCustomer"])} />
          <NumberField label="Ambang stok menipis" hint="Kosong = default toko" min={0} max={1_000_000} value={value.lowStockThreshold} disabled={disabled} onValueChange={(v) => set("lowStockThreshold", v as T["lowStockThreshold"])} />
        </div>
      </fieldset>
      <fieldset className="grid gap-3">
        <legend className="mb-1 text-sm font-medium">Dimensi paket (cm, untuk berat volumetrik)</legend>
        <div className="grid grid-cols-3 gap-3">
          <NumberField label="Panjang" min={1} max={300} value={value.lengthCm} disabled={disabled} onValueChange={(v) => set("lengthCm", v as T["lengthCm"])} />
          <NumberField label="Lebar" min={1} max={300} value={value.widthCm} disabled={disabled} onValueChange={(v) => set("widthCm", v as T["widthCm"])} />
          <NumberField label="Tinggi" min={1} max={300} value={value.heightCm} disabled={disabled} onValueChange={(v) => set("heightCm", v as T["heightCm"])} />
        </div>
      </fieldset>
      {"active" in value && value.active !== undefined && (
        <Label className="font-normal">
          <Checkbox checked={!!value.active} disabled={disabled} onCheckedChange={(checked) => set("active", (checked === true) as T["active"])} />
          Varian aktif dan dapat dibeli
        </Label>
      )}
    </div>
  );
}

function SeoPreview({ slug, name, description }: { slug: string; name: string; description: string }) {
  const text = description.trim().replace(/\s+/g, " ");
  return (
    <div className="grid gap-1 rounded-lg border p-3">
      <span className="truncate text-xs text-muted-foreground">
        {location.origin}/products/{slug || "slug-produk"}
      </span>
      <span className="truncate text-base font-medium text-blue-700">{name || "Nama produk"}</span>
      <span className="line-clamp-2 text-sm text-muted-foreground">{text ? (text.length > 160 ? `${text.slice(0, 157)}…` : text) : "Deskripsi produk akan tampil di hasil pencarian."}</span>
    </div>
  );
}

function GeneralCard({
  draft,
  onChange,
  categories,
  disabled,
}: {
  draft: ProductDraft;
  onChange: (next: ProductDraft) => void;
  categories: Category[];
  disabled?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Umum</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        <TextField label="Nama produk" required maxLength={200} value={draft.name} disabled={disabled} onChange={(e) => onChange({ ...draft, name: e.target.value })} />
        <TextField
          label="Slug URL"
          required
          maxLength={100}
          pattern={slugPattern}
          hint="Huruf kecil, angka, dan tanda hubung. Mengubah slug mengubah URL produk."
          value={draft.slug}
          disabled={disabled}
          onChange={(e) => onChange({ ...draft, slug: e.target.value })}
        />
        <Field label="Deskripsi">
          {(id) => <Textarea id={id} rows={6} maxLength={10000} value={draft.description} disabled={disabled} onChange={(e) => onChange({ ...draft, description: e.target.value })} />}
        </Field>
        <Field label="Kategori">
          {(id) => (
            <NativeSelect id={id} className="w-full" value={draft.categoryId ?? ""} disabled={disabled} onChange={(e) => onChange({ ...draft, categoryId: e.target.value || null })}>
              <NativeSelectOption value="">Tanpa kategori</NativeSelectOption>
              {categories.map((c) => (
                <NativeSelectOption key={c.id} value={c.id}>
                  {c.name}
                  {c.active ? "" : " (nonaktif)"}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          )}
        </Field>
      </CardContent>
    </Card>
  );
}

function MediaCard({
  productId,
  current,
  onImage,
  onPending,
  disabled,
}: {
  productId?: string;
  current: string | null;
  onImage: (url: string) => void;
  onPending: (pending: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Media</CardTitle>
        <CardDescription>Foto utama produk.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {current ? (
          <img src={current} alt="Foto utama saat ini" className="h-40 w-full rounded-md border object-contain" />
        ) : (
          <div className="flex h-24 items-center justify-center gap-2 rounded-md border border-dashed text-sm text-muted-foreground">
            <ImageIcon className="size-4" />
            Belum ada foto
          </div>
        )}
        <PhotoUpload productId={productId} onImage={onImage} onPending={onPending} disabled={disabled} />
      </CardContent>
    </Card>
  );
}

function SaveBar({ dirty, saving, blocked, onDiscard, form }: { dirty: boolean; saving: boolean; blocked: boolean; onDiscard: () => void; form: string }) {
  if (!dirty && !saving) return null;
  return (
    <div role="region" aria-label="Perubahan belum disimpan" className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center gap-2 border-t bg-background p-3 md:-mx-6 lg:-mx-8 print:hidden">
      <span className="text-sm font-medium">{saving ? "Menyimpan perubahan…" : "Perubahan belum disimpan"}</span>
      <div className="ml-auto flex gap-2">
        <Button type="button" variant="outline" disabled={saving} onClick={onDiscard}>
          Buang
        </Button>
        <Button form={form} disabled={saving || blocked}>
          {saving ? "Menyimpan…" : "Simpan"}
        </Button>
      </div>
    </div>
  );
}

function useCategories() {
  return useResource<{ categories: Category[] }>("/api/admin/categories").data?.categories ?? [];
}

function NewProductEditor() {
  const { navigate } = useRoute();
  const categories = useCategories();
  const empty: ProductDraft = { slug: "", name: "", description: "", categoryId: null, imageUrl: null };
  const [draft, setDraft] = useState<ProductDraft>(empty);
  const [variants, setVariants] = useState<NewVariant[]>(() => [blankVariant()]);
  const [editing, setEditing] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const dirty = !!(draft.name || draft.slug || draft.description || draft.imageUrl || variants.some((v) => v.sku || v.price != null));
  useNavigationGuard(dirty);
  const create = useMutation(
    () => {
      const { imageUrl, categoryId, ...rest } = draft;
      return post<{ product: Product }>("/api/admin/products", {
        ...rest,
        ...(imageUrl ? { imageUrl } : {}),
        ...(categoryId ? { categoryId } : {}),
        variants: variants.map(({ key, stock, ...v }) => ({ ...v, stock: stock ?? 0 })),
      });
    },
    { key: "product-create", success: "Produk dibuat.", onSuccess: (result) => navigate(href("product-edit", { id: result.product.id }), true, true) },
  );
  const editingVariant = variants.find((v) => v.key === editing);
  return (
    <>
      <div className="print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to={href("products")}>
            <ArrowLeft />
            Produk
          </Link>
        </Button>
      </div>
      <PageHeader title="Tambah produk" description="Produk baru langsung aktif setelah disimpan." />
      <form
        id="product-form"
        className="grid items-start gap-6 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void create.mutate(undefined);
        }}
      >
        <div className="grid gap-6 lg:col-span-2">
          <GeneralCard draft={draft} onChange={setDraft} categories={categories} disabled={create.pending} />
          <Card>
            <CardHeader>
              <CardTitle>Varian</CardTitle>
              <CardDescription>Setiap produk memiliki 1–{MAX_VARIANTS} varian (SKU).</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>
                        SKU<RequiredMark />
                      </TableHead>
                      <TableHead>
                        Nama<RequiredMark />
                      </TableHead>
                      <TableHead>
                        Harga<RequiredMark />
                      </TableHead>
                      <TableHead>Stok awal</TableHead>
                      <TableHead>
                        <span className="sr-only">Aksi</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {variants.map((v, i) => {
                      const update = (next: Partial<NewVariant>) => setVariants((list) => list.map((row) => (row.key === v.key ? { ...row, ...next } : row)));
                      return (
                        <TableRow key={v.key}>
                          <TableCell>
                            <Input aria-label={`SKU varian ${i + 1}`} required maxLength={100} className="min-w-28" value={v.sku} onChange={(e) => update({ sku: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Input aria-label={`Nama varian ${i + 1}`} required maxLength={200} className="min-w-28" value={v.name} onChange={(e) => update({ name: e.target.value })} />
                          </TableCell>
                          <TableCell>
                            <Input
                              aria-label={`Harga varian ${i + 1}`}
                              type="number"
                              required
                              min={0}
                              className="min-w-24"
                              value={v.price ?? ""}
                              onChange={(e) => update({ price: e.target.value === "" ? null : Number(e.target.value) })}
                            />
                          </TableCell>
                          <TableCell>
                            <Input
                              aria-label={`Stok awal varian ${i + 1}`}
                              type="number"
                              min={0}
                              className="min-w-20"
                              value={v.stock ?? ""}
                              onChange={(e) => update({ stock: e.target.value === "" ? null : Number(e.target.value) })}
                            />
                          </TableCell>
                          <TableCell className="whitespace-nowrap text-right">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(v.key)}>
                              <Pencil />
                              Detail
                              {v.weight == null && <span className="sr-only"> (berat belum diisi)</span>}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              aria-label={`Hapus varian ${i + 1}`}
                              disabled={variants.length === 1}
                              onClick={() => setVariants((list) => list.filter((row) => row.key !== v.key))}
                            >
                              <Trash2 />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              {variants.some((v) => v.weight == null) && <p className="text-sm text-muted-foreground">Isi berat setiap varian lewat tombol Detail.</p>}
              <Button
                type="button"
                variant="outline"
                className="justify-self-start"
                disabled={variants.length >= MAX_VARIANTS}
                onClick={() => setVariants((list) => [...list, blankVariant()])}
              >
                <Plus />
                Tambah varian
              </Button>
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6">
          <MediaCard current={draft.imageUrl} onImage={(url) => setDraft((d) => ({ ...d, imageUrl: url || null }))} onPending={setUploading} disabled={create.pending} />
          <Card>
            <CardHeader>
              <CardTitle>Pratinjau pencarian</CardTitle>
            </CardHeader>
            <CardContent>
              <SeoPreview {...draft} />
            </CardContent>
          </Card>
        </div>
      </form>
      <Sheet open={!!editingVariant} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Detail varian</SheetTitle>
            <SheetDescription>Disimpan bersama produk.</SheetDescription>
          </SheetHeader>
          {editingVariant && (
            <div className="px-4">
              <VariantFields value={editingVariant} onChange={(next) => setVariants((list) => list.map((row) => (row.key === next.key ? next : row)))} />
            </div>
          )}
          <SheetFooter>
            <Button onClick={() => setEditing(null)}>Selesai</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <SaveBar
        form="product-form"
        dirty={dirty}
        saving={create.pending}
        blocked={uploading || variants.some((v) => v.weight == null || v.price == null)}
        onDiscard={() => {
          setDraft(empty);
          setVariants([blankVariant()]);
        }}
      />
    </>
  );
}

function AddVariantDialog({ product, open, onOpenChange, onAdded }: { product: Product; open: boolean; onOpenChange: (open: boolean) => void; onAdded: (variant: Variant) => void }) {
  const [value, setValue] = useState<NewVariant>(blankVariant);
  const add = useMutation(
    () => {
      const { key, stock, ...rest } = value;
      return post<{ variant: Variant }>(`/api/admin/products/${encodeURIComponent(product.id)}/variants`, { ...rest, stock: stock ?? 0 });
    },
    {
      key: `variant-add:${product.id}`,
      success: "Varian ditambahkan.",
      onSuccess: (result) => {
        onAdded(result.variant);
        setValue(blankVariant());
        onOpenChange(false);
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Tambah varian</DialogTitle>
          <DialogDescription>Varian langsung tersimpan dan aktif. Stok awal tercatat di ledger inventori.</DialogDescription>
        </DialogHeader>
        <form
          id="add-variant-form"
          onSubmit={(e) => {
            e.preventDefault();
            void add.mutate(undefined);
          }}
        >
          <VariantFields value={value} onChange={setValue} disabled={add.pending} />
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button form="add-variant-form" disabled={add.pending}>
            {add.pending ? "Menyimpan…" : "Tambah varian"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ExistingProductEditor({ id }: { id: string }) {
  const resource = useResource<{ product: Product }>(`/api/admin/products/${encodeURIComponent(id)}`);
  const categories = useCategories();
  const [product, setProduct] = useState<Product | null>(null);
  const [draft, setDraft] = useState<ProductDraft | null>(null);
  const [variantDrafts, setVariantDrafts] = useState<Record<string, VariantDraft>>({});
  const [editing, setEditing] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [photoKey, setPhotoKey] = useState(0);

  const adopt = (next: Product) => {
    setProduct(next);
    setDraft(productDraft(next));
    setVariantDrafts(Object.fromEntries(next.variants.map((v) => [v.id, variantDraft(v)])));
    setPhotoKey((k) => k + 1);
  };
  useEffect(() => {
    if (resource.data) {
      adopt(resource.data.product);
      setConflict(false);
    }
  }, [resource.data]);

  const productChanges = useMemo(() => (product && draft ? changedFields(productDraft(product), draft, productKeys) : {}), [product, draft]);
  const variantChanges = useMemo(
    () =>
      product
        ? product.variants
            .map((v) => ({ variant: v, changes: variantDrafts[v.id] ? changedFields(variantDraft(v), variantDrafts[v.id], variantKeys) : {} }))
            .filter((entry) => Object.keys(entry.changes).length)
        : [],
    [product, variantDrafts],
  );
  const dirty = Object.keys(productChanges).length > 0 || variantChanges.length > 0;
  useNavigationGuard(dirty);

  const save = useMutation(
    async () => {
      if (!product) return;
      let current = product;
      // Each confirmed write is adopted immediately, so a later conflict never discards an earlier success.
      if (Object.keys(productChanges).length) {
        const result = await patch<{ product: Omit<Product, "variants" | "category"> }>(`/api/admin/products/${encodeURIComponent(product.id)}`, {
          ...productChanges,
          version: current.version,
        });
        current = { ...current, ...result.product };
        const saved = current;
        setProduct(saved);
        setDraft((d) => (d ? { ...d, ...productDraft(saved) } : d));
      }
      for (const { variant, changes } of variantChanges) {
        const result = await patch<{ variant: Variant }>(`/api/admin/variants/${encodeURIComponent(variant.id)}`, { ...changes, version: variant.version });
        const saved = withAvailable({ ...variant, ...result.variant });
        current = { ...current, variants: current.variants.map((v) => (v.id === saved.id ? saved : v)) };
        const snapshot = current;
        setProduct(snapshot);
        setVariantDrafts((drafts) => ({ ...drafts, [saved.id]: variantDraft(saved) }));
      }
      setPhotoKey((k) => k + 1);
    },
    { key: `product-save:${id}`, success: "Produk tersimpan.", onConflict: () => setConflict(true) },
  );

  const toggleActive = useMutation(
    (active: boolean) => patch<{ product: Omit<Product, "variants" | "category"> }>(`/api/admin/products/${encodeURIComponent(id)}`, { active, version: product!.version }),
    {
      key: `product-save:${id}`,
      success: (result) => (result.product.active ? "Produk diaktifkan." : "Produk diarsipkan."),
      onSuccess: (result) => setProduct((p) => (p ? { ...p, ...result.product } : p)),
      onConflict: () => setConflict(true),
    },
  );

  if (!product || !draft) {
    return (
      <>
        <PageHeader title="Produk" />
        {resource.error ? (
          <LoadError message={resource.error} onRetry={() => void resource.reload()} />
        ) : (
          <div className="grid gap-6 lg:grid-cols-3" role="status" aria-label="Memuat produk">
            <Skeleton className="h-80 lg:col-span-2" />
            <Skeleton className="h-80" />
          </div>
        )}
      </>
    );
  }

  const busy = save.pending || toggleActive.pending;
  const editingVariant = product.variants.find((v) => v.id === editing);
  return (
    <>
      <div className="print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to={href("products")}>
            <ArrowLeft />
            Produk
          </Link>
        </Button>
      </div>
      <PageHeader
        title={product.name}
        description={`/${product.slug}`}
        actions={
          <>
            {product.active ? <Badge>Aktif</Badge> : <Badge variant="outline">Diarsipkan</Badge>}
            {product.active ? (
              <ConfirmDialog
                trigger={
                  <Button variant="outline" disabled={busy}>
                    <Archive />
                    Arsipkan
                  </Button>
                }
                title="Arsipkan produk?"
                description="Produk disembunyikan dari toko. Pesanan yang sudah ada tidak berubah. Kamu bisa mengaktifkannya lagi kapan saja."
                confirmLabel="Arsipkan"
                onConfirm={() => void toggleActive.mutate(false)}
              />
            ) : (
              <Button variant="outline" disabled={busy} onClick={() => void toggleActive.mutate(true)}>
                <RotateCcw />
                Aktifkan
              </Button>
            )}
          </>
        }
      />
      {conflict && <ConflictBanner onReload={() => void resource.reload()} />}
      <form
        id="product-form"
        className="grid items-start gap-6 lg:grid-cols-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save.mutate(undefined);
        }}
      >
        <div className="grid gap-6 lg:col-span-2">
          <GeneralCard draft={draft} onChange={setDraft} categories={categories} disabled={busy} />
          <Card>
            <CardHeader>
              <CardTitle>Varian</CardTitle>
              <CardDescription>
                {product.variants.length} dari maksimal {MAX_VARIANTS} varian. Stok diubah dari halaman Inventori.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Varian</TableHead>
                      <TableHead>
                        Harga<RequiredMark />
                      </TableHead>
                      <TableHead>Mode</TableHead>
                      <TableHead className="text-right">Tersedia</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>
                        <span className="sr-only">Aksi</span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {product.variants.map((v) => {
                      const d = variantDrafts[v.id] ?? variantDraft(v);
                      const changed = variantChanges.some((entry) => entry.variant.id === v.id);
                      return (
                        <TableRow key={v.id} data-state={changed ? "selected" : undefined}>
                          <TableCell className="whitespace-normal">
                            <div className="font-medium">{d.name}</div>
                            <div className="text-xs text-muted-foreground">{d.sku}</div>
                          </TableCell>
                          <TableCell>
                            <Input
                              aria-label={`Harga ${d.sku}`}
                              type="number"
                              min={0}
                              required
                              className="w-28"
                              disabled={busy}
                              value={d.price ?? ""}
                              onChange={(e) => setVariantDrafts((all) => ({ ...all, [v.id]: { ...d, price: e.target.value === "" ? null : Number(e.target.value) } }))}
                            />
                          </TableCell>
                          <TableCell>{variantMode[d.mode]}</TableCell>
                          <TableCell className="text-right tabular-nums">
                            {v.mode === "stock" ? number(v.available ?? 0) : v.campaign ? (v.campaign.quota == null ? "Tanpa kuota" : number(v.campaign.available ?? 0)) : "—"}
                          </TableCell>
                          <TableCell>{d.active ? <Badge variant="secondary">Aktif</Badge> : <Badge variant="outline">Nonaktif</Badge>}</TableCell>
                          <TableCell className="text-right">
                            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(v.id)}>
                              <Pencil />
                              Edit<span className="sr-only"> {d.sku}</span>
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <Button type="button" variant="outline" className="justify-self-start" disabled={busy || product.variants.length >= MAX_VARIANTS} onClick={() => setAddOpen(true)}>
                <Plus />
                Tambah varian
              </Button>
              {product.variants.length >= MAX_VARIANTS && <p className="text-sm text-muted-foreground">Batas {MAX_VARIANTS} varian tercapai.</p>}
            </CardContent>
          </Card>
        </div>
        <div className="grid gap-6">
          <MediaCard
            key={photoKey}
            productId={product.id}
            current={draft.imageUrl}
            onImage={(url) => setDraft((d) => (d ? { ...d, imageUrl: url || product.imageUrl } : d))}
            onPending={setUploading}
            disabled={busy}
          />
          <Card>
            <CardHeader>
              <CardTitle>Pratinjau pencarian</CardTitle>
            </CardHeader>
            <CardContent>
              <SeoPreview {...draft} />
            </CardContent>
          </Card>
        </div>
      </form>
      <Sheet open={!!editingVariant} onOpenChange={(open) => !open && setEditing(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          <SheetHeader>
            <SheetTitle>Edit varian {editingVariant?.sku}</SheetTitle>
            <SheetDescription>Perubahan disimpan bersama produk lewat tombol Simpan.</SheetDescription>
          </SheetHeader>
          {editingVariant && (
            <div className="grid gap-4 px-4">
              <VariantFields
                value={variantDrafts[editingVariant.id] ?? variantDraft(editingVariant)}
                disabled={busy}
                onChange={(next) => setVariantDrafts((all) => ({ ...all, [editingVariant.id]: next }))}
              />
              <p className="text-sm text-muted-foreground">
                Stok: {number(editingVariant.onHand)} fisik, {number(editingVariant.reserved)} direservasi. Harga {money(editingVariant.price)} saat ini.
              </p>
            </div>
          )}
          <SheetFooter>
            <Button onClick={() => setEditing(null)}>Selesai</Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
      <AddVariantDialog
        product={product}
        open={addOpen}
        onOpenChange={setAddOpen}
        onAdded={(variant) => {
          const added = withAvailable(variant);
          setProduct((p) => (p ? { ...p, variants: [...p.variants, added] } : p));
          setVariantDrafts((all) => ({ ...all, [added.id]: variantDraft(added) }));
        }}
      />
      <SaveBar
        form="product-form"
        dirty={dirty}
        saving={save.pending}
        blocked={uploading || conflict}
        onDiscard={() => {
          setDraft(productDraft(product));
          setVariantDrafts(Object.fromEntries(product.variants.map((v) => [v.id, variantDraft(v)])));
          setPhotoKey((k) => k + 1);
        }}
      />
    </>
  );
}

export function ProductEditorPage() {
  const { route } = useRoute();
  return route.name === "product-new" ? <NewProductEditor /> : <ExistingProductEditor key={route.params.id} id={route.params.id} />;
}

