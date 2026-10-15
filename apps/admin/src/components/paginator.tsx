import { useId } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { number } from "@/lib/format";
import { PAGE_SIZES } from "@/hooks/use-paged-list";
import { Button } from "@/components/ui/button";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select";

/** Same as pageWindow in src/shared.ts: the first, the last and the neighbours of `page`; null marks a gap. */
export function pageWindow(page: number, pages: number): (number | null)[] {
  const shown = [...new Set([1, page - 1, page, page + 1, pages])].filter((n) => n >= 1 && n <= pages).sort((a, b) => a - b);
  const out: (number | null)[] = [];
  let previous = 0;
  for (const n of shown) {
    // A gap of one page shows that page: "…" would take the same space and hide it.
    if (n - previous === 2) out.push(n - 1);
    else if (n - previous > 2) out.push(null);
    out.push(n);
    previous = n;
  }
  return out;
}

type Props = {
  page: number;
  pageSize: number;
  /** Known for numbered (offset) lists; null for keyset lists, which only step back and forth. */
  total: number | null;
  hasNext: boolean;
  loading: boolean;
  /** Rows on the current page. */
  count: number;
  onPageChange: (page: number) => void;
  onPageSizeChange: (size: number) => void;
  label?: string;
};

/** Page navigation and page-size picker under a list. Hidden while everything fits on one smallest page. */
export function Paginator({ page, pageSize, total, hasNext, loading, count, onPageChange, onPageSizeChange, label = "Navigasi halaman" }: Props) {
  const id = useId();
  if (page === 1 && !hasNext && count <= PAGE_SIZES[0]) return null;
  const pages = total === null ? null : Math.max(1, Math.ceil(total / pageSize));
  const first = (page - 1) * pageSize + 1;
  const status =
    total === null ? `Halaman ${number(page)}` : count ? `${number(first)}–${number(first + count - 1)} dari ${number(total)}` : `0 dari ${number(total)}`;
  return (
    <nav aria-label={label} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm">
      <div className="flex items-center gap-2 text-muted-foreground">
        <label htmlFor={id}>Tampilkan</label>
        <NativeSelect id={id} size="sm" value={pageSize} disabled={loading} onChange={(e) => onPageSizeChange(Number(e.target.value))}>
          {PAGE_SIZES.map((size) => (
            <NativeSelectOption key={size} value={size}>
              {size}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span>per halaman</span>
        <span aria-live="polite" className="ml-2 tabular-nums">
          {status}
        </span>
      </div>
      <div className="flex items-center gap-1">
        <Button variant="outline" size="sm" disabled={loading || page <= 1} onClick={() => onPageChange(page - 1)} aria-label="Halaman sebelumnya">
          <ChevronLeft />
          <span className="max-sm:hidden">Sebelumnya</span>
        </Button>
        {pages !== null && (
          <>
            {pageWindow(page, pages).map((n, i) =>
              n === null ? (
                <span key={`gap-${i}`} aria-hidden className="px-1 text-muted-foreground max-sm:hidden">
                  …
                </span>
              ) : (
                <Button
                  key={n}
                  variant={n === page ? "secondary" : "ghost"}
                  size="sm"
                  className="min-w-7 tabular-nums max-sm:hidden"
                  aria-label={`Halaman ${n}`}
                  aria-current={n === page ? "page" : undefined}
                  disabled={loading && n !== page}
                  onClick={() => n !== page && onPageChange(n)}
                >
                  {number(n)}
                </Button>
              ),
            )}
            <span className="px-2 tabular-nums sm:hidden">
              {number(page)} / {number(pages)}
            </span>
          </>
        )}
        <Button variant="outline" size="sm" disabled={loading || !hasNext} onClick={() => onPageChange(page + 1)} aria-label="Halaman berikutnya">
          <span className="max-sm:hidden">Berikutnya</span>
          <ChevronRight />
        </Button>
      </div>
    </nav>
  );
}
