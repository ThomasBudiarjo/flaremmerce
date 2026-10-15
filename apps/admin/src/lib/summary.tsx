import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { get } from "@/lib/api";
import { useSession } from "@/lib/auth";
import { useRoute } from "@/lib/router";
import { useLatestRequest } from "@/hooks/use-latest-request";
import type { LowStockRow, Summary } from "@/lib/types";

const STALE = "admin:summary-stale";

/** Tell the shell its counters (to fulfill, open reviews, low stock) may have changed. */
export const markSummaryStale = () => window.dispatchEvent(new Event(STALE));

type Counts = {
  /** Today's summary; null until loaded or without the ops role. */
  summary: Summary | null;
  /** Low-stock variants: from the summary for ops, else the catalog low-stock list (capped at 100). */
  lowStock: number | null;
};

const SummaryContext = createContext<Counts>({ summary: null, lowStock: null });

/** Shared counters for sidebar badges and tab counts, refreshed on route change, window focus and mutations. */
export function SummaryProvider({ children }: { children: React.ReactNode }) {
  const { can } = useSession();
  const { route } = useRoute();
  const ops = can("ops"), catalog = can("catalog");
  const [counts, setCounts] = useState<Counts>({ summary: null, lowStock: null });
  const begin = useLatestRequest();

  const load = useCallback(async () => {
    if (!ops && !catalog) return;
    const controller = begin();
    try {
      if (ops) {
        const summary = await get<Summary>("/api/admin/summary?range=today", controller.signal);
        if (!controller.signal.aborted) setCounts({ summary, lowStock: summary.lowStock });
      } else {
        const data = await get<{ lowStock: LowStockRow[] }>("/api/admin/inventory?low=1", controller.signal);
        if (!controller.signal.aborted) setCounts({ summary: null, lowStock: data.lowStock.length });
      }
    } catch {
      // Badges are hints; a failed refresh keeps the previous numbers.
    }
  }, [begin, ops, catalog]);

  const page = `${route.name}:${route.params.id ?? ""}`;
  useEffect(() => {
    void load();
  }, [load, page]);

  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("focus", refresh);
    window.addEventListener(STALE, refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener(STALE, refresh);
    };
  }, [load]);

  return <SummaryContext.Provider value={counts}>{children}</SummaryContext.Provider>;
}

export const useSummary = () => useContext(SummaryContext);
