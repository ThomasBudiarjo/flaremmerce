import { useEffect, useState } from "react";
import { MoreHorizontal, SearchIcon } from "lucide-react";
import { post } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { href, Link, useRoute } from "@/lib/router";
import { dateWIB, number } from "@/lib/format";
import type { Customer } from "@/lib/types";
import { useMutation } from "@/hooks/use-mutation";
import { usePagedList } from "@/hooks/use-paged-list";
import { PageHeader } from "@/components/page-header";
import { DataTable } from "@/components/data-table";
import { FilterBar } from "@/components/filter-bar";
import { LoadError } from "@/components/field";
import { LoadMoreButton } from "@/components/loading";
import { CopyButton } from "@/components/copy-button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { TableCell, TableRow } from "@/components/ui/table";

type Action = { kind: "revoke" | "ban" | "unban"; customer: Customer };

const copy: Record<Action["kind"], { title: (c: Customer) => string; description: string; confirm: string }> = {
  revoke: { title: (c) => `Keluarkan ${c.name} dari semua perangkat?`, description: "Semua sesi login dihapus. Pelanggan bisa masuk lagi.", confirm: "Cabut sesi" },
  ban: {
    title: (c) => `Blokir akun ${c.name}?`,
    description: "Sesi aktif berakhir dan akun tidak bisa checkout atau melihat pesanan saat login. Pesanan lama tidak berubah.",
    confirm: "Blokir akun",
  },
  unban: { title: (c) => `Buka blokir ${c.name}?`, description: "Akun dapat login dan berbelanja kembali.", confirm: "Buka blokir" },
};

/** Server search matches name or email; D1 limits the LIKE pattern to 50 bytes. */
export const CUSTOMER_SEARCH_MAX = 48;

function StatusBadges({ customer }: { customer: Customer }) {
  return (
    <>
      {customer.banned && <Badge variant="destructive">Diblokir</Badge>}
      {customer.admin && <Badge variant="secondary">Admin</Badge>}
      {!customer.banned && !customer.admin && <Badge variant="outline">Aktif</Badge>}
    </>
  );
}

