import { useEffect, useRef, useState } from "react";
import { SearchIcon } from "lucide-react";
import { get } from "@/lib/api";
import { money, variantMode } from "@/lib/format";
import type { VariantSearchResult } from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { useLatestRequest } from "@/hooks/use-latest-request";

/**
 * Server-side variant search (GET /api/admin/variants/search), so pickers are not
 * limited to whichever catalog page happens to be loaded.
 */
export function VariantPicker({
  id,
  label = "Varian produk",
  mode,
  selected,
  onSelect,
  disabled,
}: {
  id: string;
  label?: string;
  mode?: "stock" | "preorder";
  selected: VariantSearchResult | null;
  onSelect: (variant: VariantSearchResult | null) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<VariantSearchResult[]>([]);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const begin = useLatestRequest();
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      setResults([]);
      setOpen(false);
      return;
    }
    const controller = begin();
    const timer = setTimeout(async () => {
      try {
        const params = new URLSearchParams({ q: term });
        if (mode) params.set("mode", mode);
        const data = await get<{ variants: VariantSearchResult[] }>(`/api/admin/variants/search?${params}`, controller.signal);
        if (controller.signal.aborted) return;
        setResults(data.variants);
        setOpen(true);
        setError("");
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [query, mode, begin]);

  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  return (
    <div className="grid gap-2" ref={box}>
      <Label htmlFor={id}>{label}</Label>
      {selected ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm">
          <span className="font-medium">{selected.sku}</span>
          <span>
            {selected.productName} · {selected.name}
          </span>
          <Badge variant="outline">{variantMode[selected.mode]}</Badge>
          <Badge variant="secondary">{money(selected.price)}</Badge>
          {!disabled && (
            <button
              type="button"
              className="ml-auto text-xs text-muted-foreground underline underline-offset-2"
              onClick={() => {
                onSelect(null);
                setQuery("");
              }}
            >
              Ganti varian
            </button>
          )}
        </div>
      ) : (
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            id={id}
            className="pl-9"
            placeholder="Cari SKU, nama varian, atau produk…"
            value={query}
            disabled={disabled}
            autoComplete="off"
            onChange={(e) => setQuery(e.target.value)}
            onFocus={() => results.length && setOpen(true)}
          />
          {open && results.length > 0 && (
            <ul
              role="listbox"
              aria-label="Hasil pencarian varian"
              className="absolute z-30 mt-1 max-h-64 w-full overflow-y-auto rounded-lg bg-popover p-1 text-sm shadow-md ring-1 ring-foreground/10"
            >
              {results.map((variant) => (
                <li key={variant.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    className="flex w-full flex-wrap items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-accent"
                    onClick={() => {
                      onSelect(variant);
                      setOpen(false);
                    }}
                  >
                    <span className="font-medium">{variant.sku}</span>
                    <span className="min-w-0 flex-1 truncate">
                      {variant.productName} · {variant.name}
                    </span>
                    {!variant.active && <Badge variant="outline">Nonaktif</Badge>}
                    <Badge variant="outline">{variantMode[variant.mode]}</Badge>
                    <span className="tabular-nums text-muted-foreground">{money(variant.price)}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {open && query.trim() && !results.length && !error && (
            <p className="absolute z-30 mt-1 w-full rounded-lg bg-popover p-2 text-sm text-muted-foreground ring-1 ring-foreground/10">
              Tidak ada varian yang cocok.
            </p>
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
