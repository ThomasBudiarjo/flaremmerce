import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Ban, MoreHorizontal, Printer, ShieldAlert, Truck } from "lucide-react";
import { patch, post } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { href, Link, useRoute } from "@/lib/router";
import {
  blocklistKind,
  couriers,
  dateWIB,
  eventKind,
  label,
  milestoneKind,
  money,
  number,
  paymentStatus,
  reviewReason,
  timeWIB,
  variantMode,
} from "@/lib/format";
import type { OrderDetail, PaymentAttempt, ReviewItem } from "@/lib/types";
import { useResource } from "@/hooks/use-resource";
import { useMutation } from "@/hooks/use-mutation";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { MoneyText } from "@/components/money-text";
import { FulfillmentBadge, OrderStatusBadge, PaymentBadge } from "@/components/status-badge";
import { Field, LoadError, TextField } from "@/components/field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";

type Detail = { order: OrderDetail; payment: PaymentAttempt | null };

const nextStep: Record<string, { status: "processing" | "shipped" | "delivered"; title: string; action: string; description: string }> = {
  unfulfilled: { status: "processing", title: "Proses pesanan", action: "Mulai proses", description: "Tandai pesanan sedang disiapkan sebelum dikirim." },
  processing: { status: "shipped", title: "Kirim pesanan", action: "Tandai dikirim", description: "Masukkan nomor resi dan kurir yang dipakai." },
  shipped: { status: "delivered", title: "Konfirmasi diterima", action: "Tandai terkirim", description: "Tandai pesanan sudah diterima pembeli. Pesanan menjadi selesai." },
};

function addressLines(address: Record<string, any>) {
  return [address.line, [address.subdistrict, address.district].filter(Boolean).join(", "), [address.city, address.province].filter(Boolean).join(", "), address.postalCode].filter(
    (line) => line && String(line).trim(),
  ) as string[];
}

