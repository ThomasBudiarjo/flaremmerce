import { useEffect, useState } from "react";
import { Pencil, Plus, Repeat } from "lucide-react";
import { get, patch, post } from "@/lib/api";
import { href, Link, useRoute } from "@/lib/router";
import { fromWibInput, number, shiftDay, timeWIB, wibInput } from "@/lib/format";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type Draft = { startsAt: string; endsAt: string; shipFrom: string; shipTo: string; quota: number | null; active: boolean };
const draftOf = (c: Campaign): Draft => ({ startsAt: wibInput(c.startsAt), endsAt: wibInput(c.endsAt), shipFrom: c.shipFrom, shipTo: c.shipTo, quota: c.quota, active: c.active });

type Phase = "inactive" | "upcoming" | "ended" | "running";
export function phaseOf(c: Campaign, now = Date.now()): Phase {
  if (!c.active) return "inactive";
  if (now < c.startsAt) return "upcoming";
  if (now >= c.endsAt) return "ended";
  return "running";
}
function PhaseBadge({ campaign }: { campaign: Campaign }) {
  const value = phaseOf(campaign);
  if (value === "inactive") return <Badge variant="outline">Nonaktif</Badge>;
  if (value === "upcoming") return <Badge variant="secondary">Akan datang</Badge>;
  if (value === "ended") return <Badge variant="outline">Berakhir</Badge>;
  return <Badge>Berjalan</Badge>;
}
const phaseTabs = [
  ["running", "Berjalan"],
  ["upcoming", "Akan datang"],
  ["ended", "Berakhir"],
  ["all", "Semua"],
] as const;

/** Field errors shown inline; the server enforces the same rules (and overlap) on save. */
export function campaignErrors(draft: Draft) {
  const errors: { endsAt?: string; shipTo?: string } = {};
  const start = fromWibInput(draft.startsAt), end = fromWibInput(draft.endsAt);
  if (start != null && end != null && end <= start) errors.endsAt = "Berakhir harus setelah waktu mulai.";
  if (draft.shipFrom && draft.shipTo && draft.shipTo < draft.shipFrom) errors.shipTo = "Kirim sampai tidak boleh sebelum kirim dari.";
  return errors;
}

/**
 * Draft for "Buat ulang": same duration, quota and shipping window, moved to start when the source
 * ends (or now, if that has passed) so it cannot overlap the source campaign.
 */
export function repeatDraft(source: Campaign, now = Date.now()): Draft {
  const minute = 60_000;
  const start = Math.ceil(Math.max(source.endsAt, now) / minute) * minute;
  const shift = start - source.startsAt;
  const days = Math.round(shift / 86_400_000);
  return {
    startsAt: wibInput(start),
    endsAt: wibInput(source.endsAt + shift),
    shipFrom: shiftDay(source.shipFrom, days),
    shipTo: shiftDay(source.shipTo, days),
    quota: source.quota,
    active: true,
  };
}

/** Only edited fields: an untouched start/end keeps its stored seconds. */
export function campaignChanges(original: Campaign, draft: Draft) {
  const base = draftOf(original), out: Record<string, unknown> = {};
  if (draft.startsAt !== base.startsAt) out.startsAt = fromWibInput(draft.startsAt);
  if (draft.endsAt !== base.endsAt) out.endsAt = fromWibInput(draft.endsAt);
  for (const key of ["shipFrom", "shipTo", "quota", "active"] as const) if (draft[key] !== base[key]) out[key] = draft[key];
  return out;
}

function FieldError({ message }: { message?: string }) {
  return message ? (
    <p role="alert" className="text-xs text-destructive">
      {message}
    </p>
  ) : null;
}

