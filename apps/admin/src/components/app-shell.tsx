import React, { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  CalendarDays,
  ClipboardList,
  ExternalLink,
  Home,
  LogOut,
  Package,
  RefreshCw,
  ShieldCheck,
  ShieldAlert,
  Store,
  Tags,
  Users,
  Warehouse,
} from "lucide-react";
import { get } from "@/lib/api";
import { href, Link, useRoute } from "@/lib/router";
import { useSession } from "@/lib/auth";
import { money, roleLabel } from "@/lib/format";
import { useListHref } from "@/lib/list-memory";
import { SummaryProvider, useSummary } from "@/lib/summary";
import type { OrderSummary, VariantSearchResult } from "@/lib/types";
import { useHotkey } from "@/hooks/use-hotkeys";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/empty-state";
import { SearchStatusIcon } from "@/components/loading";
import { DashboardPage } from "@/pages/dashboard";
import { OrdersPage } from "@/pages/orders";
import { OrderDetailPage } from "@/pages/order-detail";
import { ProductsPage } from "@/pages/products";
import { ProductEditorPage } from "@/pages/product-editor";
import { InventoryPage } from "@/pages/inventory";
import { PreordersPage } from "@/pages/preorders";
import { CategoriesPage } from "@/pages/categories";
import { CustomersPage } from "@/pages/customers";
import { ReviewsPage } from "@/pages/reviews";
import { ReviewDetailPage } from "@/pages/review-detail";
import { BlocklistPage } from "@/pages/blocklist";
import { OperationsPage } from "@/pages/operations";
import { SettingsTeamPage } from "@/pages/settings-team";

const groups: {
  label: string | null;
  items: { name: string; listName?: string; title: string; icon: React.ComponentType; area: "any" | "ops" | "catalog" | "owner" }[];
}[] = [
  { label: null, items: [{ name: "dashboard", title: "Beranda", icon: Home, area: "any" }] },
  { label: "Penjualan", items: [{ name: "orders", title: "Pesanan", icon: ClipboardList, area: "ops" }] },
  {
    label: "Katalog",
    items: [
      { name: "products", title: "Produk", icon: Package, area: "catalog" },
      { name: "categories", title: "Kategori", icon: Tags, area: "catalog" },
      { name: "inventory", title: "Inventori", icon: Warehouse, area: "catalog" },
      { name: "preorders", title: "Pre-order", icon: CalendarDays, area: "catalog" },
    ],
  },
  { label: "Pelanggan", items: [{ name: "customers", title: "Pelanggan", icon: Users, area: "ops" }] },
  {
    label: "Risiko",
    items: [
      { name: "reviews", title: "Review", icon: ShieldCheck, area: "ops" },
      { name: "blocklist", title: "Blocklist", icon: ShieldAlert, area: "ops" },
    ],
  },
  {
    label: "Sistem",
    items: [
      { name: "operations", title: "Operasional", icon: RefreshCw, area: "ops" },
      { name: "settings-team", title: "Tim & akses", icon: Users, area: "owner" },
    ],
  },
];

/** Detail routes light up their list entry in the sidebar. */
const listOf: Record<string, string> = {
  "order-detail": "orders",
  "product-new": "products",
  "product-edit": "products",
  "review-detail": "reviews",
};

type SearchItem =
  | { kind: "order"; order: OrderSummary }
  | { kind: "orders"; q: string; count: number }
  | { kind: "variant"; variant: VariantSearchResult };

/**
 * Variants match live (after a pause) because the server searches SKU and names by substring.
 * Orders only match an exact reference, email or phone, so they are looked up on Enter.
 */
