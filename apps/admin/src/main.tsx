/// <reference types="vite/client" />
import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CalendarDays,
  ClipboardList,
  ExternalLink,
  LoaderCircle,
  LogIn,
  LogOut,
  Package,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  Store,
  Warehouse,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  NativeSelect,
  NativeSelectOption,
} from "@/components/ui/native-select";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from "@/components/ui/empty";
import { Separator } from "@/components/ui/separator";
import { TooltipProvider } from "@/components/ui/tooltip";
import {
  Sidebar,
  SidebarContent,
  SidebarHeader,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import "./style.css";
import { ReviewDetail, reviewReasons } from "./ReviewDetail";
import { OperationalStatus } from "./OperationalStatus";
import {
  OrderSnapshot,
  CatalogEditor,
  InventoryLedger,
  CampaignList,
} from "./AdminWorkflows";

const navigation = [
  ["orders", "Pesanan", ClipboardList],
  ["products", "Produk", Package],
  ["inventory", "Inventori", Warehouse],
  ["campaigns", "Pre-order", CalendarDays],
  ["review", "Manual review", ShieldCheck],
  ["operations", "Status operasional", RefreshCw],
] as const;
function currentTab() {
  const value = window.location.hash.slice(1);
  return navigation.some(([id]) => id === value) ? value : "orders";
}
const statusLabels: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Terbayar",
  completed: "Selesai",
  cancelled: "Dibatalkan",
  unfulfilled: "Belum diproses",
  processing: "Diproses",
  shipped: "Dikirim",
  delivered: "Diterima",
};
async function api(path: string, body?: unknown, method?: string) {
  const res = await fetch(path, {
    method: method || (body ? "POST" : "GET"),
    credentials: "same-origin",
    cache: "no-store",
    headers: body ? { "Content-Type": "application/json" } : {},
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok)
    throw new Error(
      data.error?.message ||
        data.message ||
        (typeof data.error === "string"
          ? data.error
          : "Permintaan gagal. Periksa izin akun dan konfigurasi layanan."),
    );
  return data;
}
const money = (n: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(n);
function Field({
  name,
  label,
  type = "text",
  required = true,
  ...props
}: React.ComponentProps<typeof Input> & { name: string; label: string }) {
  const id = React.useId();
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} name={name} type={type} required={required} {...props} />
    </div>
  );
}

function PhotoUpload({
  productId,
  onImage,
  onPending,
  disabled,
}: {
  productId?: string;
  onImage: (url: string) => void;
  onPending: (blocked: boolean) => void;
  disabled?: boolean;
}) {
  const generation = React.useRef(0);
  const [preview, setPreview] = useState("");
  const [error, setError] = useState("");
  const [uploading, setUploading] = useState(false);
  const input = React.useRef<HTMLInputElement>(null);
  useEffect(() => {
    onImage("");
    onPending(false);
    return () => {
      generation.current++;
    };
  }, []);
  useEffect(
    () => () => {
      if (preview) URL.revokeObjectURL(preview);
    },
    [preview],
  );
  async function select(file?: File) {
    const version = ++generation.current;
    onImage("");
    setError("");
    setPreview("");
    setUploading(false);
    onPending(!!file);
    if (!file) return;
    if (
      !["image/jpeg", "image/png", "image/webp"].includes(file.type) ||
      file.size > 5 * 1024 * 1024 ||
      !file.size
    ) {
      setError("Pilih JPEG, PNG, atau WebP, maksimal 5 MiB.");
      return;
    }
    setPreview(URL.createObjectURL(file));
    setUploading(true);
    try {
      const response = await fetch(
        `/api/admin/media${productId ? `?productId=${encodeURIComponent(productId)}` : ""}`,
        {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": file.type },
          body: file,
        },
      );
      const data = await response.json();
      if (!response.ok || typeof data.url !== "string")
        throw new Error(data.error || "Unggah foto gagal.");
      if (version !== generation.current) return;
      onImage(data.url);
      onPending(false);
    } catch (e) {
      if (version === generation.current) setError((e as Error).message);
    } finally {
      if (version === generation.current) setUploading(false);
    }
  }
  return (
    <div className="grid gap-3">
      <Field
        ref={input}
        name="photo"
        label="Unggah foto utama (JPEG, PNG, WebP; maksimal 5 MiB)"
        type="file"
        accept="image/jpeg,image/png,image/webp"
        required={false}
        disabled={disabled}
        onChange={(e) => select(e.target.files?.[0])}
      />
      {preview && (
        <img
          src={preview}
          alt="Pratinjau foto pilihan"
          className="h-40 w-full rounded-md object-contain"
        />
      )}
      {uploading && (
        <p role="status" className="text-sm">
          Mengunggah foto…
        </p>
      )}
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <p className="text-xs text-muted-foreground">
        Foto menjadi utama setelah perubahan disimpan.
      </p>
      <Button
        type="button"
        variant="outline"
        disabled={disabled}
        onClick={() => {
          if (input.current) input.current.value = "";
          select();
        }}
      >
        Batalkan pilihan foto
      </Button>
    </div>
  );
}

function PrimaryPhoto({
  product,
  onSaved,
}: {
  product: any;
  onSaved: () => Promise<void>;
}) {
  const [image, setImage] = useState("");
  const [blocked, setBlocked] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const lifetime = useRef(0);
  useEffect(() => {
    ++lifetime.current;
    return () => {
      ++lifetime.current;
    };
  }, []);
  return (
    <form
      className="grid gap-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!image || blocked || saving) return;
        const version = lifetime.current;
        setSaving(true);
        setError("");
        setSaved(false);
        try {
          await api(
            `/api/admin/products/${encodeURIComponent(product.id)}`,
            { imageUrl: image, version: product.version },
            "PATCH",
          );
          if (version === lifetime.current) {
            setSaved(true);
            setImage("");
          }
          await onSaved();
        } catch (e) {
          if (version === lifetime.current) setError((e as Error).message);
        } finally {
          if (version === lifetime.current) setSaving(false);
        }
      }}
    >
      <h2 className="font-medium">Foto utama</h2>
      {product.imageUrl && (
        <img
          src={product.imageUrl}
          alt={`Foto utama ${product.name}`}
          className="h-40 w-full rounded-md object-contain"
        />
      )}
      <PhotoUpload
        productId={product.id}
        onImage={(url) => {
          setImage(url);
          setSaved(false);
        }}
        onPending={setBlocked}
        disabled={saving}
      />
      <Button disabled={!image || blocked || saving}>Simpan foto utama</Button>
      {error && (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {saved && <p role="status">Foto utama tersimpan.</p>}
    </form>
  );
}

