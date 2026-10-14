import { useState } from "react";
import { Pencil, Plus } from "lucide-react";
import { patch, post } from "@/lib/api";
import { fromWibInput, number, timeWIB, wibInput } from "@/lib/format";
import type { Campaign, VariantSearchResult } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { ConflictBanner } from "@/components/conflict-banner";
import { LoadError, NumberField, TextField } from "@/components/field";
import { VariantPicker } from "@/components/variant-picker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { TableCell, TableRow } from "@/components/ui/table";

type Draft = { startsAt: string; endsAt: string; shipFrom: string; shipTo: string; quota: number | null; active: boolean };
const draftOf = (c: Campaign): Draft => ({ startsAt: wibInput(c.startsAt), endsAt: wibInput(c.endsAt), shipFrom: c.shipFrom, shipTo: c.shipTo, quota: c.quota, active: c.active });

function phase(c: Campaign, now = Date.now()) {
  if (!c.active) return <Badge variant="outline">Nonaktif</Badge>;
  if (now < c.startsAt) return <Badge variant="secondary">Akan datang</Badge>;
  if (now >= c.endsAt) return <Badge variant="outline">Berakhir</Badge>;
  return <Badge>Berjalan</Badge>;
}

/** Only edited fields: an untouched start/end keeps its stored seconds. */
export function campaignChanges(original: Campaign, draft: Draft) {
  const base = draftOf(original), out: Record<string, unknown> = {};
  if (draft.startsAt !== base.startsAt) out.startsAt = fromWibInput(draft.startsAt);
  if (draft.endsAt !== base.endsAt) out.endsAt = fromWibInput(draft.endsAt);
  for (const key of ["shipFrom", "shipTo", "quota", "active"] as const) if (draft[key] !== base[key]) out[key] = draft[key];
  return out;
}

function CampaignFields({ draft, onChange, disabled, editing }: { draft: Draft; onChange: (d: Draft) => void; disabled?: boolean; editing: boolean }) {
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Mulai (WIB)" type="datetime-local" required value={draft.startsAt} disabled={disabled} onChange={(e) => onChange({ ...draft, startsAt: e.target.value })} />
        <TextField label="Berakhir (WIB)" type="datetime-local" required value={draft.endsAt} disabled={disabled} onChange={(e) => onChange({ ...draft, endsAt: e.target.value })} />
        <TextField label="Estimasi kirim dari" type="date" required value={draft.shipFrom} disabled={disabled} onChange={(e) => onChange({ ...draft, shipFrom: e.target.value })} />
        <TextField label="Estimasi kirim sampai" type="date" required value={draft.shipTo} disabled={disabled} onChange={(e) => onChange({ ...draft, shipTo: e.target.value })} />
      </div>
      <NumberField label="Kuota" hint="Kosong = tanpa kuota. 0 menutup pemesanan baru." min={0} max={1_000_000} value={draft.quota} disabled={disabled} onValueChange={(quota) => onChange({ ...draft, quota })} />
      {editing && (
        <Label className="font-normal">
          <Checkbox checked={draft.active} disabled={disabled} onCheckedChange={(checked) => onChange({ ...draft, active: checked === true })} />
          Campaign aktif
        </Label>
      )}
      {editing && <p className="text-xs text-muted-foreground">Mengubah estimasi kirim menambah catatan di pesanan terkait; snapshot janji kirim pada pesanan tidak berubah.</p>}
    </div>
  );
}