function GlobalSearch() {
  const { navigate } = useRoute();
  const { can } = useSession();
  const ops = can("ops"), catalog = can("catalog");
  const [term, setTerm] = useState("");
  const [open, setOpen] = useState(false);
  const [variants, setVariants] = useState<VariantSearchResult[] | null>(null);
  const [orders, setOrders] = useState<{ q: string; items: OrderSummary[] } | null>(null);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [searching, setSearching] = useState(false);
  const beginVariants = useLatestRequest();
  const beginOrders = useLatestRequest();
  const box = useRef<HTMLFormElement>(null);
  const listId = useId();
  const q = term.trim();

  const fetchVariants = useCallback(
    async (value: string) => {
      const controller = beginVariants();
      setSearching(true);
      try {
        const data = await get<{ variants: VariantSearchResult[] }>(`/api/admin/variants/search?${new URLSearchParams({ q: value })}`, controller.signal);
        if (controller.signal.aborted) return null;
        setVariants(data.variants);
        setOpen(true);
        return data.variants;
      } catch {
        if (!controller.signal.aborted) setVariants([]);
        return null;
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    },
    [beginVariants],
  );

  useEffect(() => {
    // The server caps the LIKE pattern at 50 bytes (48 plus wildcards); longer terms cannot match anyway.
    if (!catalog || q.length < 2 || new TextEncoder().encode(q).length > 48) {
      beginVariants();
      setVariants(null);
      setSearching(false);
      return;
    }
    const timer = setTimeout(() => void fetchVariants(q), 250);
    return () => clearTimeout(timer);
  }, [q, catalog, fetchVariants, beginVariants]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const items: SearchItem[] = [
    ...(orders?.items.map((order) => ({ kind: "order" as const, order })) ?? []),
    ...(orders && orders.items.length > 1 ? [{ kind: "orders" as const, q: orders.q, count: orders.items.length }] : []),
    ...(variants?.map((variant) => ({ kind: "variant" as const, variant })) ?? []),
  ];

  function reset() {
    setTerm("");
    setOpen(false);
    setVariants(null);
    setOrders(null);
    setActive(-1);
  }

  function choose(item: SearchItem) {
    reset();
    if (item.kind === "order") navigate(href("order-detail", { id: item.order.id }));
    else if (item.kind === "orders") navigate(href("orders", {}, { q: item.q }));
    else navigate(href("product-edit", { id: item.variant.productId }));
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (active >= 0 && items[active]) return choose(items[active]);
    if (!q || busy) return;
    setBusy(true);
    try {
      if (ops) {
        const controller = beginOrders();
        const data = await get<{ orders: OrderSummary[] }>(`/api/admin/orders?${new URLSearchParams({ q, limit: "5" })}`, controller.signal).catch(() => ({ orders: [] }));
        if (controller.signal.aborted) return;
        // A unique match (an exact reference, or an email/phone with one order) opens directly.
        if (data.orders.length === 1 && !variants?.length) return choose({ kind: "order", order: data.orders[0] });
        setOrders({ q, items: data.orders });
        setOpen(true);
        setActive(-1);
        return;
      }
      if (catalog) {
        const found = variants ?? (await fetchVariants(q));
        if (found?.length === 1) choose({ kind: "variant", variant: found[0] });
      }
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      event.preventDefault();
      if (open) setOpen(false);
      else if (term) reset();
      else event.currentTarget.blur();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!items.length) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      // Cycle through the options and back to the input itself (-1).
      const n = items.length + 1;
      setActive((i) => ((i + 1 + step + n) % n) - 1);
    }
  }

  const showPanel = open && !!q && (variants !== null || orders !== null || ops);
  const optionId = (i: number) => `${listId}-option-${i}`;
  let index = -1;
  const option = (item: SearchItem, content: React.ReactNode) => {
    const i = ++index;
    return (
      <div
        key={item.kind === "order" ? `o-${item.order.id}` : item.kind === "orders" ? "orders" : `v-${item.variant.id}`}
        id={optionId(i)}
        role="option"
        aria-selected={i === active}
        className={`flex w-full cursor-pointer flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left ${i === active ? "bg-accent" : "hover:bg-accent"}`}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setActive(i)}
        onClick={() => choose(item)}
      >
        {content}
      </div>
    );
  };

  return (
    <form ref={box} className="relative w-full max-w-sm" role="search" onSubmit={submit}>
      <SearchStatusIcon busy={busy || searching} />
      <Input
        id="global-search"
        role="combobox"
        aria-label="Pencarian global"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && active >= 0 ? optionId(active) : undefined}
        autoComplete="off"
        className="pl-9"
        placeholder="Referensi lengkap, email, HP, atau SKU…"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setOrders(null);
          setActive(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      {showPanel && (
        <div id={listId} role="listbox" aria-label="Hasil pencarian" className="absolute z-40 mt-1 max-h-96 w-full overflow-y-auto rounded-lg bg-popover p-1 text-sm shadow-md ring-1 ring-foreground/10">
          {ops && (
            <div role="group" aria-label="Pesanan">
              <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Pesanan</p>
              {orders === null && <p className="px-2 py-1.5 text-muted-foreground">Tekan Enter untuk mencari pesanan dengan referensi lengkap, email, atau HP.</p>}
              {orders?.items.length === 0 && <p className="px-2 py-1.5 text-muted-foreground">Tidak ada pesanan yang persis cocok dengan “{orders.q}”.</p>}
              {orders?.items.map((order) =>
                option(
                  { kind: "order", order },
                  <>
                    <span className="font-medium">{order.reference}</span>
                    <span className="min-w-0 flex-1 truncate">{order.contact?.name || "Guest"}</span>
                    <span className="text-muted-foreground tabular-nums">{money(order.total, order.currency)}</span>
                  </>,
                ),
              )}
              {orders && orders.items.length > 1 &&
                option({ kind: "orders", q: orders.q, count: orders.items.length }, <span className="text-muted-foreground underline underline-offset-4">Lihat semua di daftar pesanan</span>)}
            </div>
          )}
          {catalog && variants !== null && (
            <div role="group" aria-label="Produk">
              <p className="px-2 pt-1 pb-0.5 text-xs font-medium text-muted-foreground">Produk</p>
              {variants.length === 0 && <p className="px-2 py-1.5 text-muted-foreground">Tidak ada SKU atau produk yang cocok dengan “{q}”.</p>}
              {variants.map((variant) =>
                option(
                  { kind: "variant", variant },
                  <>
                    <span className="font-medium">{variant.sku}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {variant.productName} · {variant.name}
                    </span>
                  </>,
                ),
              )}
            </div>
          )}
        </div>
      )}
    </form>
  );
}

