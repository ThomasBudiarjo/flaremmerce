import { useEffect, useState } from "react";
import { ArrowLeft, ArrowRight, Ban, ChevronLeft, ChevronRight, MessageCircle, MoreHorizontal, Printer, ShieldAlert, Truck } from "lucide-react";
import { patch, post } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { href, Link, useNavigationGuard, useRoute } from "@/lib/router";
import { listHref, neighbours } from "@/lib/list-memory";
import { markSummaryStale } from "@/lib/summary";
import {
  blocklistKind,
  couriers,
  eventKind,
  label,
  milestoneKind,
  number,
  paymentStatus,
  reviewReason,
  timeWIB,
  variantMode,
  whatsappLink,
} from "@/lib/format";
import type { OrderDetail, PaymentAttempt, ReviewItem } from "@/lib/types";
import { useResource } from "@/hooks/use-resource";
import { useMutation } from "@/hooks/use-mutation";
import { useSaveHotkey } from "@/hooks/use-hotkeys";
import { get } from "@/lib/api";
import { PageHeader } from "@/components/page-header";
import { CopyButton } from "@/components/copy-button";
import { addressLines, PrintView, usePrint } from "@/components/print-view";
import { MoneyText } from "@/components/money-text";
import { FulfillmentBadge, OrderStatusBadge, PaymentBadge } from "@/components/status-badge";
import { Field, LoadError, TextField } from "@/components/field";
import { DetailSkeleton, Reveal } from "@/components/loading";
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
        markSummaryStale();
        onChanged(result.order);
      },
    },
  );
  useNavigationGuard(!!step && !!(tracking.trim() || note.trim()), "Nomor resi atau catatan pengiriman yang belum disimpan akan hilang.");
  const blocked = update.pending || order.hold || (step?.status === "shipped" && !tracking.trim());
  useSaveHotkey("fulfillment-form", !!step && !blocked);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Truck className="size-4" />
          Pengiriman
          <FulfillmentBadge value={order.fulfillment} />
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-1">
          {order.shipping.service ? `Layanan dibeli: ${order.shipping.service.toUpperCase()}` : "Layanan pengiriman tidak tercatat."}
          {order.tracking && (
            <>
              <span>
                · Resi {order.tracking.number}
                {order.tracking.courierName ? ` (${order.tracking.courierName})` : ""}
              </span>
              <CopyButton value={order.tracking.number} label="nomor resi" />
            </>
          )}
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
            id="fulfillment-form"
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
            <Button className="justify-self-start" disabled={blocked} title="Ctrl+S">
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
  useNavigationGuard(order.status === "paid" && !!(note.trim() || estimatedDate), "Milestone yang belum ditambahkan akan hilang.");
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

function OpenReviews({ order }: { order: OrderDetail }) {
  const [reviews, setReviews] = useState<ReviewItem[] | null>(null);
  useEffect(() => {
    if (!order.hold) return;
    const controller = new AbortController();
    get<{ items: ReviewItem[] }>(`/api/admin/review?${new URLSearchParams({ status: "open", orderId: order.id, limit: "100" })}`, controller.signal)
      .then((data) => setReviews(data.items))
      .catch(() => setReviews([]));
    return () => controller.abort();
  }, [order.id, order.hold]);
  if (!order.hold) return null;
  return (
    <ul className="grid gap-1 text-sm">
      {reviews === null && (
        <li role="status" aria-label="Memuat review terbuka">
          <Skeleton className="h-4 w-40" />
        </li>
      )}
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
  const [print, setPrint] = usePrint<"invoice" | "packing">();
  const [cancelOpen, setCancelOpen] = useState(false);
  const [blockOpen, setBlockOpen] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const around = neighbours("orders", id);

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
          <DetailSkeleton label="Memuat pesanan" />
        )}
      </>
    );
  }

  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const whatsapp = whatsappLink(order.contact.phone);
  const lookup = order.contact.email || order.contact.phone;
  const address = [order.contact.name, order.contact.phone, ...addressLines(order.address)].filter(Boolean).join("\n");
  return (
    <Reveal className="flex flex-col gap-6">
      <nav aria-label="Navigasi pesanan" className="flex flex-wrap items-center gap-2 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link to={listHref("orders")}>
            <ArrowLeft />
            Pesanan
          </Link>
        </Button>
        {around.index >= 0 && (
          <div className="ml-auto flex items-center gap-1">
            <span className="text-xs text-muted-foreground tabular-nums">
              {around.index + 1} / {around.total}
            </span>
            {around.prev ? (
              <Button asChild variant="ghost" size="sm">
                <Link to={href("order-detail", { id: around.prev })}>
                  <ChevronLeft />
                  Sebelumnya
                </Link>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" disabled>
                <ChevronLeft />
                Sebelumnya
              </Button>
            )}
            {around.next ? (
              <Button asChild variant="ghost" size="sm">
                <Link to={href("order-detail", { id: around.next })}>
                  Berikutnya
                  <ChevronRight />
                </Link>
              </Button>
            ) : (
              <Button variant="ghost" size="sm" disabled>
                Berikutnya
                <ChevronRight />
              </Button>
            )}
          </div>
        )}
      </nav>
      <PageHeader
        title={`Pesanan ${order.reference}`}
        description={`Dibuat ${timeWIB(order.createdAt)} WIB`}
        actions={
          <>
            <CopyButton value={order.reference} label="referensi" />
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
          {advanced && around.next && (
            <Alert>
              <AlertTitle>Langkah pengiriman tersimpan</AlertTitle>
              <AlertDescription className="flex flex-wrap items-center gap-2">
                Pesanan berikutnya di daftar sudah menunggu.
                <Button asChild size="sm">
                  <Link to={href("order-detail", { id: around.next })}>
                    Lanjut ke pesanan berikutnya
                    <ArrowRight />
                  </Link>
                </Button>
              </AlertDescription>
            </Alert>
          )}
          <FulfillmentCard
            key={`${order.id}:${order.fulfillment}`}
            order={order}
            onChanged={(next) => {
              resource.setData((current) => (current ? { ...current, order: { ...current.order, ...next } } : current));
              setAdvanced(true);
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
              {order.contact.email && (
                <p className="flex items-center gap-1 break-all">
                  {order.contact.email}
                  <CopyButton value={order.contact.email} label="email" />
                </p>
              )}
              {order.contact.phone && (
                <p className="flex items-center gap-1">
                  {order.contact.phone}
                  <CopyButton value={order.contact.phone} label="nomor HP" />
                </p>
              )}
              <div className="mt-2 flex flex-wrap gap-2 print:hidden">
                {whatsapp && (
                  <Button asChild variant="outline" size="sm">
                    <a href={whatsapp} target="_blank" rel="noreferrer">
                      <MessageCircle />
                      WhatsApp
                    </a>
                  </Button>
                )}
                {lookup && (
                  <Button asChild variant="ghost" size="sm">
                    <Link to={href("orders", {}, { q: lookup })}>Pesanan lain dari pembeli ini</Link>
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1">
                Alamat & layanan
                <CopyButton value={address} label="alamat lengkap" />
              </CardTitle>
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
      {print && <PrintView mode={print} orders={[order]} />}
    </Reveal>
  );
}