export function CustomersPage() {
  const { me } = useSession();
  const { route, navigate } = useRoute();
  const q = route.query.get("q") ?? "";
  const [search, setSearch] = useState(q);
  useEffect(() => setSearch(q), [q]);
  const term = search.trim();
  useEffect(() => {
    if (term === q) return;
    const timer = setTimeout(() => navigate(href("customers", {}, term ? { q: term } : {}), true), 300);
    return () => clearTimeout(timer);
  }, [term, q, navigate]);
  const list = usePagedList<Customer>("/api/admin/customers", { listKey: "customers", cursor: "keyset", params: q ? { q } : {} });
  const [action, setAction] = useState<Action | null>(null);
  const run = useMutation(
    async ({ kind, customer }: Action) => {
      const path = `/api/admin/users/${encodeURIComponent(customer.id)}/${kind === "revoke" ? "revoke-sessions" : "ban"}`;
      const result = await post<{ revoked?: number; banned?: boolean }>(path, kind === "revoke" ? {} : { banned: kind === "ban" });
      return { kind, customer, result };
    },
    {
      key: "customer-action",
      success: ({ kind, result }) => (kind === "revoke" ? `${number(result.revoked ?? 0)} sesi dicabut.` : kind === "ban" ? "Akun diblokir." : "Blokir dibuka."),
      onSuccess: ({ kind, customer }) => {
        if (kind !== "revoke") list.setItems((items) => items.map((c) => (c.id === customer.id ? { ...c, banned: kind === "ban" } : c)));
      },
    },
  );
  return (
    <>
      <PageHeader title="Pelanggan" description="Akun pelanggan yang login dengan Google. Pembeli tamu tidak tercantum." />
      <FilterBar>
        <form
          className="relative w-full sm:w-auto"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(href("customers", {}, term ? { q: term } : {}), true);
          }}
        >
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            aria-label="Cari pelanggan"
            className="w-full pl-9 sm:w-72"
            placeholder="Cari nama atau email…"
            maxLength={CUSTOMER_SEARCH_MAX}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </form>
        {q && (
          <Button variant="ghost" size="sm" onClick={() => setSearch("")}>
            Hapus pencarian
          </Button>
        )}
      </FilterBar>
      {list.error && <LoadError message={list.error} onRetry={list.reload} />}
      <DataTable
        loading={list.loading}
        columns={[
          { head: "Pelanggan" },
          { head: "Bergabung", mobileHidden: true },
          { head: "Pesanan", className: "text-right" },
          { head: "Status", mobileHidden: true },
          { head: <span className="sr-only">Aksi</span> },
        ]}
        empty={q ? { title: "Tidak ada pelanggan yang cocok", description: "Pencarian mencocokkan sebagian nama atau email." } : { title: "Belum ada pelanggan terdaftar" }}
      >
        {list.items.map((c) => (
          <TableRow key={c.id}>
            <TableCell className="whitespace-normal">
              <div className="font-medium">{c.name}</div>
              <div className="text-xs break-all text-muted-foreground">{c.email}</div>
              <div className="flex items-center gap-1 text-xs text-muted-foreground">
                <span className="max-w-40 truncate font-mono" title={c.id}>
                  {c.id}
                </span>
                <CopyButton value={c.id} label={`ID pengguna ${c.name}`} />
              </div>
              <div className="mt-1 flex flex-wrap gap-1 md:hidden">
                <StatusBadges customer={c} />
                <span className="text-xs text-muted-foreground">Sejak {dateWIB(c.createdAt)}</span>
              </div>
            </TableCell>
            <TableCell className="whitespace-nowrap">{dateWIB(c.createdAt)}</TableCell>
            <TableCell className="text-right tabular-nums">
              {c.orders > 0 ? (
                <Link to={href("orders", {}, { q: c.email })} className="underline underline-offset-4" title="Lihat pesanan pelanggan ini">
                  {number(c.orders)}
                </Link>
              ) : (
                number(c.orders)
              )}
            </TableCell>
            <TableCell className="space-x-1">
              <StatusBadges customer={c} />
            </TableCell>
            <TableCell className="text-right">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="ghost" size="icon-sm" aria-label={`Aksi untuk ${c.name}`}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={c.admin && me.role !== "owner"} onSelect={() => setAction({ kind: "revoke", customer: c })}>
                    Cabut semua sesi
                  </DropdownMenuItem>
                  {!c.admin && (
                    <DropdownMenuItem variant={c.banned ? "default" : "destructive"} onSelect={() => setAction({ kind: c.banned ? "unban" : "ban", customer: c })}>
                      {c.banned ? "Buka blokir akun" : "Blokir akun"}
                    </DropdownMenuItem>
                  )}
                  {me.role === "owner" && !c.admin && !c.banned && (
                    <>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem onSelect={() => navigate(href("settings-team", {}, { userId: c.id, name: c.name, email: c.email }))}>Beri akses admin</DropdownMenuItem>
                    </>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            </TableCell>
          </TableRow>
        ))}
      </DataTable>
      {list.cursor && (
        <LoadMoreButton loading={list.loadingMore} onClick={list.loadMore} />
      )}
      <AlertDialog open={!!action} onOpenChange={(open) => !open && setAction(null)}>
        {action && (
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>{copy[action.kind].title(action.customer)}</AlertDialogTitle>
              <AlertDialogDescription>{copy[action.kind].description}</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Batal</AlertDialogCancel>
              <AlertDialogAction variant={action.kind === "unban" ? "default" : "destructive"} disabled={run.pending} onClick={() => void run.mutate(action)}>
                {copy[action.kind].confirm}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        )}
      </AlertDialog>
    </>
  );
}
