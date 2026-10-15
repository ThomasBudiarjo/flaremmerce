import React, { createContext, useContext } from "react";
import { cn } from "cn";
import { useRoute, BASE } from "@/lib/router";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./empty-state";

type Column = { head: React.ReactNode; className?: string; /** Hidden below the md breakpoint (phones). */ mobileHidden?: boolean };

export type Selection = {
  /** Ids of the rows currently shown, in order; "select all" applies to these. */
  ids: string[];
  selected: Set<string>;
  onChange: (next: Set<string>) => void;
};

// Tailwind only generates classes it can find literally in the source, so each position is spelled out.
const hideColumn = [
  "max-md:[&_tr>*:nth-child(1)]:hidden",
  "max-md:[&_tr>*:nth-child(2)]:hidden",
  "max-md:[&_tr>*:nth-child(3)]:hidden",
  "max-md:[&_tr>*:nth-child(4)]:hidden",
  "max-md:[&_tr>*:nth-child(5)]:hidden",
  "max-md:[&_tr>*:nth-child(6)]:hidden",
  "max-md:[&_tr>*:nth-child(7)]:hidden",
  "max-md:[&_tr>*:nth-child(8)]:hidden",
  "max-md:[&_tr>*:nth-child(9)]:hidden",
  "max-md:[&_tr>*:nth-child(10)]:hidden",
];

const SelectionContext = createContext<Selection | null>(null);

// Percentage widths keep placeholder cells from forcing the table wider than its real rows on phones.
const placeholderWidths = ["max-w-24", "max-w-32", "max-w-20", "max-w-28", "max-w-16"];

/**
 * Table with skeleton rows on first load, dimmed rows while refreshing, and a consistent empty
 * state. With `selection`, a
 * leading checkbox column is added; rows render <SelectCell id=…/> as their first cell.
 */
export function DataTable({
  columns,
  loading,
  empty,
  selection,
  children,
}: {
  columns: Column[];
  loading?: boolean;
  empty?: { title: string; description?: string };
  selection?: Selection;
  children: React.ReactNode;
}) {
  const offset = selection ? 1 : 0;
  const hidden = columns.flatMap((column, i) => (column.mobileHidden ? [hideColumn[i + offset]] : []));
  const all = selection ? selection.ids.length > 0 && selection.ids.every((id) => selection.selected.has(id)) : false;
  const some = selection ? selection.ids.some((id) => selection.selected.has(id)) : false;
  const width = columns.length + offset;
  const hasRows = React.Children.toArray(children).length > 0;
  // A refresh keeps the current rows on screen (dimmed, not interactive) instead of blanking the
  // table; skeleton rows are only for a load with nothing to show yet.
  const placeholder = loading && !hasRows;
  const stale = loading && hasRows;
  return (
    <SelectionContext.Provider value={selection ?? null}>
      <div className="relative overflow-x-auto rounded-md border" aria-busy={loading || undefined}>
        {stale && <div aria-hidden className="loading-bar" />}
        <Table className={hidden.join(" ") || undefined}>
          <TableHeader>
            <TableRow>
              {selection && (
                <TableHead className="w-8">
                  <Checkbox
                    aria-label="Pilih semua baris"
                    checked={all ? true : some ? "indeterminate" : false}
                    disabled={!selection.ids.length}
                    onCheckedChange={(checked) => selection.onChange(checked === true ? new Set(selection.ids) : new Set())}
                  />
                </TableHead>
              )}
              {columns.map((column, i) => (
                <TableHead key={i} className={column.className}>
                  {column.head}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          {placeholder ? (
            <TableBody key="placeholder">
              {Array.from({ length: 5 }, (_, row) => (
                <TableRow key={row} className="hover:bg-transparent">
                  {Array.from({ length: width }, (_, cell) => (
                    <TableCell key={cell}>
                      <Skeleton className={cn("h-4 w-full", placeholderWidths[(row + cell) % placeholderWidths.length])} />
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          ) : (
            <TableBody key="rows" inert={stale} className={cn("content-reveal transition-opacity duration-200", stale && "is-stale")}>
              {children}
            </TableBody>
          )}
        </Table>
        {!loading && empty && !hasRows && (
          <div className="content-reveal p-6">
            <EmptyState title={empty.title} description={empty.description} />
          </div>
        )}
      </div>
    </SelectionContext.Provider>
  );
}

/** Row checkbox for a DataTable with `selection`. */
export function SelectCell({ id, label }: { id: string; label: string }) {
  const selection = useContext(SelectionContext);
  if (!selection) return null;
  return (
    <TableCell className="w-8" onClick={(e) => e.stopPropagation()}>
      <Checkbox
        aria-label={`Pilih ${label}`}
        checked={selection.selected.has(id)}
        onCheckedChange={(checked) => {
          const next = new Set(selection.selected);
          if (checked === true) next.add(id);
          else next.delete(id);
          selection.onChange(next);
        }}
      />
    </TableCell>
  );
}

const interactive = "a,button,input,select,textarea,label,[role=checkbox],[role=menuitem],[data-slot=dropdown-menu-trigger]";

/**
 * Row that opens `to` when clicked anywhere outside its own controls. Keyboard users reach the
 * same destination through the row's primary <Link>; Ctrl/Cmd/middle-click opens a new tab.
 */
export function LinkRow({ to, className, children, ...props }: React.ComponentProps<typeof TableRow> & { to: string }) {
  const { navigate } = useRoute();
  const open = (event: React.MouseEvent<HTMLTableRowElement>, newTab: boolean) => {
    if ((event.target as Element).closest(interactive)) return;
    if (window.getSelection()?.toString()) return;
    if (newTab) window.open(BASE + to.replace(/^\//, ""), "_blank", "noopener");
    else navigate(to);
  };
  return (
    <TableRow
      className={cn("cursor-pointer", className)}
      onClick={(event) => open(event, event.ctrlKey || event.metaKey)}
      onAuxClick={(event) => event.button === 1 && open(event, true)}
      {...props}
    >
      {children}
    </TableRow>
  );
}