function App() {
  const { setOpenMobile } = useSidebar();
  const [tab, setTab] = useState(currentTab);
  const [initialized, setInitialized] = useState<boolean>();
  const [user, setUser] = useState<any>(null);
  const [orders, setOrders] = useState<any[]>([]);
  const [review, setReview] = useState<any[]>([]);
  const [reviewCursor, setReviewCursor] = useState<{
    before: number;
    beforeId: string;
  } | null>(null);
  const [reviewLoadingMore, setReviewLoadingMore] = useState(false);
  const [reviewPageError, setReviewPageError] = useState("");
  const requestSequence = useRef(0);
  const catalogueSequence = useRef(0);
  const [catalogue, setCatalogue] = useState<any[]>([]);
  const [catalogueCursor, setCatalogueCursor] = useState<string | null>(null);
  const [ordersCursor, setOrdersCursor] = useState<{
    before: number;
    beforeId: string;
  } | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageError, setPageError] = useState("");
  const [revision, setRevision] = useState(0);
  const [inventoryVariant, setInventoryVariant] = useState("");
  const [detailOpen, setDetailOpen] = useState<string | null>(null);
  const [detailReady, setDetailReady] = useState<string | null>(null);
  const [orderRevisions, setOrderRevisions] = useState<Record<string, number>>({});
  const catalogueView = useRef({ count: catalogue.length, selected: detailOpen });
  catalogueView.current = { count: catalogue.length, selected: detailOpen };
  const dialogSequence = useRef(0);
  const ownerSequence = useRef(0);
  const operation = useRef<symbol | null>(null);
  const renderedOwner = ownerSequence.current;
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [googleEnabled, setGoogleEnabled] = useState(false);
  const [devLoginEnabled, setDevLoginEnabled] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createImage, setCreateImage] = useState("");
  const [uploadPending, setUploadPending] = useState(false);
  const [search, setSearch] = useState("");
  const [variants, setVariants] = useState([
    {
      sku: "",
      name: "Default",
      price: "",
      weight: "",
      stock: "0",
      mode: "stock",
    },
  ]);

  useEffect(() => {
    const navigate = () => {
      const nextTab = currentTab();
      if (nextTab !== tab) {
        operation.current = null;
        setBusy(false);
        ++requestSequence.current;
        ++dialogSequence.current;
        setDetailOpen(null);
        setCreateOpen(false);
        setInventoryVariant("");
        setPageBusy(false);
        setReviewLoadingMore(false);
        setTab(nextTab);
      }
      setMessage("");
      setSearch("");
      setOpenMobile(false);
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", navigate);
    return () => window.removeEventListener("hashchange", navigate);
  }, [setOpenMobile, tab]);
  async function refresh() {
    const sequence = ++requestSequence.current;
    const catalogueVersion = ++catalogueSequence.current;
    setReviewLoadingMore(false);
    setPageBusy(false);
    setPageError("");
    setOrdersCursor(null);
    setCatalogueCursor(null);
    setReviewCursor(null);
    setLoading(true);
    setError("");
    try {
      const config = await api("/api/config");
      if (sequence !== requestSequence.current) return;
      setGoogleEnabled(config.googleEnabled);
      setDevLoginEnabled(config.devLoginEnabled);
      const setup = await api("/api/setup");
      if (sequence !== requestSequence.current) return;
      setInitialized(setup.initialized);
      const session =
        config.googleEnabled || config.devLoginEnabled
          ? await api("/api/auth/get-session?disableCookieCache=true")
          : null;
      if (sequence !== requestSequence.current) return;
      if (session?.user?.id !== user?.id) {
        ++ownerSequence.current;
        operation.current = null;
        setBusy(false);
        ++dialogSequence.current;
        setDetailOpen(null);
        setCreateOpen(false);
        setInventoryVariant("");
        setOrders([]);
        setCatalogue([]);
        setOrdersCursor(null);
        setCatalogueCursor(null);
        setReview([]);
        setReviewCursor(null);
      }
      setUser(session?.user ?? null);
      if (!setup.initialized || !session?.user) {
        setOrders([]);
        setCatalogue([]);
        setOrdersCursor(null);
        setCatalogueCursor(null);
        setDetailOpen(null);
        setCreateOpen(false);
        ++dialogSequence.current;
        setReview([]);
        setReviewCursor(null);
        return;
      }
      if (["products", "inventory", "campaigns"].includes(tab)) {
        const data = await api("/api/admin/products");
        if (
          sequence !== requestSequence.current ||
          catalogueVersion !== catalogueSequence.current
        )
          return;
        setCatalogue(data.products);
        setCatalogueCursor(data.nextCursor);
      } else if (tab === "review") {
        const data = await api("/api/admin/review");
        if (sequence !== requestSequence.current) return;
        setReview(data.items);
        setReviewCursor(data.nextCursor);
        setReviewPageError("");
      } else if (tab === "orders") {
        const data = await api("/api/admin/orders");
        if (sequence !== requestSequence.current) return;
        setOrders(data.orders);
        setOrdersCursor(data.nextCursor);
      }
    } catch (e) {
      if (sequence === requestSequence.current) setError((e as Error).message);
    } finally {
      if (sequence === requestSequence.current) setLoading(false);
    }
  }
  async function loadMoreCatalogOrOrders() {
    const products = ["products", "inventory", "campaigns"].includes(tab);
    const cursor = products ? catalogueCursor : ordersCursor;
    if (!cursor || pageBusy || loading) return;
    const sequence = requestSequence.current;
    const catalogueVersion = catalogueSequence.current;
    setPageBusy(true);
    setPageError("");
    try {
      const query = products
        ? new URLSearchParams({ after: String(cursor) })
        : new URLSearchParams({
            before: String(ordersCursor!.before),
            beforeId: ordersCursor!.beforeId,
          });
      const data = await api(
        `/api/admin/${products ? "products" : "orders"}?${query}`,
      );
      if (
        sequence !== requestSequence.current ||
        (products && catalogueVersion !== catalogueSequence.current)
      )
        return;
      if (products) {
        setCatalogue((rows) => [
          ...rows,
          ...data.products.filter(
            (p: any) => !rows.some((row) => row.id === p.id),
          ),
        ]);
        setCatalogueCursor(data.nextCursor);
      } else {
        setOrders((rows) => [
          ...rows,
          ...data.orders.filter(
            (o: any) => !rows.some((row) => row.id === o.id),
          ),
        ]);
        setOrdersCursor(data.nextCursor);
      }
    } catch (e) {
      if (
        sequence === requestSequence.current &&
        (!products || catalogueVersion === catalogueSequence.current)
      )
        setPageError((e as Error).message);
    } finally {
      if (
        sequence === requestSequence.current &&
        (!products || catalogueVersion === catalogueSequence.current)
      )
        setPageBusy(false);
    }
  }
  async function refreshLoadedCatalogue(owner = renderedOwner, selected = catalogueView.current.selected) {
    if (owner !== ownerSequence.current) return;
    const sequence = requestSequence.current;
    const catalogueVersion = ++catalogueSequence.current;
    setPageBusy(false);
    const targetCount = catalogueView.current.count;
    let rows: any[] = [],
      after: string | null = null;
    do {
      const data = await api(
        `/api/admin/products${after ? `?${new URLSearchParams({ after })}` : ""}`,
      );
      if (
        sequence !== requestSequence.current ||
        catalogueVersion !== catalogueSequence.current ||
        owner !== ownerSequence.current
      )
        return;
      rows = [...rows, ...data.products];
      after = data.nextCursor;
    } while (
      after &&
      (rows.length < targetCount ||
        (selected && !rows.some((row) => row.id === selected)))
    );
    setCatalogue(rows);
    setCatalogueCursor(after);
  }
  async function retryLoadedCatalogue(selected = catalogueView.current.selected) {
    const owner = renderedOwner;
    setError("");
    try { await refreshLoadedCatalogue(owner, selected); }
    catch (e) {
      if (owner === ownerSequence.current) setError((e as Error).message);
    }
  }
  async function loadMoreReview() {
    if (!reviewCursor || reviewLoadingMore) return;
    const sequence = requestSequence.current;
    setReviewLoadingMore(true);
    setReviewPageError("");
    try {
      const query = new URLSearchParams({
        before: String(reviewCursor.before),
        beforeId: reviewCursor.beforeId,
      });
      const data = await api(`/api/admin/review?${query}`);
      if (sequence !== requestSequence.current) return;
      setReview((rows) => [
        ...rows,
        ...data.items.filter(
          (item: any) => !rows.some((row) => row.id === item.id),
        ),
      ]);
      setReviewCursor(data.nextCursor);
    } catch (e) {
      if (sequence === requestSequence.current)
        setReviewPageError((e as Error).message);
    } finally {
      if (sequence === requestSequence.current) setReviewLoadingMore(false);
    }
  }
  useEffect(() => {
    refresh();
    return () => {
      ++requestSequence.current;
    };
  }, [tab]);
  async function login() {
    if (busy) return;
    ++requestSequence.current;
    setReviewLoadingMore(false);
    setBusy(true);
    setError("");
    setMessage("");
    try {
      if (devLoginEnabled) {
        await api("/api/auth/development-login", {});
        await refresh();
      } else {
        const data = await api("/api/auth/sign-in/social", {
          provider: "google",
          callbackURL: location.origin + "/admin/",
        });
        if (!data.url) throw new Error("Google sign-in belum tersedia.");
        location.assign(data.url);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function logout() {
    ++ownerSequence.current;
    operation.current = null;
    ++requestSequence.current;
    ++dialogSequence.current;
    setDetailOpen(null);
    setCreateOpen(false);
    setOrders([]);
    setCatalogue([]);
    setOrdersCursor(null);
    setCatalogueCursor(null);
    setInventoryVariant("");
    setUser(null);
    setReviewLoadingMore(false);
    setReview([]);
    setReviewCursor(null);
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/sign-out", {});
      setMessage("");
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(
    e: React.FormEvent<HTMLFormElement>,
    path: string,
    build: (f: FormData) => unknown,
    method = "POST",
  ) {
    e.preventDefault();
    if (operation.current) return false;
    if (path.startsWith("/api/admin/orders/") && detailReady !== decodeURIComponent(path.split("/")[4])) return false;
    const token = Symbol();
    operation.current = token;
    const owner = ownerSequence.current;
    setBusy(true);
    setError("");
    setMessage("");
    const form = e.currentTarget;
    const sequence = requestSequence.current;
    const dialog = dialogSequence.current;
    let confirmed = false;
    try {
      await api(path, build(new FormData(form)), method);
      confirmed = true;
      if (owner !== ownerSequence.current) return false;
      if (path === "/api/admin/products" && dialog === dialogSequence.current) {
        setCreateOpen(false);
        setCreateImage("");
        setVariants([{ sku: "", name: "Default", price: "", weight: "", stock: "0", mode: "stock" }]);
        ++dialogSequence.current;
        operation.current = null;
        setBusy(false);
        setMessage("Produk tersimpan.");
      }
      if (path.startsWith("/api/admin/products")) {
        const reconciliationDialog = dialogSequence.current;
        try { await refreshLoadedCatalogue(owner); }
        catch (e) {
          if (owner === ownerSequence.current && reconciliationDialog === dialogSequence.current) setError(`Perubahan tersimpan; pemuatan ulang gagal: ${(e as Error).message}. Gunakan Perbarui.`);
        }
      }
      // Confirmed writes belong to the session and order, not the departed dialog.
      if (path.startsWith("/api/admin/orders/")) {
        const orderId = decodeURIComponent(path.split("/")[4]);
        setOrderRevisions((values) => ({ ...values, [orderId]: (values[orderId] ?? 0) + 1 }));
      }
      if (path === "/api/admin/inventory" || path === "/api/admin/campaigns") setRevision((v) => v + 1);
      if (
        dialog !== dialogSequence.current
      )
        return false;
      if (path.startsWith("/api/admin/orders/")) {
        setDetailReady(null);
        form.reset();
      } else if (path === "/api/admin/campaigns") {
        form.reset();
      } else if (path.startsWith("/api/admin/products")) {
        form.reset();
      } else if (path !== "/api/admin/inventory") await refresh();
      if (dialog !== dialogSequence.current) return false;
      setMessage("Perubahan tersimpan.");
      return true;
    } catch (e) {
      if (
        sequence === requestSequence.current &&
        dialog === dialogSequence.current
      )
        setError((e as Error).message);
      return confirmed;
    } finally {
      if (operation.current === token) {
        operation.current = null;
        setBusy(false);
      }
    }
  }
  const fields = (f: FormData, names: string[]) =>
    Object.fromEntries(names.map((n) => [n, f.get(n)]));
  const title = navigation.find(([id]) => id === tab)?.[1];
  const visibleProducts = catalogue.filter(
    (p) =>
      p.id === detailOpen ||
      `${p.name} ${p.variants.map((v: any) => v.sku).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const visibleOrders = orders.filter(
    (o) =>
      o.id === detailOpen ||
      `${o.reference} ${o.contact?.name ?? ""}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild tooltip="Flaremmerce">
                <a href="#orders">
                  <Store />
                  <span className="grid text-left">
                    <span className="font-semibold">Flaremmerce</span>
                    <span className="text-xs text-muted-foreground">
                      Administrasi toko
                    </span>
                  </span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Kelola toko</SidebarGroupLabel>
            <nav aria-label="Navigasi admin">
              <SidebarMenu>
                {navigation.map(([id, label, Icon]) => (
                  <SidebarMenuItem key={id}>
                    <SidebarMenuButton
                      asChild
                      isActive={tab === id}
                      tooltip={label}
                    >
                      <a
                        href={`#${id}`}
                        aria-current={tab === id ? "page" : undefined}
                        onClick={() => setOpenMobile(false)}
                      >
                        <Icon />
                        <span>{label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </nav>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild tooltip="Lihat toko">
                <a href="/">
                  <ExternalLink />
                  <span>Lihat toko</span>
                </a>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0">
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-6">
          <SidebarTrigger aria-label="Buka atau tutup navigasi" />
          <Separator orientation="vertical" className="h-4" />
          <span className="text-sm font-medium">{title}</span>
          <div className="ml-auto flex items-center gap-3">
            {devLoginEnabled && <Badge variant="outline">Dev</Badge>}
            {user ? (
              <>
                <span className="hidden text-sm text-muted-foreground sm:inline">
                  {user.name}
                </span>
                <Button variant="outline" onClick={logout} disabled={busy}>
                  <LogOut />
                  Keluar
                </Button>
              </>
            ) : (
              <Button
                variant="outline"
                onClick={login}
                disabled={busy || (!devLoginEnabled && !googleEnabled)}
              >
                <LogIn />
                {devLoginEnabled ? "Masuk admin dev" : "Masuk dengan Google"}
              </Button>
            )}
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6 lg:p-8">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {
                {
                  orders: "Kelola pembayaran dan pengiriman pesanan.",
                  products: "Kelola produk, varian, dan ketersediaan katalog.",
                  inventory: "Catat penyesuaian stok dan alasan perubahan.",
                  campaigns:
                    "Atur periode pre-order, kuota, dan estimasi kirim.",
                  review: "Tinjau pembayaran yang perlu pemeriksaan operator.",
                }[tab]
              }
            </p>
          </div>
          {error && !createOpen && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>
                {error}
                <Button
                  variant="outline"
                  disabled={loading || busy}
                  onClick={refresh}
                >
                  Muat ulang
                </Button>
              </AlertDescription>
            </Alert>
          )}
          {message && (
            <Alert role="status">
              <AlertDescription>{message}</AlertDescription>
            </Alert>
          )}
          {loading && (
            <div
              className="flex items-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
              Memuat data…
            </div>
          )}
          {!loading && !user ? (
            <Card className="max-w-lg">
              <CardHeader>
                <CardTitle>Masuk ke admin</CardTitle>
                <CardDescription>
                  {devLoginEnabled
                    ? "Development lokal. Tidak memerlukan akun Google atau password."
                    : "Gunakan akun Google yang memiliki akses administrator."}
                </CardDescription>
              </CardHeader>
              <CardContent className="grid gap-4">
                <Button
                  onClick={login}
                  disabled={busy || (!devLoginEnabled && !googleEnabled)}
                >
                  <LogIn />
                  {devLoginEnabled ? "Masuk admin dev" : "Masuk dengan Google"}
                </Button>
                {!googleEnabled && !devLoginEnabled && (
                  <p className="text-sm text-muted-foreground">
                    Google sign-in belum dikonfigurasi. Hubungi operator
                    deployment.
                  </p>
                )}
              </CardContent>
            </Card>
          ) : initialized === false && user ? (
            <Card className="max-w-lg">
              <CardHeader>
                <CardTitle>Aktifkan admin pertama</CardTitle>
                <CardDescription>
                  Gunakan bootstrap secret deployment. Setup ditutup setelah
                  berhasil.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <form
                  className="grid gap-4"
                  onSubmit={(e) =>
                    mutate(e, "/api/setup", (f) => ({
                      secret: f.get("bootstrapSecret"),
                    }))
                  }
                >
                  <Field
                    name="bootstrapSecret"
                    label="Bootstrap secret"
                    type="password"
                    autoComplete="off"
                  />
                  <Button disabled={busy}>Aktifkan admin pertama</Button>
                </form>
              </CardContent>
            </Card>
          ) : (
            user &&
            initialized && (
              <>
                {tab === "orders" && (
                  <>
                    <div className="grid gap-4 sm:grid-cols-3">
                      {[
                        ["Pesanan dimuat", orders.length],
                        [
                          "Menunggu pembayaran",
                          orders.filter((o) => o.status === "pending_payment")
                            .length,
                        ],
                        [
                          "Pembayaran terkonfirmasi",
                          orders.filter((o) => o.status === "paid").length,
                        ],
                      ].map(([label, count]) => (
                        <Card key={label}>
                          <CardHeader>
                            <CardDescription>{label}</CardDescription>
                            <CardTitle className="text-3xl tabular-nums">
                              {count}
                            </CardTitle>
                          </CardHeader>
                        </Card>
                      ))}
                    </div>
                    <Card>
                      <CardHeader>
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <CardTitle>Daftar pesanan</CardTitle>
                          <Button
                            variant="outline"
                            disabled={loading}
                            onClick={refresh}
                          >
                            <RefreshCw />
                            Perbarui
                          </Button>
                        </div>
                      </CardHeader>
                      <CardContent className="grid gap-4">
                        <div className="relative max-w-sm">
                          <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
                          <Input
                            aria-label="Cari pesanan"
                            className="pl-9"
                            placeholder="Cari di pesanan yang dimuat…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                          />
                        </div>
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Pesanan</TableHead>
                              <TableHead>Pelanggan</TableHead>
                              <TableHead>Pembayaran</TableHead>
                              <TableHead>Pengiriman</TableHead>
                              <TableHead className="text-right">
                                Total
                              </TableHead>
                              <TableHead>
                                <span className="sr-only">Aksi</span>
                              </TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {visibleOrders.map((o) => (
                              <TableRow key={o.id}>
                                <TableCell className="font-medium">
                                  {o.reference}
                                </TableCell>
                                <TableCell>
                                  {o.contact?.name || "Guest"}
                                </TableCell>
                                <TableCell>
                                  <Badge variant="outline">
                                    {statusLabels[o.status] || o.status}
                                  </Badge>
                                </TableCell>
                                <TableCell>
                                  {statusLabels[o.fulfillment] ||
                                    "Belum diproses"}
                                </TableCell>
                                <TableCell className="text-right tabular-nums">
                                  {money(o.total)}
                                </TableCell>
                                <TableCell>
                                  <Dialog
                                    open={detailOpen === o.id}
                                    onOpenChange={(open) => {
                                      ++dialogSequence.current;
                                      operation.current = null;
                                      setBusy(false);
                                      setDetailOpen(open ? o.id : null);
                                      setDetailReady(null);
                                      setError("");
                                    }}
                                  >
                                    <DialogTrigger asChild>
                                      <Button variant="ghost" size="sm">
                                        Detail
                                        <span className="sr-only">
                                          {" "}
                                          {o.reference}
                                        </span>
                                      </Button>
                                    </DialogTrigger>
                                    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
                                      <DialogHeader>
                                        <DialogTitle>
                                          Pesanan {o.reference}
                                        </DialogTitle>
                                        <DialogDescription>
                                          {o.contact?.name || "Guest"} ·{" "}
                                          {money(o.total)} ·{" "}
                                          {statusLabels[o.status] || o.status}
                                        </DialogDescription>
                                      </DialogHeader>
                                      {detailOpen === o.id && (
                                        <>
                                          <OrderSnapshot
                                            key={o.id}
                                            revision={orderRevisions[o.id] ?? 0}
                                            id={o.id}
                                            api={api}
                                            onLoading={() =>
                                              setDetailReady(null)
                                            }
                                            onLoaded={(order) => {
                                              setDetailReady(order.id);
                                              setOrders((rows) =>
                                                rows.map((row) =>
                                                  row.id === order.id
                                                    ? { ...row, ...order }
                                                    : row,
                                                ),
                                              );
                                            }}
                                          />
                                          <div hidden={detailReady !== o.id}>
                                          {o.status === "paid" &&
                                            [
                                              "unfulfilled",
                                              "processing",
                                              "shipped",
                                            ].includes(o.fulfillment) && (
                                              <>
                                                <form
                                                  className="grid gap-4"
                                                  onSubmit={(e) =>
                                                    mutate(
                                                      e,
                                                      `/api/admin/orders/${encodeURIComponent(o.id)}/fulfillment`,
                                                      (f) => ({
                                                        status: f.get("status"),
                                                        ...(f.get("tracking")
                                                          ? {
                                                              tracking:
                                                                f.get(
                                                                  "tracking",
                                                                ),
                                                            }
                                                          : {}),
                                                        ...(f.get("note")
                                                          ? {
                                                              note: f.get(
                                                                "note",
                                                              ),
                                                            }
                                                          : {}),
                                                      }),
                                                      "PATCH",
                                                    )
                                                  }
                                                >
                                                  <fieldset
                                                    disabled={busy || detailReady !== o.id}
                                                    className="grid gap-4"
                                                  >
                                                    <h2 className="font-medium">
                                                      Pengiriman
                                                    </h2>
                                                    <Label className="grid gap-2">
                                                      Ubah status pengiriman
                                                      <NativeSelect
                                                        key={o.fulfillment}
                                                        name="status"
                                                        className="w-full"
                                                        defaultValue={
                                                          o.fulfillment ===
                                                          "processing"
                                                            ? "shipped"
                                                            : [
                                                                  "shipped",
                                                                  "delivered",
                                                                ].includes(
                                                                  o.fulfillment,
                                                                )
                                                              ? "delivered"
                                                              : "processing"
                                                        }
                                                      >
                                                        {o.fulfillment ===
                                                          "unfulfilled" && (
                                                          <NativeSelectOption value="processing">
                                                            Sedang dipersiapkan
                                                          </NativeSelectOption>
                                                        )}
                                                        {o.fulfillment ===
                                                          "processing" && (
                                                          <NativeSelectOption value="shipped">
                                                            Dikirim
                                                          </NativeSelectOption>
                                                        )}
                                                        {o.fulfillment ===
                                                          "shipped" && (
                                                          <NativeSelectOption value="delivered">
                                                            Diterima
                                                          </NativeSelectOption>
                                                        )}
                                                      </NativeSelect>
                                                    </Label>
                                                    <div className="grid gap-4 sm:grid-cols-2">
                                                      <Field
                                                        name="tracking"
                                                        label="Nomor resi"
                                                        required={
                                                          o.fulfillment ===
                                                          "processing"
                                                        }
                                                        disabled={busy}
                                                      />
                                                      <Field
                                                        name="note"
                                                        label="Catatan timeline"
                                                        required={false}
                                                      />
                                                    </div>
                                                    <Button
                                                      className="justify-self-start"
                                                      disabled={
                                                        busy ||
                                                        o.status !== "paid"
                                                      }
                                                    >
                                                      Simpan fulfillment
                                                    </Button>
                                                  </fieldset>
                                                </form>
                                              </>
                                            )}
                                          <Separator />
                                          {o.status === "paid" && (
                                              <>
                                                <form
                                                  className="grid gap-4"
                                                  onSubmit={(e) =>
                                                    mutate(
                                                      e,
                                                      `/api/admin/orders/${encodeURIComponent(o.id)}/timeline`,
                                                      (f) => ({
                                                        ...fields(f, [
                                                          "kind",
                                                          "note",
                                                        ]),
                                                        ...(f.get(
                                                          "estimatedDate",
                                                        )
                                                          ? {
                                                              estimatedDate:
                                                                f.get(
                                                                  "estimatedDate",
                                                                ),
                                                            }
                                                          : {}),
                                                      }),
                                                    )
                                                  }
                                                >
                                                  <fieldset
                                                    disabled={busy || detailReady !== o.id}
                                                    className="grid gap-4"
                                                  >
                                                    <h2 className="font-medium">
                                                      Timeline persiapan
                                                    </h2>
                                                    <Label className="grid gap-2">
                                                      Milestone persiapan
                                                      <NativeSelect
                                                        name="kind"
                                                        className="w-full"
                                                      >
                                                        <NativeSelectOption value="preparing">
                                                          Persiapan
                                                        </NativeSelectOption>
                                                        <NativeSelectOption value="production">
                                                          Produksi
                                                        </NativeSelectOption>
                                                        <NativeSelectOption value="ready_to_ship">
                                                          Siap kirim
                                                        </NativeSelectOption>
                                                      </NativeSelect>
                                                    </Label>
                                                    <Field
                                                      name="note"
                                                      label="Catatan milestone"
                                                    />
                                                    <Field
                                                      name="estimatedDate"
                                                      label="Estimasi tanggal (opsional, bukan jaminan)"
                                                      type="date"
                                                      required={false}
                                                    />
                                                    <Button
                                                      className="justify-self-start"
                                                      disabled={
                                                        busy ||
                                                        o.status !== "paid"
                                                      }
                                                    >
                                                      Tambahkan timeline
                                                    </Button>
                                                  </fieldset>
                                                </form>
                                              </>
                                            )}
                                          <p className="text-xs text-muted-foreground">
                                            Pembayaran pending tidak boleh
                                            memicu pengiriman.
                                          </p>
                                          </div>
                                          {error && (
                                            <Alert variant="destructive">
                                              <AlertDescription>
                                                {error}
                                              </AlertDescription>
                                            </Alert>
                                          )}
                                        </>
                                      )}
                                    </DialogContent>
                                  </Dialog>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                        {!visibleOrders.length && (
                          <Empty>
                            <EmptyHeader>
                              <EmptyMedia variant="icon">
                                <ClipboardList />
                              </EmptyMedia>
                              <EmptyTitle>
                                {search
                                  ? "Tidak ada hasil"
                                  : "Belum ada pesanan"}
                              </EmptyTitle>
                              <EmptyDescription>
                                {search
                                  ? "Coba referensi atau nama pelanggan lain."
                                  : "Pesanan baru akan tampil di sini."}
                              </EmptyDescription>
                            </EmptyHeader>
                          </Empty>
                        )}
                      </CardContent>
                    </Card>
                  </>
                )}
                {tab === "products" && (
                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle>
                          Katalog produk{" "}
                          <Badge variant="secondary" className="ml-2">
                            {catalogue.length}
                          </Badge>
                        </CardTitle>
                        <Dialog
                          open={createOpen}
                          onOpenChange={(open) => {
                            ++dialogSequence.current;
                            operation.current = null;
                            setBusy(false);
                            setCreateOpen(open);
                            setError("");
                            if (!open) {
                              setCreateImage("");
                              setUploadPending(false);
                            }
                          }}
                        >
                          <DialogTrigger asChild>
                            <Button>
                              <Plus />
                              Tambah produk
                            </Button>
                          </DialogTrigger>
                          <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
                            <DialogHeader>
                              <DialogTitle>Tambah produk</DialogTitle>
                              <DialogDescription>
                                Lengkapi informasi produk dan varian. Harga
                                dalam IDR, berat dalam gram.
                              </DialogDescription>
                            </DialogHeader>
                            <form
                              className="grid gap-5"
                              onSubmit={async (e) => {
                                if (uploadPending) {
                                  e.preventDefault();
                                  return;
                                }
                                if (
                                  await mutate(
                                    e,
                                    "/api/admin/products",
                                    (f) => ({
                                      ...fields(f, [
                                        "name",
                                        "slug",
                                        "description",
                                      ]),
                                      ...(createImage || f.get("imageUrl")
                                        ? {
                                            imageUrl:
                                              createImage || f.get("imageUrl"),
                                          }
                                        : {}),
                                      variants: variants.map((v) => ({
                                        ...v,
                                        price: Number(v.price),
                                        weight: Number(v.weight),
                                        stock: Number(v.stock),
                                      })),
                                    }),
                                  )
                                ) {
                                  setCreateOpen(false);
                                  setCreateImage("");
                                  setVariants([
                                    {
                                      sku: "",
                                      name: "Default",
                                      price: "",
                                      weight: "",
                                      stock: "0",
                                      mode: "stock",
                                    },
                                  ]);
                                }
                              }}
                            >
                              <fieldset disabled={busy} className="grid gap-5">
                                <div className="grid gap-4 sm:grid-cols-2">
                                  <Field name="name" label="Nama produk" />
                                  <Field
                                    name="slug"
                                    label="Slug"
                                    pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                                  />
                                </div>
                                <Label className="grid gap-2">
                                  Deskripsi
                                  <Textarea
                                    name="description"
                                    required
                                    rows={3}
                                  />
                                </Label>
                                <Field
                                  name="imageUrl"
                                  label="URL media publik (opsional)"
                                  type="url"
                                  required={false}
                                  disabled={!!createImage || uploadPending}
                                />
                                {createOpen && (
                                  <PhotoUpload
                                    onImage={setCreateImage}
                                    onPending={setUploadPending}
                                    disabled={busy}
                                  />
                                )}
                                {variants.map((v, i) => (
                                  <fieldset
                                    key={i}
                                    className="grid gap-4 rounded-lg border p-4"
                                  >
                                    <legend className="px-1 text-sm font-medium">
                                      Varian {i + 1}
                                    </legend>
                                    <div className="grid gap-4 sm:grid-cols-2">
                                      {(
                                        [
                                          "sku",
                                          "name",
                                          "price",
                                          "weight",
                                          "stock",
                                        ] as const
                                      ).map((name, n) => (
                                        <Field
                                          key={name}
                                          name={`variant-${i}-${name}`}
                                          label={
                                            [
                                              "SKU unik",
                                              "Nama varian",
                                              "Harga (IDR)",
                                              "Berat (g)",
                                              "Stok awal",
                                            ][n]
                                          }
                                          required
                                          value={v[name]}
                                          type={n > 1 ? "number" : "text"}
                                          min={name === "stock" ? 0 : 1}
                                          step="1"
                                          onChange={(e) =>
                                            setVariants(
                                              variants.map((variant, j) =>
                                                j === i
                                                  ? {
                                                      ...variant,
                                                      [name]: e.target.value,
                                                    }
                                                  : variant,
                                              ),
                                            )
                                          }
                                        />
                                      ))}
                                      <Label className="grid gap-2">
                                        Mode penjualan
                                        <NativeSelect
                                          className="w-full"
                                          value={v.mode}
                                          onChange={(e) =>
                                            setVariants(
                                              variants.map((variant, j) =>
                                                j === i
                                                  ? {
                                                      ...variant,
                                                      mode: e.target.value,
                                                    }
                                                  : variant,
                                              ),
                                            )
                                          }
                                        >
                                          <NativeSelectOption value="stock">
                                            Ready stock
                                          </NativeSelectOption>
                                          <NativeSelectOption value="preorder">
                                            Pre-order (campaign wajib)
                                          </NativeSelectOption>
                                        </NativeSelect>
                                      </Label>
                                    </div>
                                    {variants.length > 1 && (
                                      <Button
                                        className="justify-self-start"
                                        variant="destructive"
                                        type="button"
                                        onClick={() =>
                                          setVariants(
                                            variants.filter((_, j) => j !== i),
                                          )
                                        }
                                      >
                                        Hapus varian
                                      </Button>
                                    )}
                                  </fieldset>
                                ))}
                                {error && (
                                  <Alert variant="destructive" role="alert">
                                    <AlertDescription>{error}</AlertDescription>
                                  </Alert>
                                )}
                                <div className="flex flex-wrap justify-between gap-3">
                                  <Button
                                    variant="outline"
                                    type="button"
                                    onClick={() =>
                                      setVariants([
                                        ...variants,
                                        {
                                          sku: "",
                                          name: "",
                                          price: "",
                                          weight: "",
                                          stock: "0",
                                          mode: "stock",
                                        },
                                      ])
                                    }
                                  >
                                    <Plus />
                                    Tambah varian
                                  </Button>
                                  <Button disabled={busy || uploadPending}>
                                    {busy && (
                                      <LoaderCircle className="animate-spin motion-reduce:animate-none" />
                                    )}
                                    Simpan produk
                                  </Button>
                                </div>
                              </fieldset>
                            </form>
                          </DialogContent>
                        </Dialog>
                      </div>
                    </CardHeader>
                    <CardContent className="grid gap-4">
                      <div className="relative max-w-sm">
                        <Search className="absolute top-2 left-2.5 size-4 text-muted-foreground" />
                        <Input
                          className="pl-9"
                          aria-label="Cari produk"
                          placeholder="Cari di produk yang dimuat…"
                          value={search}
                          onChange={(e) => setSearch(e.target.value)}
                        />
                      </div>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Produk</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Varian</TableHead>
                            <TableHead className="text-right">
                              Harga mulai
                            </TableHead>
                            <TableHead>
                              <span className="sr-only">Aksi</span>
                            </TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleProducts.map((p) => (
                            <TableRow key={p.id}>
                              <TableCell>
                                <div className="font-medium">{p.name}</div>
                                <div className="text-xs text-muted-foreground">
                                  /{p.slug}
                                </div>
                              </TableCell>
                              <TableCell>
                                <Badge
                                  variant={p.active ? "secondary" : "outline"}
                                >
                                  {p.active ? "Aktif" : "Arsip"}
                                </Badge>
                              </TableCell>
                              <TableCell>{p.variants.length}</TableCell>
                              <TableCell className="text-right tabular-nums">
                                {p.variants.length
                                  ? money(
                                      Math.min(
                                        ...p.variants.map((v: any) => v.price),
                                      ),
                                    )
                                  : "—"}
                              </TableCell>
                              <TableCell>
                                <div className="flex justify-end gap-2">
                                  <Dialog
                                    open={detailOpen === p.id}
                                    onOpenChange={(open) => {
                                      ++dialogSequence.current;
                                      operation.current = null;
                                      setBusy(false);
                                      setDetailOpen(open ? p.id : null);
                                      if (open) void retryLoadedCatalogue(p.id);
                                    }}
                                  >
                                    <DialogTrigger asChild>
                                      <Button variant="ghost" size="sm">
                                        Detail
                                        <span className="sr-only">
                                          {" "}
                                          {p.name}
                                        </span>
                                      </Button>
                                    </DialogTrigger>
                                    <DialogContent className="max-h-[85svh] overflow-y-auto sm:max-w-2xl">
                                      <DialogHeader>
                                        <DialogTitle>{p.name}</DialogTitle>
                                        <DialogDescription>
                                          Varian produk dan identitas untuk
                                          penyesuaian inventori.
                                        </DialogDescription>
                                      </DialogHeader>
                                      <p className="break-all text-xs text-muted-foreground">
                                        ID produk: {p.id}
                                      </p>
                                      {detailOpen === p.id && (
                                        <>
                                          <Button variant="outline" onClick={() => retryLoadedCatalogue()}>
                                            Perbarui produk
                                          </Button>
                                          {error && <p role="alert">{error}</p>}
                                          <CatalogEditor
                                            product={p}
                                            api={api}
                                            onSaved={refreshLoadedCatalogue}
                                          />
                                          <PrimaryPhoto
                                            product={p}
                                            onSaved={refreshLoadedCatalogue}
                                          />
                                        </>
                                      )}
                                      <Table>
                                        <TableHeader>
                                          <TableRow>
                                            <TableHead>
                                              SKU / ID varian
                                            </TableHead>
                                            <TableHead>Mode</TableHead>
                                            <TableHead className="text-right">
                                              Harga
                                            </TableHead>
                                          </TableRow>
                                        </TableHeader>
                                        <TableBody>
                                          {p.variants.map((v: any) => (
                                            <TableRow key={v.id}>
                                              <TableCell>
                                                <div className="font-medium">
                                                  {v.sku}
                                                </div>
                                                <div className="text-xs text-muted-foreground">
                                                  {v.id}
                                                </div>
                                              </TableCell>
                                              <TableCell>
                                                {v.mode === "preorder"
                                                  ? "Pre-order"
                                                  : "Ready stock"}
                                              </TableCell>
                                              <TableCell className="text-right">
                                                {money(v.price)}
                                              </TableCell>
                                            </TableRow>
                                          ))}
                                        </TableBody>
                                      </Table>
                                    </DialogContent>
                                  </Dialog>
                                  <form
                                    onSubmit={(e) =>
                                      mutate(
                                        e,
                                        `/api/admin/products/${p.id}`,
                                        () => ({ active: !p.active, version: p.version }),
                                        "PATCH",
                                      )
                                    }
                                  >
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      disabled={busy}
                                    >
                                      {p.active
                                        ? "Arsipkan"
                                        : "Aktifkan kembali"}
                                    </Button>
                                  </form>
                                </div>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                      {!visibleProducts.length && (
                        <Empty>
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <Package />
                            </EmptyMedia>
                            <EmptyTitle>
                              {search ? "Tidak ada hasil" : "Belum ada produk"}
                            </EmptyTitle>
                            <EmptyDescription>
                              {search
                                ? "Coba nama produk atau SKU lain."
                                : "Tambahkan produk pertama ke katalog."}
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      )}
                    </CardContent>
                  </Card>
                )}
                {tab === "inventory" && (
                  <Card className="max-w-2xl">
                    <CardHeader>
                      <CardTitle>Penyesuaian stok</CardTitle>
                      <CardDescription>
                        Setiap perubahan dicatat dalam ledger. Nilai negatif
                        mengurangi stok fisik, bukan membatalkan reservasi.
                      </CardDescription>
                    </CardHeader>
                    <CardContent className="grid gap-5">
                      <InventoryLedger
                        key={user.id}
                        variantId={inventoryVariant}
                        api={api}
                        revision={revision}
                      />
                      <form
                        className="grid gap-5"
                        onSubmit={(e) =>
                          mutate(e, "/api/admin/inventory", (f) => ({
                            variantId: f.get("variantId"),
                            delta: Number(f.get("delta")),
                            reason: f.get("reason"),
                          }))
                        }
                      >
                        <fieldset disabled={busy} className="grid gap-5">
                          <Label className="grid gap-2">
                            Varian produk
                            <NativeSelect
                              className="w-full"
                              name="variantId"
                              required
                              value={inventoryVariant}
                              disabled={busy}
                              onChange={(e) =>
                                setInventoryVariant(e.target.value)
                              }
                            >
                              <NativeSelectOption value="" disabled>
                                Pilih produk dan varian
                              </NativeSelectOption>
                              {catalogue.flatMap((p) =>
                                p.variants.map((v: any) => (
                                  <NativeSelectOption key={v.id} value={v.id}>
                                    {p.name} · {v.sku}
                                  </NativeSelectOption>
                                )),
                              )}
                            </NativeSelect>
                          </Label>
                          <Field
                            name="delta"
                            label="Perubahan stok (+ / −)"
                            type="number"
                            step="1"
                          />
                          <Field name="reason" label="Alasan perubahan" />
                          <Button
                            className="justify-self-start"
                            disabled={busy || !inventoryVariant}
                          >
                            Catat penyesuaian
                          </Button>
                        </fieldset>
                      </form>
                    </CardContent>
                  </Card>
                )}
                {tab === "campaigns" && (
                  <>
                    <CampaignList key={user.id} api={api} revision={revision} onSaved={async () => {
                      if (renderedOwner === ownerSequence.current) setRevision((v) => v + 1);
                    }} />
                    <Card className="max-w-2xl">
                      <CardHeader>
                        <CardTitle>Campaign pre-order</CardTitle>
                        <CardDescription>
                          Rentang kirim adalah estimasi, bukan jaminan. Campaign
                          aktif tidak boleh tumpang tindih.
                        </CardDescription>
                      </CardHeader>
                      <CardContent>
                        <form
                          className="grid gap-5"
                          onSubmit={(e) =>
                            mutate(e, "/api/admin/campaigns", (f) => ({
                              variantId: f.get("variantId"),
                              startsAt: new Date(
                                String(f.get("startsAt")) + "+07:00",
                              ).getTime(),
                              endsAt: new Date(
                                String(f.get("endsAt")) + "+07:00",
                              ).getTime(),
                              shipFrom: f.get("shipFrom"),
                              shipTo: f.get("shipTo"),
                              quota:
                                f.get("quota") === ""
                                  ? null
                                  : Number(f.get("quota")),
                            }))
                          }
                        >
                          <fieldset disabled={busy} className="grid gap-5">
                            <Label className="grid gap-2">
                              Varian pre-order
                              <NativeSelect
                                className="w-full"
                                name="variantId"
                                required
                                defaultValue=""
                              >
                                <NativeSelectOption value="" disabled>
                                  Pilih varian pre-order
                                </NativeSelectOption>
                                {catalogue.flatMap((p) =>
                                  p.variants
                                    .filter(
                                      (v: any) =>
                                        p.active &&
                                        v.active &&
                                        v.mode === "preorder",
                                    )
                                    .map((v: any) => (
                                      <NativeSelectOption
                                        key={v.id}
                                        value={v.id}
                                      >
                                        {p.name} · {v.sku}
                                      </NativeSelectOption>
                                    )),
                                )}
                              </NativeSelect>
                            </Label>
                            <div className="grid gap-4 sm:grid-cols-2">
                              <Field
                                name="startsAt"
                                label="Mulai pemesanan (WIB)"
                                type="datetime-local"
                              />
                              <Field
                                name="endsAt"
                                label="Akhir pemesanan (WIB)"
                                type="datetime-local"
                              />
                              <Field
                                name="shipFrom"
                                label="Estimasi kirim dari"
                                type="date"
                              />
                              <Field
                                name="shipTo"
                                label="Estimasi kirim sampai"
                                type="date"
                              />
                            </div>
                            <Field
                              name="quota"
                              label="Kuota (kosong = tanpa batas)"
                              type="number"
                              required={false}
                              min="1"
                              step="1"
                            />
                            <Button
                              className="justify-self-start"
                              disabled={busy}
                            >
                              Simpan campaign
                            </Button>
                          </fieldset>
                        </form>
                      </CardContent>
                    </Card>
                  </>
                )}
                {["products", "orders", "inventory", "campaigns"].includes(
                  tab,
                ) && (
                  <div className="grid justify-items-start gap-3">
                    <p className="text-sm text-muted-foreground">
                      {tab === "orders"
                        ? `${orders.length} pesanan dimuat. Pencarian hanya mencakup baris yang dimuat.`
                        : `${catalogue.length} produk dimuat. Pilihan varian dan pencarian hanya mencakup produk yang dimuat.`}
                    </p>
                    {pageError && (
                      <p role="alert" className="text-destructive">
                        {pageError}
                      </p>
                    )}
                    {(tab === "orders" ? ordersCursor : catalogueCursor) && (
                      <Button
                        variant="outline"
                        disabled={loading || pageBusy || busy}
                        onClick={loadMoreCatalogOrOrders}
                      >
                        {pageBusy
                          ? "Memuat…"
                          : pageError
                            ? "Coba lagi"
                            : tab === "orders"
                              ? "Muat pesanan berikutnya"
                              : "Muat produk berikutnya"}
                      </Button>
                    )}
                  </div>
                )}
                {tab === "operations" && <OperationalStatus key={user.id} api={api} />}
                {tab === "review" && (
                  <Card>
                    <CardHeader>
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <CardTitle>Pemeriksaan operator</CardTitle>
                        <Button
                          variant="outline"
                          disabled={loading || reviewLoadingMore}
                          onClick={refresh}
                        >
                          <RefreshCw />
                          Perbarui
                        </Button>
                      </div>
                      <CardDescription>
                        Hasil pembayaran ambigu bukan bukti gagal atau berhasil.
                        Periksa bukti authoritative sebelum tindakan
                        operasional.
                      </CardDescription>
                    </CardHeader>
                    <CardContent>
                      {!review.length ? (
                        <Empty>
                          <EmptyHeader>
                            <EmptyMedia variant="icon">
                              <ShieldCheck />
                            </EmptyMedia>
                            <EmptyTitle>Tidak ada item review</EmptyTitle>
                            <EmptyDescription>
                              Pembayaran yang perlu diperiksa akan ditampilkan
                              di sini.
                            </EmptyDescription>
                          </EmptyHeader>
                        </Empty>
                      ) : (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Referensi</TableHead>
                              <TableHead>Alasan</TableHead>
                              <TableHead>Waktu (WIB)</TableHead>
                              <TableHead>Status / tindakan</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {review.map((item, i) => (
                              <TableRow key={item.id || i}>
                                <TableCell>
                                  {item.reference ||
                                    item.orderReference ||
                                    item.id ||
                                    "Item review"}
                                </TableCell>
                                <TableCell>
                                  {reviewReasons[item.reason] ||
                                    item.reason ||
                                    item.status ||
                                    item.type ||
                                    "Perlu pemeriksaan"}
                                </TableCell>
                                <TableCell>
                                  {item.createdAt
                                    ? new Date(item.createdAt).toLocaleString(
                                        "id-ID",
                                        { timeZone: "Asia/Jakarta" },
                                      )
                                    : "—"}
                                </TableCell>
                                <TableCell>
                                  <div className="flex flex-wrap items-center gap-2">
                                    <Badge
                                      variant={
                                        item.status === "open"
                                          ? "outline"
                                          : "secondary"
                                      }
                                    >
                                      {item.status === "open"
                                        ? "Perlu ditangani"
                                        : "Ditangani"}
                                    </Badge>
                                    <ReviewDetail
                                      id={item.id}
                                      api={api}
                                      refresh={async () => {
                                        const sequence =
                                          requestSequence.current;
                                        const data = await api(
                                          `/api/admin/review/${encodeURIComponent(item.id)}`,
                                        );
                                        if (
                                          sequence !== requestSequence.current
                                        )
                                          return;
                                        setReview((rows) =>
                                          rows.map((row) =>
                                            row.id === item.id
                                              ? { ...row, ...data.item }
                                              : row,
                                          ),
                                        );
                                      }}
                                    />
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      )}
                      {reviewPageError && (
                        <p role="alert" className="mt-3 text-destructive">
                          {reviewPageError}
                        </p>
                      )}
                      {reviewCursor && (
                        <Button
                          className="mt-4"
                          variant="outline"
                          disabled={loading || reviewLoadingMore}
                          onClick={loadMoreReview}
                        >
                          {reviewLoadingMore
                            ? "Memuat…"
                            : reviewPageError
                              ? "Coba lagi"
                              : "Muat lebih banyak"}
                        </Button>
                      )}
                    </CardContent>
                  </Card>
                )}
              </>
            )
          )}
        </div>
      </SidebarInset>
    </>
  );
}
export function AdminApp() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <App />
      </SidebarProvider>
    </TooltipProvider>
  );
}
if (import.meta.env.MODE !== "test") {
  createRoot(document.getElementById("root")!).render(
    <React.StrictMode><AdminApp /></React.StrictMode>,
  );
}
