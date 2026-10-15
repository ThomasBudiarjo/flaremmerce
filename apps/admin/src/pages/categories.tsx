import { useState } from "react";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from "lucide-react";
import { del, patch, post } from "@/lib/api";
import { slugify } from "@/lib/format";
import { href, Link } from "@/lib/router";
import type { Category } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { useResource } from "@/hooks/use-resource";
import { changedFields } from "@/pages/product-editor";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ConflictBanner } from "@/components/conflict-banner";
import { LoadError, NumberField, TextField } from "@/components/field";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

type Draft = { slug: string; name: string; position: number | null; active: boolean };
const keys = ["slug", "name", "position", "active"] as const;
const draftOf = (c: Category): Draft => ({ slug: c.slug, name: c.name, position: c.position, active: c.active });

function CategoryDialog({ category, open, onOpenChange, onSaved }: { category: Category | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (c: Category) => void }) {
  const [base, setBase] = useState(category);
  const [draft, setDraft] = useState<Draft>(category ? draftOf(category) : { slug: "", name: "", position: 0, active: true });
  const [conflict, setConflict] = useState<Category | null>(null);
  const [slugEdited, setSlugEdited] = useState(!!category);
  const changes = base ? changedFields(draftOf(base), draft, keys) : {};
  const save = useMutation(
    async () =>
      base
        ? (await patch<{ category: Category }>(`/api/admin/categories/${encodeURIComponent(base.id)}`, { ...changes, version: base.version })).category
        : (await post<{ category: Category }>("/api/admin/categories", { ...draft, position: draft.position ?? 0 })).category,
    {
      key: `category:${category?.id ?? "new"}`,
      success: base ? "Kategori tersimpan." : "Kategori dibuat.",
      onSuccess: (saved) => {
        onSaved(saved);
        onOpenChange(false);
      },
      onConflict: (current) => setConflict(current as Category),
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{base ? "Edit kategori" : "Kategori baru"}</DialogTitle>
          <DialogDescription>Kategori aktif tampil sebagai filter di katalog toko, diurutkan menurut posisi.</DialogDescription>
        </DialogHeader>
        {conflict && (
          <ConflictBanner
            onReload={() => {
              setBase(conflict);
              setDraft(draftOf(conflict));
              onSaved(conflict);
              setConflict(null);
            }}
          />
        )}
        <form
          id="category-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save.mutate(undefined);
          }}
        >
          <TextField
            label="Nama"
            required
            maxLength={100}
            value={draft.name}
            onChange={(e) => setDraft({ ...draft, name: e.target.value, ...(slugEdited ? {} : { slug: slugify(e.target.value) }) })}
          />
          <TextField
            label="Slug"
            required
            maxLength={100}
            pattern="[a-z0-9]+(-[a-z0-9]+)*"
            hint={slugEdited ? undefined : "Dibuat otomatis dari nama sampai kamu mengubahnya."}
            value={draft.slug}
            onChange={(e) => {
              setSlugEdited(true);
              setDraft({ ...draft, slug: e.target.value });
            }}
          />
          <NumberField label="Posisi" hint="Angka kecil tampil lebih dulu." min={0} max={100_000} value={draft.position} onValueChange={(position) => setDraft({ ...draft, position })} />
          <Label className="font-normal">
            <Checkbox checked={draft.active} onCheckedChange={(checked) => setDraft({ ...draft, active: checked === true })} />
            Tampilkan di toko
          </Label>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button form="category-form" disabled={save.pending || !!conflict || (!!base && !Object.keys(changes).length)}>
            {save.pending ? "Menyimpan…" : "Simpan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteCategory({ category, onDeleted }: { category: Category; onDeleted: () => void }) {
  const remove = useMutation(() => del(`/api/admin/categories/${encodeURIComponent(category.id)}`), {
    key: `category-delete:${category.id}`,
    success: "Kategori dihapus.",
    onSuccess: onDeleted,
  });
  if (category.productCount) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          {/* A disabled button gets no pointer events; the wrapper keeps the tooltip reachable. */}
          <span tabIndex={0} className="inline-flex" aria-label={`${category.name} tidak dapat dihapus: masih dipakai ${category.productCount} produk`}>
            <Button variant="ghost" size="icon-sm" disabled aria-hidden="true" tabIndex={-1}>
              <Trash2 />
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>Masih dipakai {category.productCount} produk. Pindahkan produknya terlebih dahulu.</TooltipContent>
      </Tooltip>
    );
  }
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Hapus ${category.name}`} disabled={remove.pending}>
          <Trash2 />
        </Button>
      }
      title={`Hapus kategori ${category.name}?`}
      description="Kategori ini tidak dipakai produk mana pun."
      confirmLabel="Hapus"
      onConfirm={() => void remove.mutate(undefined)}
    />
  );
}

/**
 * Position changes that move `categories[index]` one step in `direction`. Distinct neighbours just
 * swap positions; ties (sorted by slug) are spread into increasing positions in the new order.
 */
export function moveChanges(categories: Category[], index: number, direction: -1 | 1) {
  const other = index + direction;
  const a = categories[index], b = categories[other];
  if (!a || !b) return [];
  if (a.position !== b.position) return [{ category: a, position: b.position }, { category: b, position: a.position }];
  const order = [...categories];
  [order[index], order[other]] = [order[other], order[index]];
  const changes: { category: Category; position: number }[] = [];
  let previous = -1;
  for (const category of order) {
    const position = Math.max(category.position, previous + 1);
    if (position !== category.position) changes.push({ category, position });
    previous = position;
  }
  return changes;
}

const byPosition = (a: Category, b: Category) => a.position - b.position || a.slug.localeCompare(b.slug);

export function CategoriesPage() {
  const resource = useResource<{ categories: Category[] }>("/api/admin/categories");
  const [dialog, setDialog] = useState<{ category: Category | null; key: number } | null>(null);
  const categories = resource.data?.categories ?? [];
  const update = (change: (list: Category[]) => Category[]) => resource.setData((data) => ({ categories: change(data?.categories ?? []).sort(byPosition) }));
  const merge = (saved: Category) => update((list) => list.map((c) => (c.id === saved.id ? { ...saved, productCount: c.productCount } : c)));
  const move = useMutation(
    async (changes: { category: Category; position: number }[]) => {
      // Each write is compare-and-swap on its own version; a lost race stops the sequence and reloads.
      for (const { category, position } of changes) merge((await patch<{ category: Category }>(`/api/admin/categories/${encodeURIComponent(category.id)}`, { position, version: category.version })).category);
    },
    { key: "category-move", success: "Urutan kategori diperbarui.", onConflict: () => void resource.reload({ keep: true }), onError: () => void resource.reload({ keep: true }) },
  );
  return (
    <>
      <PageHeader
        title="Kategori"
        description="Kelompokkan produk untuk navigasi katalog."
        actions={
          <Button onClick={() => setDialog({ category: null, key: Date.now() })}>
            <Plus />
            Kategori baru
          </Button>
        }
      />
      {resource.error && <LoadError message={resource.error} onRetry={() => void resource.reload()} />}
      <DataTable
        loading={resource.loading}
        columns={[
          { head: "Urutan", className: "w-28" },
          { head: "Nama" },
          { head: "Slug", mobileHidden: true },
          { head: "Produk", className: "text-right" },
          { head: "Status", mobileHidden: true },
          { head: <span className="sr-only">Aksi</span> },
        ]}
        empty={{ title: "Belum ada kategori" }}
      >
        {categories.map((c, i) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-nowrap">
              <span className="inline-block w-8 text-muted-foreground tabular-nums">{c.position}</span>
              <Button variant="ghost" size="icon-xs" aria-label={`Naikkan ${c.name}`} disabled={i === 0 || move.pending} onClick={() => void move.mutate(moveChanges(categories, i, -1))}>
                <ArrowUp />
              </Button>
              <Button variant="ghost" size="icon-xs" aria-label={`Turunkan ${c.name}`} disabled={i === categories.length - 1 || move.pending} onClick={() => void move.mutate(moveChanges(categories, i, 1))}>
                <ArrowDown />
              </Button>
            </TableCell>
            <TableCell className="font-medium">
              <Link to={href("products", {}, { category: c.slug })} className="underline-offset-4 hover:underline" title="Lihat produk di kategori ini">
                {c.name}
              </Link>
            </TableCell>
            <TableCell className="text-muted-foreground">{c.slug}</TableCell>
            <TableCell className="text-right tabular-nums">{c.productCount ?? "—"}</TableCell>
            <TableCell>{c.active ? <Badge variant="secondary">Aktif</Badge> : <Badge variant="outline">Disembunyikan</Badge>}</TableCell>
            <TableCell className="text-right whitespace-nowrap">
              <Button variant="ghost" size="sm" onClick={() => setDialog({ category: c, key: Date.now() })}>
                <Pencil />
                Edit<span className="sr-only"> {c.name}</span>
              </Button>
              <DeleteCategory category={c} onDeleted={() => update((list) => list.filter((row) => row.id !== c.id))} />
            </TableCell>
          </TableRow>
        ))}
      </DataTable>
      {dialog && (
        <CategoryDialog
          key={dialog.key}
          category={dialog.category}
          open
          onOpenChange={(open) => !open && setDialog(null)}
          onSaved={(saved) =>
            update((list) => (list.some((c) => c.id === saved.id) ? list.map((c) => (c.id === saved.id ? { ...saved, productCount: c.productCount } : c)) : [...list, { ...saved, productCount: 0 }]))
          }
        />
      )}
    </>
  );
}
