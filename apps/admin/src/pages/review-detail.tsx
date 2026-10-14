import { useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import { patch } from "@/lib/api";
import { href, Link, useRoute } from "@/lib/router";
import { label, money, orderStatus, paymentStatus, reviewReason, timeWIB } from "@/lib/format";
import type { ReviewItem } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { useResource } from "@/hooks/use-resource";
import { PageHeader } from "@/components/page-header";
import { ConflictBanner } from "@/components/conflict-banner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Field, LoadError } from "@/components/field";
import { OrderStatusBadge, ReviewStatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type PaymentEvent = { eventKey: string; reference: string; amount: number; currency: string; status: string; processed: number; createdAt: number };
type Evidence = {
  item: ReviewItem;
  order: { id: string; reference: string; status: string; fulfillment: string; total: number; currency: string; createdAt: number } | null;
  attempt: { id: string; reference: string; status: string; checks: number; nextCheck: number | null; createdAt: number } | null;
  triggeringEvent: PaymentEvent | null;
  events: PaymentEvent[];
  history: { actor: string; createdAt: number; details: { status: string; note: string; action?: string } }[];
};
type Change = { status: "open" | "resolved"; action?: "cancel_order" };

function Facts({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="grid gap-2 text-sm">
      {rows.map(([term, value]) => (
        <div key={term} className="grid grid-cols-[10rem_1fr] gap-2">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-all">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ReviewDetailPage() {
  const { route } = useRoute();
  const id = route.params.id;
  const resource = useResource<Evidence>(`/api/admin/review/${encodeURIComponent(id)}`);
  const [note, setNote] = useState("");
  const [conflict, setConflict] = useState(false);
  const data = resource.data;
  useEffect(() => {
    if (data) setNote(data.item.note ?? "");
  }, [data]);

  const save = useMutation(
    ({ status, action }: Change) => patch(`/api/admin/review/${encodeURIComponent(id)}`, { version: data!.item.version, status, note: note.trim(), ...(action ? { action } : {}) }),
    {
      key: `review:${id}`,
      success: "Review diperbarui.",
      onSuccess: () => void resource.reload({ keep: true }),
      // The review CAS reports a stale version without an entity; reload the evidence first.
      onError: (error) => error.status === 409 && setConflict(true),
    },
  );

  if (!data) {
    return (
      <>
        <PageHeader title="Review" />
        {resource.error ? <LoadError message={resource.error} onRetry={() => void resource.reload()} /> : <Skeleton className="h-64" role="status" aria-label="Memuat review" />}
      </>
    );
  }
  const { item, order, attempt, triggeringEvent } = data;
  const canCancel = item.status === "open" && order && (order.status === "pending_payment" || order.status === "cancelled");
  const disabled = save.pending || conflict || !note.trim();
  return (
    <>
      <div className="print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to={href("reviews")}>
            <ArrowLeft />
            Review
          </Link>
        </Button>
      </div>
      <PageHeader title={label(reviewReason, item.reason)} description={`Dicatat ${timeWIB(item.createdAt)} WIB`} actions={<ReviewStatusBadge value={item.status} />} />
      {conflict && (
        <ConflictBanner
          onReload={() => {
            setConflict(false);
            void resource.reload();
          }}
        />
      )}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="grid gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Bukti</CardTitle>
              <CardDescription>Menandai selesai tidak mengubah pembayaran, stok, atau pesanan.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
              <Facts
                rows={[
                  [
                    "Pesanan",
                    order ? (
                      <Link to={href("order-detail", { id: order.id })} className="font-medium underline underline-offset-4">
                        {order.reference}
                      </Link>
                    ) : (
                      "Tidak ditemukan"
                    ),
                  ],
                  ...(order
                    ? ([
                        ["Total", money(order.total, order.currency)],
                        ["Status pesanan", <OrderStatusBadge key="s" value={order.status} />],
                      ] as [string, React.ReactNode][])
                    : []),
                  ["Percobaan pembayaran", attempt ? `${attempt.reference} · ${label(paymentStatus, attempt.status)} · dicek ${attempt.checks}×` : "Tidak ditemukan"],
                ]}
              />
              <h2 className="font-semibold">Event pemicu</h2>
              {triggeringEvent ? (
                <Facts
                  rows={[
                    ["Referensi", triggeringEvent.reference],
                    ["Event", triggeringEvent.eventKey],
                    ["Waktu (WIB)", timeWIB(triggeringEvent.createdAt)],
                    ["Nominal / status", `${money(triggeringEvent.amount, triggeringEvent.currency)} · ${label(paymentStatus, triggeringEvent.status)}`],
                  ]}
                />
              ) : (
                <p className="text-sm text-muted-foreground">Tidak ada event pemicu tersimpan untuk kasus ini.</p>
              )}
              <h2 className="font-semibold">Event pembayaran terkait</h2>
              {data.events.length ? (
                <div className="overflow-x-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Event / waktu (WIB)</TableHead>
                        <TableHead>Nominal</TableHead>
                        <TableHead>Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {data.events.map((event) => (
                        <TableRow key={event.eventKey}>
                          <TableCell className="max-w-64 break-all whitespace-normal">
                            <div>{event.eventKey}</div>
                            <div className="text-xs text-muted-foreground">{timeWIB(event.createdAt)}</div>
                          </TableCell>
                          <TableCell>{money(event.amount, event.currency)}</TableCell>
                          <TableCell>{label(paymentStatus, event.status)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">Belum ada event pembayaran terkait lainnya.</p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Riwayat audit</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              {!data.history.length && <p className="text-sm text-muted-foreground">Belum ada tindakan operator.</p>}
              {data.history.map((entry, i) => (
                <div key={i} className="grid gap-1 rounded-md border p-3 text-sm">
                  <p className="text-muted-foreground">
                    <span className="break-all">{entry.actor}</span> · {timeWIB(entry.createdAt)} · {entry.details.status === "resolved" ? "Selesai" : "Terbuka"}
                    {entry.details.action === "cancel_order" && " · pesanan dibatalkan"}
                  </p>
                  <p className="break-words whitespace-pre-wrap">{entry.details.note}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Tindakan</CardTitle>
            <CardDescription>Catatan wajib dan tersimpan di audit.</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-3">
            <Field label="Catatan operator (wajib)">
              {(fieldId) => <Textarea id={fieldId} rows={5} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Button disabled={disabled} onClick={() => void save.mutate({ status: item.status === "open" ? "resolved" : "open" })}>
              {item.status === "open" ? "Tandai selesai" : "Buka kembali"}
            </Button>
            <Button variant="outline" disabled={disabled} onClick={() => void save.mutate({ status: item.status })}>
              Simpan catatan saja
            </Button>
            {canCancel && (
              <ConfirmDialog
                trigger={
                  <Button variant="destructive" disabled={disabled}>
                    Selesaikan & batalkan pesanan
                  </Button>
                }
                title={`Batalkan pesanan ${order!.reference}?`}
                description={`Review ditandai selesai dan pesanan (${label(orderStatus, order!.status)}) dibatalkan dalam satu langkah, setelah status pembayaran dicek ke penyedia.`}
                confirmLabel="Batalkan pesanan"
                onConfirm={() => void save.mutate({ status: "resolved", action: "cancel_order" })}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </>
  );
}