function Page({ name }: { name: string }) {
  switch (name) {
    case "dashboard":
      return <DashboardPage />;
    case "orders":
      return <OrdersPage />;
    case "order-detail":
      return <OrderDetailPage />;
    case "products":
      return <ProductsPage />;
    case "product-new":
    case "product-edit":
      return <ProductEditorPage />;
    case "inventory":
      return <InventoryPage />;
    case "preorders":
      return <PreordersPage />;
    case "categories":
      return <CategoriesPage />;
    case "customers":
      return <CustomersPage />;
    case "reviews":
      return <ReviewsPage />;
    case "review-detail":
      return <ReviewDetailPage />;
    case "blocklist":
      return <BlocklistPage />;
    case "operations":
      return <OperationsPage />;
    case "settings-team":
      return <SettingsTeamPage />;
    default:
      return (
        <EmptyState
          title="Halaman tidak ditemukan"
          description="Tautan yang dibuka tidak cocok dengan halaman admin mana pun."
        >
          <Button asChild variant="outline">
            <Link to="/">Kembali ke beranda</Link>
          </Button>
        </EmptyState>
      );
  }
}

function NavItem({ item, active }: { item: (typeof groups)[number]["items"][number]; active: boolean }) {
  const to = useListHref(item.name);
  const { summary, lowStock } = useSummary();
  const badge = item.name === "orders" ? summary?.toFulfill : item.name === "reviews" ? summary?.openReviews : item.name === "inventory" ? lowStock : null;
  const titles: Record<string, string> = { orders: "pesanan perlu diproses", reviews: "review terbuka", inventory: "varian stok menipis" };
  return (
    <SidebarMenuItem>
      <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
        <Link to={to} aria-current={active ? "page" : undefined}>
          <item.icon />
          <span>{item.title}</span>
        </Link>
      </SidebarMenuButton>
      {badge != null && badge > 0 && (
        <SidebarMenuBadge title={`${badge} ${titles[item.name]}`}>
          {item.name === "inventory" && badge >= 100 ? "99+" : badge}
        </SidebarMenuBadge>
      )}
    </SidebarMenuItem>
  );
}

