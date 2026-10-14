import { useState } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { del, patch, post } from "@/lib/api";
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

type Draft = { slug: string; name: string; position: number | null; active: boolean };
const keys = ["slug", "name", "position", "active"] as const;
const draftOf = (c: Category): Draft => ({ slug: c.slug, name: c.name, position: c.position, active: c.active });

function CategoryDialog({ category, open, onOpenChange, onSaved }: { category: Category | null; open: boolean; onOpenChange: (open: boolean) => void; onSaved: (c: Category) => void }) {
  const [base, setBase] = useState(category);
  const [draft, setDraft] = useState<Draft>(category ? draftOf(category) : { slug: "", name: "", position: 0, active: true });
  const [conflict, setConflict] = useState<Category | null>(null);
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
          <TextField label="Nama" required maxLength={100} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          <TextField label="Slug" required maxLength={100} pattern="[a-z0-9]+(-[a-z0-9]+)*" value={draft.slug} onChange={(e) => setDraft({ ...draft, slug: e.target.value })} />
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
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="icon-sm" aria-label={`Hapus ${category.name}`} disabled={remove.pending}>
          <Trash2 />
        </Button>
      }
      title={`Hapus kategori ${category.name}?`}
      description="Kategori yang masih dipakai produk tidak dapat dihapus."
      confirmLabel="Hapus"
      onConfirm={() => void remove.mutate(undefined)}
    />
  );
}

export function CategoriesPage() {
  const resource = useResource<{ categories: Category[] }>("/api/admin/categories");
  const [dialog, setDialog] = useState<{ category: Category | null; key: number } | null>(null);
  const categories = resource.data?.categories ?? [];
  const update = (change: (list: Category[]) => Category[]) =>
    resource.setData((data) => ({ categories: change(data?.categories ?? []).sort((a, b) => a.position - b.position || a.slug.localeCompare(b.slug)) }));
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
        columns={[{ head: "Posisi", className: "w-20" }, { head: "Nama" }, { head: "Slug" }, { head: "Status" }, { head: <span className="sr-only">Aksi</span> }]}
        empty={{ title: "Belum ada kategori" }}
      >
        {categories.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="tabular-nums">{c.position}</TableCell>
            <TableCell className="font-medium">{c.name}</TableCell>
            <TableCell className="text-muted-foreground">{c.slug}</TableCell>
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
          onSaved={(saved) => update((list) => (list.some((c) => c.id === saved.id) ? list.map((c) => (c.id === saved.id ? saved : c)) : [...list, saved]))}
        />
      )}
    </>
  );
}
