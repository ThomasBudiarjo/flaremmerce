import { useEffect, useId, useRef, useState } from "react";
import { get } from "@/lib/api";
import type { Customer } from "@/lib/types";
import { useLatestRequest } from "@/hooks/use-latest-request";
import { SearchStatusIcon } from "@/components/loading";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type PickedCustomer = Pick<Customer, "id" | "name" | "email">;

/** Searches signed-up customers by name or email (GET /api/admin/customers?q=). Admins and banned accounts are shown but not selectable. */
export function CustomerPicker({
  id,
  label,
  selected,
  onSelect,
  disabled,
}: {
  id: string;
  label: string;
  selected: PickedCustomer | null;
  onSelect: (customer: PickedCustomer | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Customer[] | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [error, setError] = useState("");
  const [searching, setSearching] = useState(false);
  const begin = useLatestRequest();
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const term = query.trim();

  useEffect(() => {
    if (term.length < 2) {
      begin();
      setResults(null);
      setSearching(false);
      return;
    }
    const controller = begin();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const data = await get<{ customers: Customer[] }>(`/api/admin/customers?${new URLSearchParams({ q: term, limit: "10" })}`, controller.signal);
        if (controller.signal.aborted) return;
        setResults(data.customers);
        setActive(-1);
        setOpen(true);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [term, begin]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const choices = results ?? [];
  const selectable = (c: Customer) => !c.admin && !c.banned;
  const choose = (c: Customer) => {
    if (!selectable(c)) return;
    onSelect({ id: c.id, name: c.name, email: c.email });
    setQuery("");
    setOpen(false);
  };

  return (
    <div className="grid gap-2" ref={box}>
      <Label htmlFor={id}>{label}</Label>
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
          <span className="font-medium">{selected.name}</span>
          <span className="break-all text-muted-foreground">{selected.email}</span>
          {!disabled && (
            <button type="button" className="ml-auto text-xs text-muted-foreground underline underline-offset-2" onClick={() => onSelect(null)}>
              Ganti pengguna
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <SearchStatusIcon busy={searching} />
          <Input
            id={id}
            role="combobox"
            aria-busy={searching || undefined}
            aria-expanded={open && !!results}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={open && active >= 0 ? `${listId}-${active}` : undefined}
            className="pl-9"
            placeholder="Cari nama atau email…"
            maxLength={48}
            autoComplete="off"
            value={query}
            disabled={disabled}
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results && setOpen(true)}
            onKeyDown={(e) => {
              if (e.key === "Escape") setOpen(false);
              else if ((e.key === "ArrowDown" || e.key === "ArrowUp") && choices.length) {
                e.preventDefault();
                setOpen(true);
                const step = e.key === "ArrowDown" ? 1 : -1;
                setActive((i) => (i + step + choices.length) % choices.length);
              } else if (e.key === "Enter" && open && active >= 0) {
                e.preventDefault();
                choose(choices[active]);
              }
            }}
          />
          {open && results && (
            <ul id={listId} role="listbox" aria-label="Hasil pencarian pengguna" className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg bg-popover p-1 text-sm shadow-md ring-1 ring-foreground/10">
              {!results.length && <li className="p-2 text-muted-foreground">Tidak ada pengguna yang cocok. Pengguna harus login sekali dengan Google.</li>}
              {results.map((c, i) => (
                <li
                  key={c.id}
                  id={`${listId}-${i}`}
                  role="option"
                  aria-selected={i === active}
                  aria-disabled={!selectable(c)}
                  className={`flex flex-wrap items-center gap-2 rounded-md px-2 py-1.5 ${selectable(c) ? "cursor-pointer hover:bg-accent" : "opacity-60"} ${i === active ? "bg-accent" : ""}`}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => choose(c)}
                >
                  <span className="font-medium">{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{c.email}</span>
                  {c.admin && <Badge variant="secondary">Sudah admin</Badge>}
                  {c.banned && <Badge variant="destructive">Diblokir</Badge>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