function CampaignSheet({
  campaign,
  open,
  onOpenChange,
  onSaved,
}: {
  campaign: Campaign | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (campaign: Campaign, created: boolean) => void;
}) {
  const [base, setBase] = useState<Campaign | null>(campaign);
  const [draft, setDraft] = useState<Draft>(() => (campaign ? draftOf(campaign) : { startsAt: "", endsAt: "", shipFrom: "", shipTo: "", quota: null, active: true }));
  const [variant, setVariant] = useState<VariantSearchResult | null>(null);
  const [conflict, setConflict] = useState<Campaign | null>(null);
  const changes = base ? campaignChanges(base, draft) : {};
  const save = useMutation(
    async () => {
      if (base) return { campaign: (await patch<{ campaign: Campaign }>(`/api/admin/campaigns/${encodeURIComponent(base.id)}`, { ...changes, version: base.version })).campaign, created: false };
      const startsAt = fromWibInput(draft.startsAt), endsAt = fromWibInput(draft.endsAt);
      const result = await post<{ campaign: Campaign }>("/api/admin/campaigns", { variantId: variant?.id, startsAt, endsAt, shipFrom: draft.shipFrom, shipTo: draft.shipTo, quota: draft.quota });
      return { campaign: result.campaign, created: true };
    },
    {
      key: `campaign:${campaign?.id ?? "new"}`,
      success: (result) => (result.created ? "Campaign dibuat." : "Campaign tersimpan."),
      onSuccess: (result) => {
        onSaved(result.campaign, result.created);
        setBase(result.campaign);
        setDraft(draftOf(result.campaign));
        setConflict(null);
        onOpenChange(false);
      },
      onConflict: (current) => setConflict(current as Campaign),
    },
  );
  const valid = !!draft.startsAt && !!draft.endsAt && !!draft.shipFrom && !!draft.shipTo && (base ? Object.keys(changes).length > 0 : !!variant);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{base ? `Edit campaign ${base.sku}` : "Campaign pre-order baru"}</SheetTitle>
          <SheetDescription>{base ? base.productName : "Pilih varian pre-order aktif, lalu atur periode dan kuota."}</SheetDescription>
        </SheetHeader>
        <form
          id="campaign-form"
          className="grid gap-4 px-4"
          onSubmit={(e) => {
            e.preventDefault();
            void save.mutate(undefined);
          }}
        >
          {conflict && (
            <ConflictBanner
              onReload={() => {
                setBase(conflict);
                setDraft(draftOf(conflict));
                onSaved(conflict, false);
                setConflict(null);
              }}
            />
          )}
          {!base && <VariantPicker id="campaign-variant" label="Varian pre-order" mode="preorder" selected={variant} onSelect={setVariant} disabled={save.pending} />}
          <CampaignFields draft={draft} onChange={setDraft} disabled={save.pending} editing={!!base} />
        </form>
        <SheetFooter>
          <Button form="campaign-form" disabled={save.pending || !valid || !!conflict}>
            {save.pending ? "Menyimpan…" : base ? "Simpan perubahan" : "Buat campaign"}
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

export function PreordersPage() {
  const list = usePagedList<Campaign>("/api/admin/campaigns", { listKey: "campaigns", cursor: "keyset" });
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [open, setOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const openSheet = (campaign: Campaign | null) => {
    setEditing(campaign);
    setSheetKey((k) => k + 1);
    setOpen(true);
  };
  return (
    <>
      <PageHeader
        title="Pre-order"
        description="Periode, kuota, dan estimasi kirim campaign pre-order."
        actions={
          <Button onClick={() => openSheet(null)}>
            <Plus />
            Campaign baru
          </Button>
        }
      />
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[{ head: "Varian" }, { head: "Periode (WIB)" }, { head: "Estimasi kirim" }, { head: "Terpakai / kuota", className: "text-right" }, { head: "Status" }, { head: <span className="sr-only">Aksi</span> }]}
        empty={{ title: "Belum ada campaign", description: "Buat campaign untuk membuka pre-order pada varian mode pre-order." }}
      >
        {list.items.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-normal">
              <div className="font-medium">{c.productName}</div>
              <div className="text-xs text-muted-foreground">{c.sku}</div>
            </TableCell>
            <TableCell className="text-xs">
              {timeWIB(c.startsAt)}
              <br />
              {timeWIB(c.endsAt)}
            </TableCell>
            <TableCell className="whitespace-nowrap">
              {c.shipFrom} – {c.shipTo}
            </TableCell>
            <TableCell className="text-right tabular-nums">
              {number(c.reserved + c.sold)} / {c.quota == null ? "∞" : number(c.quota)}
            </TableCell>
            <TableCell>{phase(c)}</TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm" onClick={() => openSheet(c)}>
                <Pencil />
                Edit<span className="sr-only"> {c.sku}</span>
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>
      {list.cursor && (
        <Button variant="outline" className="self-center" disabled={list.loadingMore} onClick={list.loadMore}>
          {list.loadingMore ? "Memuat…" : "Muat lebih banyak"}
        </Button>
      )}
      <CampaignSheet
        key={sheetKey}
        campaign={editing}
        open={open}
        onOpenChange={setOpen}
        onSaved={(campaign, created) => list.setItems((items) => (created ? [campaign, ...items] : items.map((c) => (c.id === campaign.id ? campaign : c))))}
      />
    </>
  );
}