function FulfillmentCard({ order, onChanged }: { order: OrderDetail; onChanged: (next: Partial<OrderDetail>) => void }) {
  const step = order.status === "paid" ? nextStep[order.fulfillment] : undefined;
  const defaultCourier = (order.shipping.service ?? "").split(":")[0].toLowerCase();
  const [tracking, setTracking] = useState("");
  const [courier, setCourier] = useState(couriers[defaultCourier] ? defaultCourier : "");
  const [note, setNote] = useState("");
  const update = useMutation(
    (body: Record<string, string>) => patch<{ order: { fulfillment: string; status: string } }>(`/api/admin/orders/${encodeURIComponent(order.id)}/fulfillment`, body),
    {
      key: `fulfillment:${order.id}`,
      success: "Status pengiriman diperbarui.",
      onSuccess: (result) => {
        setTracking("");
        setNote("");
        onChanged(result.order);
      },
    },
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Truck className="size-4" />
          Pengiriman
          <FulfillmentBadge value={order.fulfillment} />
        </CardTitle>
        <CardDescription>
          {order.shipping.service ? `Layanan dibeli: ${order.shipping.service.toUpperCase()}` : "Layanan pengiriman tidak tercatat."}
          {order.tracking && ` · Resi ${order.tracking.number}${order.tracking.courierName ? ` (${order.tracking.courierName})` : ""}`}
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {order.tracking?.url && (
          <a className="text-sm underline underline-offset-4" href={order.tracking.url} target="_blank" rel="noreferrer">
            Halaman pelacakan {order.tracking.courierName}
          </a>
        )}
        {order.status === "pending_payment" && <p className="text-sm text-muted-foreground">Pengiriman tersedia setelah pembayaran terkonfirmasi.</p>}
        {order.status === "cancelled" && <p className="text-sm text-muted-foreground">Pesanan dibatalkan; tidak ada pengiriman.</p>}
        {order.status === "completed" && <p className="text-sm text-muted-foreground">Pesanan selesai.</p>}
        {step && order.hold && (
          <Alert variant="destructive">
            <ShieldAlert />
            <AlertTitle>Pengiriman ditahan</AlertTitle>
            <AlertDescription>Selesaikan review risiko terbuka sebelum memproses pesanan ini.</AlertDescription>
          </Alert>
        )}
        {step && (
          <form
            className="grid gap-3 rounded-lg border p-3"
            aria-label={step.title}
            onSubmit={(e) => {
              e.preventDefault();
              const body: Record<string, string> = { status: step.status };
              if (step.status === "shipped") {
                body.tracking = tracking.trim();
                if (courier) body.courier = courier;
              }
              if (note.trim()) body.note = note.trim();
              void update.mutate(body);
            }}
          >
            <div>
              <p className="font-medium">Langkah berikutnya: {step.title}</p>
              <p className="text-sm text-muted-foreground">{step.description}</p>
            </div>
            {step.status === "shipped" && (
              <div className="grid gap-3 sm:grid-cols-2">
                <TextField label="Nomor resi" required maxLength={200} value={tracking} onChange={(e) => setTracking(e.target.value)} />
                <Field label="Kurir">
                  {(id) => (
                    <NativeSelect id={id} className="w-full" value={courier} onChange={(e) => setCourier(e.target.value)}>
                      <NativeSelectOption value="">Sesuai layanan dibeli</NativeSelectOption>
                      {Object.entries(couriers).map(([code, name]) => (
                        <NativeSelectOption key={code} value={code}>
                          {name}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  )}
                </Field>
              </div>
            )}
            <Field label="Catatan internal (opsional)">
              {(id) => <Textarea id={id} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Button className="justify-self-start" disabled={update.pending || order.hold || (step.status === "shipped" && !tracking.trim())}>
              {update.pending ? "Menyimpan…" : step.action}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function TimelineCard({ order, onAdded }: { order: OrderDetail; onAdded: () => void }) {
  const [kind, setKind] = useState("preparing");
  const [note, setNote] = useState("");
  const [estimatedDate, setEstimatedDate] = useState("");
  const add = useMutation(
    (body: Record<string, string>) => post(`/api/admin/orders/${encodeURIComponent(order.id)}/timeline`, body),
    {
      key: `milestone:${order.id}`,
      success: "Milestone ditambahkan.",
      onSuccess: () => {
        setNote("");
        setEstimatedDate("");
        onAdded();
      },
    },
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Timeline</CardTitle>
        <CardDescription>Riwayat pesanan dalam WIB. Milestone persiapan terlihat oleh pembeli.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!order.timeline.length && <p className="text-sm text-muted-foreground">Belum ada aktivitas.</p>}
        <ol className="grid gap-3 border-l pl-4">
          {[...order.timeline].reverse().map((event, i) => (
            <li key={`${event.kind}-${event.createdAt}-${i}`} className="grid gap-0.5 text-sm">
              <span className="font-medium">{label(eventKind, event.kind)}</span>
              <span className="text-xs text-muted-foreground">{timeWIB(event.createdAt)}</span>
              {event.details?.note && <span className="whitespace-pre-wrap">{event.details.note}</span>}
              {event.details?.tracking && (
                <span>
                  Resi {event.details.tracking}
                  {event.details.courier ? ` · ${label(couriers, event.details.courier)}` : ""}
                </span>
              )}
              {event.details?.estimatedDate && <span>Estimasi: {event.details.estimatedDate}</span>}
              {event.details?.shipFrom && (
                <span>
                  Estimasi kirim baru: {event.details.shipFrom} – {event.details.shipTo}
                </span>
              )}
            </li>
          ))}
        </ol>
        {order.status === "paid" && (
          <form
            className="grid gap-3 rounded-lg border p-3"
            aria-label="Tambah milestone"
            onSubmit={(e) => {
              e.preventDefault();
              void add.mutate({ kind, note: note.trim(), ...(estimatedDate ? { estimatedDate } : {}) });
            }}
          >
            <p className="font-medium">Tambah milestone</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Jenis">
                {(id) => (
                  <NativeSelect id={id} className="w-full" value={kind} onChange={(e) => setKind(e.target.value)}>
                    {Object.entries(milestoneKind).map(([value, text]) => (
                      <NativeSelectOption key={value} value={value}>
                        {text}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                )}
              </Field>
              <TextField label="Estimasi tanggal (opsional)" type="date" value={estimatedDate} onChange={(e) => setEstimatedDate(e.target.value)} />
            </div>
            <Field label="Catatan untuk pembeli" required>
              {(id) => <Textarea id={id} rows={2} required maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} />}
            </Field>
            <Button variant="outline" className="justify-self-start" disabled={add.pending || !note.trim()}>
              {add.pending ? "Menyimpan…" : "Tambah milestone"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function BlockDialog({ order, open, onOpenChange }: { order: OrderDetail; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [kinds, setKinds] = useState<string[]>(["email", "phone"]);
  const [reason, setReason] = useState("");
  const block = useMutation(
    (body: { kinds: string[]; reason: string }) =>
      post<{ blocked: { kind: string; created: boolean }[] }>(`/api/admin/orders/${encodeURIComponent(order.id)}/block`, body),
    {
      key: `block:${order.id}`,
      success: (result) => `Diblokir: ${result.blocked.map((b) => label(blocklistKind, b.kind) + (b.created ? "" : " (sudah ada)")).join(", ")}.`,
      onSuccess: () => {
        setReason("");
        onOpenChange(false);
      },
    },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Blokir identitas pembeli</DialogTitle>
          <DialogDescription>
            Checkout berikutnya dengan identitas ini ditolak. Hanya hash yang disimpan; pesanan ini tidak berubah.
          </DialogDescription>
        </DialogHeader>
        <form
          id="block-form"
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void block.mutate({ kinds, reason: reason.trim() });
          }}
        >
          <fieldset className="grid gap-2">
            <legend className="mb-1 text-sm font-medium">Identitas</legend>
            {(["email", "phone", "ip"] as const).map((kind) => (
              <Label key={kind} className="font-normal">
                <Checkbox
                  checked={kinds.includes(kind)}
                  onCheckedChange={(checked) => setKinds((list) => (checked ? [...list, kind] : list.filter((k) => k !== kind)))}
                />
                {blocklistKind[kind]}
              </Label>
            ))}
          </fieldset>
          <Field label="Alasan" required>
            {(id) => <Textarea id={id} required maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
          </Field>
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Batal
          </Button>
          <Button form="block-form" variant="destructive" disabled={block.pending || !kinds.length || !reason.trim()}>
            {block.pending ? "Memblokir…" : "Blokir"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({
  order,
  open,
  onOpenChange,
  onCancelled,
}: {
  order: OrderDetail;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCancelled: () => void;
}) {
  const { me } = useSession();
  const [reason, setReason] = useState("");
  const [unknown, setUnknown] = useState(false);
  const exhausted = order.openReviewReasons.includes("reconciliation_exhausted");
  const forceAllowed = me.role === "owner" && (unknown || exhausted);
  const cancel = useMutation(
    (body: { reason?: string; confirmNoPayment?: true }) => post(`/api/admin/orders/${encodeURIComponent(order.id)}/cancel`, body),
    {
      key: `cancel:${order.id}`,
      success: "Pesanan dibatalkan.",
      onSuccess: () => {
        onOpenChange(false);
        onCancelled();
      },
      onError: (error) => {
        // The provider could not confirm the payment state; only an owner may then force the cancel.
        if (error.status === 503) setUnknown(true);
        if (error.status === 409) onCancelled();
      },
    },
  );
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Batalkan pesanan {order.reference}?</AlertDialogTitle>
          <AlertDialogDescription>
            Status pembayaran dicek ke penyedia terlebih dahulu. Pesanan yang ternyata sudah dibayar tidak dibatalkan. Stok yang direservasi
            dilepas.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <Field label={forceAllowed ? "Alasan (wajib untuk pembatalan paksa)" : "Alasan (opsional)"}>
          {(id) => <Textarea id={id} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        {unknown && (
          <Alert variant="destructive">
            <AlertDescription>
              Status pembayaran belum bisa dipastikan.{" "}
              {me.role === "owner"
                ? exhausted
                  ? "Sebagai owner kamu dapat membatalkan paksa karena rekonsiliasi sudah habis."
                  : "Pembatalan paksa hanya tersedia setelah review rekonsiliasi habis terbuka."
                : "Coba lagi nanti atau minta owner meninjau."}
            </AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Tutup</AlertDialogCancel>
          {forceAllowed && exhausted && (
            <Button
              variant="destructive"
              disabled={cancel.pending || !reason.trim()}
              onClick={() => void cancel.mutate({ reason: reason.trim(), confirmNoPayment: true })}
            >
              Batalkan paksa
            </Button>
          )}
          <Button variant="destructive" disabled={cancel.pending} onClick={() => void cancel.mutate(reason.trim() ? { reason: reason.trim() } : {})}>
            {cancel.pending ? "Membatalkan…" : "Batalkan pesanan"}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function PrintView({ mode, order }: { mode: "invoice" | "packing"; order: OrderDetail }) {
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return createPortal(
    <div className="hidden p-8 text-sm text-black print:block" data-print-view={mode}>
      <div className="flex justify-between gap-4">
        <div>
          <p className="text-xl font-semibold">{mode === "invoice" ? "Invoice" : "Packing slip"}</p>
          <p>Flaremmerce</p>
        </div>
        <div className="text-right">
          <p className="font-medium">{order.reference}</p>
          <p>{dateWIB(order.createdAt)}</p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-6">
        <div>
          <p className="font-medium">Kirim ke</p>
          <p>{order.contact.name}</p>
          {order.contact.phone && <p>{order.contact.phone}</p>}
          {addressLines(order.address).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div>
          <p className="font-medium">Pengiriman</p>
          <p>{order.shipping.service?.toUpperCase() ?? "—"}</p>
          {order.tracking && <p>Resi {order.tracking.number}</p>}
        </div>
      </div>
      <table className="mt-6 w-full border-collapse">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">Produk</th>
            <th className="py-1">SKU</th>
            <th className="py-1 text-right">Jumlah</th>
            {mode === "invoice" && <th className="py-1 text-right">Harga</th>}
            {mode === "invoice" && <th className="py-1 text-right">Subtotal</th>}
            {mode === "packing" && <th className="py-1 text-right">Dicek</th>}
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id} className="border-b">
              <td className="py-1">
                {item.productName} · {item.name}
              </td>
              <td className="py-1">{item.sku}</td>
              <td className="py-1 text-right">{item.quantity}</td>
              {mode === "invoice" && <td className="py-1 text-right">{money(item.price, order.currency)}</td>}
              {mode === "invoice" && <td className="py-1 text-right">{money(item.price * item.quantity, order.currency)}</td>}
              {mode === "packing" && <td className="py-1 text-right">☐</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {mode === "invoice" && (
        <div className="mt-4 ml-auto grid w-64 gap-1">
          <p className="flex justify-between">
            <span>Subtotal</span>
            <span>{money(subtotal, order.currency)}</span>
          </p>
          <p className="flex justify-between">
            <span>Ongkir</span>
            <span>{money(order.shipping.amount ?? 0, order.currency)}</span>
          </p>
          <p className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{money(order.total, order.currency)}</span>
          </p>
        </div>
      )}
    </div>,
    document.body,
  );
}

function OpenReviews({ order }: { order: OrderDetail }) {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  useEffect(() => {
    if (!order.hold) return;
    const controller = new AbortController();
    // The review list has no order filter; the newest 100 cases cover any realistic open hold.
    get<{ items: ReviewItem[] }>("/api/admin/review?limit=100", controller.signal)
      .then((data) => setReviews(data.items.filter((item) => item.orderId === order.id && item.status === "open")))
      .catch(() => setReviews([]));
    return () => controller.abort();
  }, [order.id, order.hold]);
  if (!order.hold) return null;
  return (
    <ul className="grid gap-1 text-sm">
      {reviews === null && <Skeleton className="h-4 w-40" />}
      {reviews?.map((review) => (
        <li key={review.id}>
          <Link className="underline underline-offset-4" to={href("review-detail", { id: review.id })}>
            {label(reviewReason, review.reason)}
          </Link>
        </li>
      ))}
      {reviews?.length === 0 && (
        <li>
          <Link className="underline underline-offset-4" to={href("reviews")}>
            Buka antrean review
          </Link>
        </li>
      )}
    </ul>
  );
}

export function OrderDetailPage() {
  const { route } = useRoute();
  const id = route.params.id;
  const resource = useResource<Detail>(`/api/admin/orders/${encodeURIComponent(id)}`);
  const [print, setPrint] = useState<"invoice" | "packing" | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);

  useEffect(() => {
    if (!print) return;
    const root = document.getElementById("root");
    root?.classList.add("print:hidden");
    const done = () => setPrint(null);
    window.addEventListener("afterprint", done);
    const timer = setTimeout(() => window.print(), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      root?.classList.remove("print:hidden");
    };
  }, [print]);

  const data = resource.data;
  const order = data?.order;
  const refresh = () => void resource.reload({ keep: true });

  if (!order) {
    return (
      <>
        <PageHeader title="Detail pesanan" />
        {resource.error ? (
          <LoadError message={resource.error} onRetry={() => void resource.reload()} />
        ) : (
          <div className="grid gap-4 lg:grid-cols-3" role="status" aria-label="Memuat pesanan">
            <Skeleton className="h-64 lg:col-span-2" />
            <Skeleton className="h-64" />
          </div>
        )}
      </>
    );
  }

  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return (
    <>
      <div className="print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to={href("orders")}>
            <ArrowLeft />
            Pesanan
          </Link>
        </Button>
      </div>
      <PageHeader
        title={`Pesanan ${order.reference}`}
        description={`Dibuat ${timeWIB(order.createdAt)} WIB`}
        actions={
          <>
            <OrderStatusBadge value={order.status} />
            <FulfillmentBadge value={order.fulfillment} />
            {order.hold && <Badge variant="destructive">Ditahan</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">
                  <MoreHorizontal />
                  Aksi
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setPrint("invoice")}>
                  <Printer />
                  Cetak invoice
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setPrint("packing")}>
                  <Printer />
                  Cetak packing slip
                </DropdownMenuItem>
                {order.status === "pending_payment" && (
                  <>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setCancelOpen(true)}>
                      <Ban />
                      Batalkan pesanan
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        }
      />
      {order.hold && (
        <Alert variant="destructive" role="alert">
          <ShieldAlert />
          <AlertTitle>Pesanan ditahan untuk review</AlertTitle>
          <AlertDescription>
            {order.openReviewReasons.map((r) => label(reviewReason, r)).join(", ")}. Pengiriman diblokir sampai review diselesaikan.
          </AlertDescription>
        </Alert>
      )}
      <div className="grid items-start gap-6 lg:grid-cols-3">
        <div className="grid gap-6 lg:col-span-2">
          <Card>
            <CardHeader>
              <CardTitle>Item ({number(order.items.reduce((n, item) => n + item.quantity, 0))})</CardTitle>
              <CardDescription>Snapshot saat checkout; tidak berubah walau katalog diubah.</CardDescription>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Produk</TableHead>
                    <TableHead className="text-right">Jumlah</TableHead>
                    <TableHead className="text-right">Harga</TableHead>
                    <TableHead className="text-right">Subtotal</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {order.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="min-w-48 whitespace-normal">
                        <div className="font-medium">
                          {item.productName} · {item.name}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          {item.sku} · {label(variantMode, item.mode)} · {number(item.weight)} g
                        </div>
                        {item.campaign && (
                          <div className="text-xs">
                            Estimasi kirim saat dibeli: {item.campaign.shipFrom} – {item.campaign.shipTo}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{item.quantity}</TableCell>
                      <TableCell className="text-right">
                        <MoneyText value={item.price} currency={order.currency} />
                      </TableCell>
                      <TableCell className="text-right">
                        <MoneyText value={item.price * item.quantity} currency={order.currency} />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
          <FulfillmentCard
            key={`${order.id}:${order.fulfillment}`}
            order={order}
            onChanged={(next) => {
              resource.setData((current) => (current ? { ...current, order: { ...current.order, ...next } } : current));
              refresh();
            }}
          />
          <TimelineCard order={order} onAdded={refresh} />
        </div>
        <div className="grid gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Pelanggan</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
              <p className="font-medium">{order.contact.name || "Guest"}</p>
              {order.contact.email && <p className="break-all">{order.contact.email}</p>}
              {order.contact.phone && <p>{order.contact.phone}</p>}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Alamat & layanan</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1 text-sm">
              {addressLines(order.address).map((line) => (
                <p key={line}>{line}</p>
              ))}
              <Separator className="my-2" />
              <p>Layanan: {order.shipping.service?.toUpperCase() ?? "—"}</p>
              {order.shipping.weight != null && <p>Berat ditagih: {number(order.shipping.weight)} g</p>}
              {order.shipping.shipFrom && (
                <p>
                  Estimasi kirim pre-order: {order.shipping.shipFrom} – {order.shipping.shipTo}
                </p>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Pembayaran</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2 text-sm">
              <p className="flex justify-between">
                <span>Subtotal</span>
                <MoneyText value={subtotal} currency={order.currency} />
              </p>
              <p className="flex justify-between">
                <span>Ongkir</span>
                <MoneyText value={order.shipping.amount ?? 0} currency={order.currency} />
              </p>
              <p className="flex justify-between font-semibold">
                <span>Total</span>
                <MoneyText value={order.total} currency={order.currency} />
              </p>
              <Separator className="my-1" />
              {data.payment ? (
                <div className="grid gap-1">
                  <p className="flex items-center justify-between gap-2">
                    <span>Status penyedia</span>
                    <PaymentBadge value={data.payment.status} />
                  </p>
                  <p className="text-muted-foreground">
                    Dicek {data.payment.checks}×{data.payment.nextCheck ? ` · cek berikutnya ${timeWIB(data.payment.nextCheck)}` : ""}
                  </p>
                </div>
              ) : (
                <p className="text-muted-foreground">Belum ada percobaan pembayaran.</p>
              )}
              <p className="sr-only">Status pembayaran: {label(paymentStatus, data.payment?.status)}</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <ShieldAlert className="size-4" />
                Risiko
              </CardTitle>
              <CardDescription>{order.hold ? "Ada review terbuka untuk pesanan ini." : "Tidak ada review terbuka."}</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3">
              <OpenReviews order={order} />
              <Button variant="outline" className="justify-self-start" onClick={() => setBlockOpen(true)}>
                <Ban />
                Blokir identitas pembeli
              </Button>
            </CardContent>
          </Card>
        </div>
      </div>
      <BlockDialog order={order} open={blockOpen} onOpenChange={setBlockOpen} />
      <CancelDialog order={order} open={cancelOpen} onOpenChange={setCancelOpen} onCancelled={refresh} />
      {print && <PrintView mode={print} order={order} />}
    </>
  );
}
