import { useEffect, useState } from "react";
import { post } from "@/lib/api";
import { number } from "@/lib/format";
import { markSummaryStale } from "@/lib/summary";
import { useMutation } from "@/hooks/use-mutation";
import { useResource } from "@/hooks/use-resource";
import { Field, LoadError, NumberField } from "@/components/field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";

export type StockTarget = { variantId: string; sku: string; name: string; productName: string };
type Inventory = { onHand: number; reserved: number };
type Mode = "add" | "remove" | "count";

const modes: [Mode, string, string][] = [
  ["add", "Tambah", "Jumlah ditambah"],
  ["remove", "Kurangi", "Jumlah dikurangi"],
  ["count", "Set stok fisik (opname)", "Stok fisik hasil hitung"],
];
const reasons = ["Stok opname", "Barang masuk", "Rusak", "Retur"];

/** Signed ledger delta for a mode and the entered quantity; an opname count is relative to current physical stock. */
export function stockDelta(mode: Mode, quantity: number | null, onHand: number) {
  if (quantity == null) return null;
  return mode === "add" ? quantity : mode === "remove" ? -quantity : quantity - onHand;
}

/**
 * Inventory adjustment. Current stock is re-read when the dialog opens so an opname count is
 * converted into a delta against fresh numbers; the server still rejects going below reserved.
 */
export function StockAdjustDialog({ target, onClose, onAdjusted }: { target: StockTarget | null; onClose: () => void; onAdjusted: (variantId: string, inventory: Inventory) => void }) {
  const variantId = target?.variantId ?? "";
  const current = useResource<{ inventory: Inventory }>(target ? `/api/admin/inventory?${new URLSearchParams({ variantId, limit: "1" })}` : null);
  const [mode, setMode] = useState<Mode>("add");
  const [quantity, setQuantity] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  useEffect(() => {
    setMode("add");
    setQuantity(null);
    setReason("");
  }, [variantId]);
  const adjust = useMutation(
    (body: { variantId: string; delta: number; reason: string }) => post<{ inventory: { variantId: string } & Inventory }>("/api/admin/inventory", body),
    {
      key: `inventory-adjust:${variantId}`,
      success: "Stok disesuaikan.",
      onSuccess: (result) => {
        onAdjusted(result.inventory.variantId, result.inventory);
        markSummaryStale();
        onClose();
      },
    },
  );
  const stock = current.data?.inventory;
  const delta = stock ? stockDelta(mode, quantity, stock.onHand) : null;
  const next = stock && delta != null ? stock.onHand + delta : null;
  const belowReserved = stock && next != null && next < stock.reserved;
  const invalid = quantity != null && (quantity < 0 || !Number.isInteger(quantity) || (mode !== "count" && quantity === 0));
  const ready = !!stock && delta != null && delta !== 0 && !belowReserved && !invalid && !!reason.trim();
  const label = modes.find(([value]) => value === mode)![2];
  return (
    <Dialog open={!!target} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sesuaikan stok</DialogTitle>
          <DialogDescription>
            {target ? `${target.productName} · ${target.name} (${target.sku}). ` : ""}Setiap penyesuaian tercatat di riwayat stok beserta alasannya.
          </DialogDescription>
        </DialogHeader>
        {current.error && <LoadError message={current.error} onRetry={() => void current.reload()} />}
        <form
          id="adjust-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (ready) void adjust.mutate({ variantId, delta: delta!, reason: reason.trim() });
          }}
        >
          <div role="group" aria-label="Jenis penyesuaian" className="flex flex-wrap gap-1">
            {modes.map(([value, text]) => (
              <Button
                key={value}
                type="button"
                size="sm"
                variant={mode === value ? "secondary" : "ghost"}
                aria-pressed={mode === value}
                onClick={() => {
                  setMode(value);
                  setQuantity(null);
                }}
              >
                {text}
              </Button>
            ))}
          </div>
          <NumberField key={mode} label={label} required min={0} max={1_000_000} value={quantity} onValueChange={setQuantity} />
          <div className="rounded-md border p-3 text-sm" aria-live="polite">
            {!stock ? (
              <Skeleton className="h-4 w-56" />
            ) : (
              <p className="tabular-nums">
                Fisik {number(stock.onHand)}
                {next != null && ` → ${number(next)}`} · Tersedia {number(stock.onHand - stock.reserved)}
                {next != null && ` → ${number(next - stock.reserved)}`}
                {stock.reserved > 0 && <span className="text-muted-foreground"> · {number(stock.reserved)} direservasi</span>}
              </p>
            )}
            {mode === "count" && delta === 0 && <p className="mt-1 text-muted-foreground">Sama dengan stok tercatat; tidak ada selisih.</p>}
            {mode === "count" && delta != null && delta !== 0 && (
              <p className="mt-1 text-muted-foreground">
                Selisih dicatat: {delta > 0 ? "+" : ""}
                {number(delta)}
              </p>
            )}
          </div>
          {belowReserved && (
            <Alert variant="destructive">
              <AlertDescription>
                Stok fisik tidak boleh kurang dari {number(stock!.reserved)} unit yang direservasi pesanan.
              </AlertDescription>
            </Alert>
          )}
          <Field label="Alasan" required>
            {(id) => (
              <div className="grid gap-2">
                <div className="flex flex-wrap gap-1" role="group" aria-label="Alasan cepat">
                  {reasons.map((text) => (
                    <Button key={text} type="button" size="xs" variant={reason === text ? "secondary" : "outline"} aria-pressed={reason === text} onClick={() => setReason(text)}>
                      {text}
                    </Button>
                  ))}
                </div>
                <Textarea id={id} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
            )}
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Batal
          </Button>
          <Button form="adjust-form" disabled={adjust.pending || !ready}>
            {adjust.pending ? "Menyimpan…" : "Simpan penyesuaian"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
