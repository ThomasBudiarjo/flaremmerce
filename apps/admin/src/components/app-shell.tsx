import React, { useEffect, useState } from "react";
import {
  CalendarDays,
  ClipboardList,
  ExternalLink,
  Home,
  LogOut,
  Package,
  RefreshCw,
  Search,
  ShieldCheck,
  ShieldAlert,
  Store,
  Tags,
  Users,
  Warehouse,
} from "lucide-react";
import { get } from "@/lib/api";
import { href, Link, useRoute } from "@/lib/router";
import { useSession, areaAllowed } from "@/lib/auth";
import { roleLabel } from "@/lib/format";
import type { OrderSummary, Summary, VariantSearchResult } from "@/lib/types";
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

function GlobalSearch() {
  const { navigate } = useRoute();
  const { can } = useSession();
  const [term, setTerm] = useState("");
  const [variants, setVariants] = useState<VariantSearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function search(event: React.FormEvent) {
    event.preventDefault();
    const q = term.trim();
    if (!q || busy) return;
    setBusy(true);
    setVariants(null);
    try {
      if (can("ops")) {
        // An exact reference (or a unique email/phone match) opens the order directly.
        const data = await get<{ orders: OrderSummary[] }>(`/api/admin/orders?${new URLSearchParams({ q, limit: "5" })}`);
        if (data.orders.length === 1) {
          setTerm("");
          navigate(href("order-detail", { id: data.orders[0].id }));
          return;
        }
        if (data.orders.length > 1) {
          setTerm("");
          navigate(href("orders", {}, { q }));
          return;
        }
      }
      if (can("catalog")) {
        const data = await get<{ variants: VariantSearchResult[] }>(`/api/admin/variants/search?${new URLSearchParams({ q })}`);
        if (data.variants.length === 1) {
          setTerm("");
          navigate(href("product-edit", { id: data.variants[0].productId }));
          return;
        }
        setVariants(data.variants);
      }
    } catch {
      setVariants([]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="relative w-full max-w-sm" role="search" onSubmit={search}>
      <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
      <Input
        aria-label="Pencarian global"
        className="pl-9"
        placeholder="Cari referensi pesanan, email, SKU…"
        value={term}
        onChange={(e) => {
          setTerm(e.target.value);
          setVariants(null);
        }}
        disabled={busy}
      />
      {variants && (
        <div className="absolute z-40 mt-1 w-full rounded-lg bg-popover p-1 text-sm shadow-md ring-1 ring-foreground/10">
          {variants.length === 0 && <p className="p-2 text-muted-foreground">Tidak ada hasil untuk “{term}”.</p>}
          {variants.map((variant) => (
            <button
              key={variant.id}
              type="button"
              className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
              onClick={() => {
                setVariants(null);
                setTerm("");
                navigate(href("product-edit", { id: variant.productId }));
              }}
            >
              <span className="font-medium">{variant.sku}</span>
              <span className="min-w-0 flex-1 truncate">
                {variant.productName} · {variant.name}
              </span>
            </button>
          ))}
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

function Shell() {
  const { route } = useRoute();
  const session = useSession();
  const { setOpenMobile } = useSidebar();
  const [summary, setSummary] = useState<Summary | null>(null);
  const active = listOf[route.name] ?? route.name;

  useEffect(() => {
    setOpenMobile(false);
    document.getElementById("page-title")?.focus();
  }, [route, setOpenMobile]);

  useEffect(() => {
    if (!session.can("ops")) return;
    const controller = new AbortController();
    get<Summary>("/api/admin/summary?range=today", controller.signal)
      .then(setSummary)
      .catch(() => {});
    return () => controller.abort();
  }, [session]);

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
                        <SidebarMenuItem key={item.name}>
                          <SidebarMenuButton asChild isActive={active === item.name} tooltip={item.title}>
                            <Link to={href(item.name)} aria-current={active === item.name ? "page" : undefined}>
                              <item.icon />
                              <span>{item.title}</span>
                            </Link>
                          </SidebarMenuButton>
                          {item.name === "reviews" && summary != null && summary.openReviews > 0 && (
                            <SidebarMenuBadge>{summary.openReviews}</SidebarMenuBadge>
                          )}
                          {item.name === "orders" && summary != null && summary.toFulfill > 0 && (
                            <SidebarMenuBadge>{summary.toFulfill}</SidebarMenuBadge>
                          )}
                        </SidebarMenuItem>
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
            <Page name={route.name} />
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
        <Shell />
        <Toaster position="bottom-right" />
      </SidebarProvider>
    </TooltipProvider>
  );
}
