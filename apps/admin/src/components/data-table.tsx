import React from "react";
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from "@/components/ui/table";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "./empty-state";

type Column = { head: React.ReactNode; className?: string };

/** Table with skeleton rows while loading and a consistent empty state. */
export function DataTable({
  columns,
  loading,
  empty,
  children,
}: {
  columns: Column[];
  loading?: boolean;
  empty?: { title: string; description?: string };
  children: React.ReactNode;
}) {
  return (
    <div className="overflow-x-auto rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            {columns.map((column, i) => (
              <TableHead key={i} className={column.className}>
                {column.head}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading
            ? Array.from({ length: 5 }, (_, row) => (
                <TableRow key={row}>
                  {columns.map((_, cell) => (
                    <TableCell key={cell}>
                      <Skeleton className="h-4 w-full max-w-40" />
                    </TableCell>
                  ))}
                </TableRow>
              ))
            : children}
        </TableBody>
      </Table>
      {!loading && empty && !React.Children.count(children) && (
        <div className="p-6">
          <EmptyState title={empty.title} description={empty.description} />
        </div>
      )}
    </div>
  );
}
