import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { del, post } from "@/lib/api";
import { blocklistKind, label, normalizePhone, timeWIB } from "@/lib/format";
import { useRoute, href } from "@/lib/router";
import type { BlocklistEntry } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, LoadError, TextField } from "@/components/field";
import { LoadMoreButton } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { TableCell, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";

/** Shows what the server will hash, so a typo is visible before blocking. */
export function phoneHint(value: string) {
  if (!value.trim()) return "Format 08…, 628…, atau +628…";
  const normalized = normalizePhone(value);
  return normalized ? `Disimpan sebagai ${normalized}` : "Bukan nomor HP Indonesia yang valid (08…, 628…, atau +628…).";
}

const kindTabs = [
  ["all", "Semua"],
  ["email", "Email"],
  ["phone", "HP"],
  ["ip", "IP"],
] as const;

function AddDialog({ open, onOpenChange, onAdded }: { open: boolean; onOpenChange: (open: boolean) => void; onAdded: (entry: BlocklistEntry, created: boolean) => void }) {
  const [kind, setKind] = useState<BlocklistEntry["kind"]>("email");
  const [value, setValue] = useState("");
  const [reason, setReason] = useState("");
  const add = useMutation(() => post<{ created: boolean; entry: BlocklistEntry }>("/api/admin/blocklist", { kind, value: value.trim(), reason: reason.trim() }), {
    key: "blocklist-add",
    success: (result) => (result.created ? "Ditambahkan ke blocklist." : "Identitas ini sudah ada di blocklist."),
    onSuccess: (result) => {
      onAdded(result.entry, result.created);
      setValue("");
      setReason("");
      onOpenChange(false);
    },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Tambah ke blocklist</DialogTitle>
          <DialogDescription>Checkout dengan identitas ini ditolak. Nilai asli tidak disimpan, hanya hash-nya.</DialogDescription>
        </DialogHeader>
        <form
          id="blocklist-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void add.mutate(undefined);
          }}
        >
          <Field label="Jenis">
            {(id) => (
              <NativeSelect id={id} className="w-full" value={kind} onChange={(e) => setKind(e.target.value as BlocklistEntry["kind"])}>
                {Object.entries(blocklistKind).map(([value, text]) => (
                  <NativeSelectOption key={value} value={value}>
                    {text}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            )}
          </Field>
          <TextField
            label={label(blocklistKind, kind)}
            required
            maxLength={254}
            type={kind === "email" ? "email" : "text"}
            inputMode={kind === "phone" ? "tel" : undefined}
            hint={kind === "phone" ? phoneHint(value) : undefined}
            value={value}
            onChange={(e) => setValue(e.target.value)}
          />
          <Field label="Alasan" required>{(id) => <Textarea id={id} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button form="blocklist-form" variant="destructive" disabled={add.pending || !value.trim() || !reason.trim()}>
            {add.pending ? "Menyimpan…" : "Blokir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RemoveEntry({ entry, onRemoved }: { entry: BlocklistEntry; onRemoved: () => void }) {
  const remove = useMutation(() => del(`/api/admin/blocklist/${encodeURIComponent(entry.id)}`), { key: `blocklist-remove:${entry.id}`, success: "Dihapus dari blocklist.", onSuccess: onRemoved });
  return (
    <ConfirmDialog
      trigger={
        <Button variant="ghost" size="sm" disabled={remove.pending}>
          <Trash2 />
          Hapus
        </Button>
      }
      title="Hapus dari blocklist?"
      description="Identitas ini dapat checkout kembali."
      confirmLabel="Hapus"
      onConfirm={() => void remove.mutate(undefined)}
    />
  );
}

export function BlocklistPage() {
  const { route, navigate } = useRoute();
  const kind = (kindTabs.find(([value]) => value === route.query.get("kind"))?.[0] ?? "all") as (typeof kindTabs)[number][0];
  const list = usePagedList<BlocklistEntry>("/api/admin/blocklist", { listKey: "items", cursor: "keyset" });
  const [open, setOpen] = useState(false);
  // The blocklist API has no kind filter; the tab narrows the pages already loaded.
  const rows = kind === "all" ? list.items : list.items.filter((entry) => entry.kind === kind);
  return (
    <>
      <PageHeader
        title="Blocklist"
        description="Email, nomor HP, atau alamat IP yang ditolak saat checkout."
        actions={
          <Button onClick={() => setOpen(true)}>
            <Plus />
            Tambah
          </Button>
        }
      />
      <Tabs value={kind} onValueChange={(value) => navigate(href("blocklist", {}, value === "all" ? {} : { kind: value }), true)}>
        <TabsList aria-label="Filter jenis identitas">
          {kindTabs.map(([value, text]) => (
            <TabsTrigger key={value} value={value}>
              {text}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[{ head: "Jenis" }, { head: "Alasan" }, { head: "Oleh", mobileHidden: true }, { head: "Ditambahkan (WIB)", mobileHidden: true }, { head: <span className="sr-only">Aksi</span> }]}
        empty={
          kind === "all"
            ? { title: "Blocklist kosong", description: "Blokir identitas dari detail pesanan atau tambahkan manual." }
            : { title: `Tidak ada entri ${label(blocklistKind, kind)} di halaman yang dimuat` }
        }
      >
        {rows.map((entry) => (
          <TableRow key={entry.id}>
            <TableCell>
              <Badge variant="outline">{label(blocklistKind, entry.kind)}</Badge>
            </TableCell>
            <TableCell className="whitespace-normal">{entry.reason}</TableCell>
            <TableCell className="max-w-32 truncate text-xs text-muted-foreground" title={entry.actor}>
              {entry.actor}
            </TableCell>
            <TableCell className="text-xs whitespace-nowrap">{timeWIB(entry.createdAt)}</TableCell>
            <TableCell className="text-right">
              <RemoveEntry entry={entry} onRemoved={() => list.setItems((items) => items.filter((e) => e.id !== entry.id))} />
            </TableCell>
          </TableRow>
        ))}
      </DataTable>
      {list.cursor && (
        <LoadMoreButton loading={list.loadingMore} onClick={list.loadMore} />
      )}
      <AddDialog open={open} onOpenChange={setOpen} onAdded={(entry, created) => created && list.setItems((items) => [entry, ...items])} />
    </>
  );
}