function Shell() {
  const { route } = useRoute();
  const session = useSession();
  const { setOpenMobile } = useSidebar();
  const active = listOf[route.name] ?? route.name;

  useEffect(() => {
    setOpenMobile(false);
    document.getElementById("page-title")?.focus();
  }, [route, setOpenMobile]);

  const focusSearch = () => {
    const input = document.getElementById("global-search") as HTMLInputElement | null;
    input?.focus();
    input?.select();
  };
  useHotkey("mod+k", focusSearch);
  useHotkey("/", focusSearch);

  return (
    <>
      <Sidebar collapsible="icon">
        <SidebarHeader>
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" asChild tooltip="Flaremmerce">
                <Link to="/">
                  <Store />
                  <span className="grid text-left">
                    <span className="font-semibold">Flaremmerce</span>
                    <span className="text-xs text-muted-foreground">Administrasi toko</span>
                  </span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>
        <SidebarContent>
          {groups.map((group) => {
            const items = group.items.filter((item) => session.can(item.area));
            if (!items.length) return null;
            return (
              <SidebarGroup key={group.label ?? "beranda"}>
                {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
                <SidebarGroupContent>
                  <nav aria-label={group.label ?? "Beranda"}>
                    <SidebarMenu>
                      {items.map((item) => (
                        <NavItem key={item.name} item={item} active={active === item.name} />
                      ))}
                    </SidebarMenu>
                  </nav>
                </SidebarGroupContent>
              </SidebarGroup>
            );
          })}
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
        <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4 md:px-6 print:hidden">
          <SidebarTrigger aria-label="Buka atau tutup navigasi" />
          <Separator orientation="vertical" className="h-4" />
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-2">
            {session.config.devLoginEnabled && <Badge variant="outline">Dev</Badge>}
            {session.config.environment === "staging" && <Badge className="bg-yellow-300 font-bold tracking-widest text-black">STAGING</Badge>}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" aria-label={`Akun ${session.me.user.name}`}>
                  <span className="hidden max-w-32 truncate sm:inline">{session.me.user.name}</span>
                  <Badge variant="secondary">{roleLabel[session.me.role]}</Badge>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuLabel className="grid gap-0.5">
                  <span>{session.me.user.name}</span>
                  <span className="text-xs font-normal break-all">{session.me.user.email}</span>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={() => void session.logout()}>
                  <LogOut />
                  Keluar
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-4 md:p-6 lg:p-8 print:p-0">
          {!session.can(route.area) ? (
            <EmptyState
              title="Halaman tidak tersedia untuk peranmu"
              description={`Peran ${roleLabel[session.me.role]} tidak memiliki akses ke area ini.`}
            >
              <Button asChild variant="outline">
                <Link to="/">Kembali ke beranda</Link>
              </Button>
            </EmptyState>
          ) : (
            <div key={route.name} className="content-reveal flex flex-col gap-6">
              <Page name={route.name} />
            </div>
          )}
        </div>
      </SidebarInset>
    </>
  );
}

export function AppShell() {
  return (
    <TooltipProvider>
      <SidebarProvider>
        <SummaryProvider>
          <Shell />
        </SummaryProvider>
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