function CampaignFields({ draft, onChange, disabled, editing }: { draft: Draft; onChange: (d: Draft) => void; disabled?: boolean; editing: boolean }) {
  const errors = campaignErrors(draft);
  return (
    <div className="grid gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <TextField label="Mulai (WIB)" type="datetime-local" required value={draft.startsAt} disabled={disabled} onChange={(e) => onChange({ ...draft, startsAt: e.target.value })} />
        <div className="grid content-start gap-1">
          <TextField label="Berakhir (WIB)" type="datetime-local" required aria-invalid={!!errors.endsAt} value={draft.endsAt} disabled={disabled} onChange={(e) => onChange({ ...draft, endsAt: e.target.value })} />
          <FieldError message={errors.endsAt} />
        </div>
        <TextField label="Estimasi kirim dari" type="date" required value={draft.shipFrom} disabled={disabled} onChange={(e) => onChange({ ...draft, shipFrom: e.target.value })} />
        <div className="grid content-start gap-1">
          <TextField label="Estimasi kirim sampai" type="date" required aria-invalid={!!errors.shipTo} value={draft.shipTo} disabled={disabled} onChange={(e) => onChange({ ...draft, shipTo: e.target.value })} />
          <FieldError message={errors.shipTo} />
        </div>
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
  repeat,
  open,
  onOpenChange,
  onSaved,
}: {
  campaign: Campaign | null;
  /** Source campaign for "Buat ulang": a new campaign on the same variant. */
  repeat: Campaign | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (campaign: Campaign, created: boolean) => void;
}) {
  const [base, setBase] = useState<Campaign | null>(campaign);
  const [draft, setDraft] = useState<Draft>(() =>
    campaign ? draftOf(campaign) : repeat ? repeatDraft(repeat) : { startsAt: "", endsAt: "", shipFrom: "", shipTo: "", quota: null, active: true },
  );
  const [variant, setVariant] = useState<VariantSearchResult | null>(null);
  useEffect(() => {
    if (!repeat) return;
    const controller = new AbortController();
    // The campaign row has no variant price/name; the picker shows the search result for its SKU.
    get<{ variants: VariantSearchResult[] }>(`/api/admin/variants/search?${new URLSearchParams({ q: repeat.sku, mode: "preorder" })}`, controller.signal)
      .then((data) => setVariant(data.variants.find((v) => v.id === repeat.variantId) ?? null))
      .catch(() => {});
    return () => controller.abort();
  }, [repeat]);
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
  const valid =
    !!draft.startsAt && !!draft.endsAt && !!draft.shipFrom && !!draft.shipTo && !Object.keys(campaignErrors(draft)).length && (base ? Object.keys(changes).length > 0 : !!variant);
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
        <SheetHeader>
          <SheetTitle>{base ? `Edit campaign ${base.sku}` : repeat ? `Buat ulang campaign ${repeat.sku}` : "Campaign pre-order baru"}</SheetTitle>
          <SheetDescription>
            {base ? base.productName : repeat ? "Periode, kuota, dan estimasi kirim disalin dan digeser setelah campaign sumber berakhir. Periksa sebelum menyimpan." : "Pilih varian pre-order aktif, lalu atur periode dan kuota."}
          </SheetDescription>
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
  const { route, navigate } = useRoute();
  const tab = (phaseTabs.find(([value]) => value === route.query.get("phase"))?.[0] ?? "all") as (typeof phaseTabs)[number][0];
  const list = usePagedList<Campaign>("/api/admin/campaigns", { listKey: "campaigns", cursor: "keyset" });
  const [editing, setEditing] = useState<Campaign | null>(null);
  const [repeat, setRepeat] = useState<Campaign | null>(null);
  const [open, setOpen] = useState(false);
  const [sheetKey, setSheetKey] = useState(0);
  const openSheet = (campaign: Campaign | null, source: Campaign | null = null) => {
    setEditing(campaign);
    setRepeat(source);
    setSheetKey((k) => k + 1);
    setOpen(true);
  };
  const now = Date.now();
  // Phase is computed per row from the loaded pages; the API pages all campaigns by start time.
  const rows = tab === "all" ? list.items : list.items.filter((c) => phaseOf(c, now) === tab);
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
      <Tabs value={tab} onValueChange={(value) => navigate(href("preorders", {}, value === "all" ? {} : { phase: value }), true)}>
        <TabsList aria-label="Filter fase campaign">
          {phaseTabs.map(([value, text]) => (
            <TabsTrigger key={value} value={value}>
              {text}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[{ head: "Varian" }, { head: "Periode (WIB)" }, { head: "Estimasi kirim" }, { head: "Terpakai / kuota", className: "text-right" }, { head: "Status" }, { head: <span className="sr-only">Aksi</span> }]}
        empty={
          tab === "all"
            ? { title: "Belum ada campaign", description: "Buat campaign untuk membuka pre-order pada varian mode pre-order." }
            : { title: "Tidak ada campaign di fase ini", description: "Penyaringan fase mencakup campaign yang sudah dimuat." }
        }
      >
        {rows.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-normal">
              <Link to={href("product-edit", { id: c.productId })} className="font-medium underline-offset-4 hover:underline">
                {c.productName}
              </Link>
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
              {c.quota != null && (
                <div
                  role="progressbar"
                  aria-label={`Kuota terpakai ${c.sku}`}
                  aria-valuemin={0}
                  aria-valuemax={c.quota}
                  aria-valuenow={c.reserved + c.sold}
                  className="mt-1 ml-auto h-1.5 w-24 overflow-hidden rounded-full bg-muted"
                >
                  <div className="h-full bg-primary" style={{ width: `${c.quota ? Math.min(100, ((c.reserved + c.sold) / c.quota) * 100) : 100}%` }} />
                </div>
              )}
            </TableCell>
            <TableCell>
              <PhaseBadge campaign={c} />
            </TableCell>
            <TableCell className="text-right whitespace-nowrap">
              <Button variant="ghost" size="sm" onClick={() => openSheet(c)}>
                <Pencil />
                Edit<span className="sr-only"> {c.sku}</span>
              </Button>
              <Button variant="ghost" size="sm" onClick={() => openSheet(null, c)}>
                <Repeat />
                Buat ulang<span className="sr-only"> {c.sku}</span>
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
        repeat={repeat}
        open={open}
        onOpenChange={setOpen}
        onSaved={(campaign, created) => list.setItems((items) => (created ? [campaign, ...items] : items.map((c) => (c.id === campaign.id ? campaign : c))))}
      />
    </>
  );
}
