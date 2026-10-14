import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "@/lib/api";
import { useLatestRequest } from "./use-latest-request";

type KeysetCursor = { before: number; beforeId: string };
type Cursor = KeysetCursor | string | null;

type Options = {
  /** Response field holding the array, e.g. "orders", "items", "products". */
  listKey: string;
  /** Keyset APIs page with before/beforeId; the catalog pages by slug with `after`. */
  cursor: "keyset" | "slug";
  /** Filter parameters; a change resets the list to page one. */
  params?: Record<string, string>;
  limit?: number;
  /** Set false to defer the first load (e.g. waiting on a role). */
  enabled?: boolean;
};

/** Keyset-paginated list with load-more, reset-on-filter-change and id dedupe. */
export function usePagedList<T extends { id: string }>(path: string, options: Options) {
  const { listKey, cursor: cursorKind, params, limit = 50, enabled = true } = options;
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<Cursor>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState("");
  const begin = useLatestRequest();
  const signature = JSON.stringify(params ?? {});
  const state = useRef({ items, cursor });
  state.current = { items, cursor };

  const load = useCallback(
    async (from: Cursor, append: boolean) => {
      const controller = begin();
      const query = new URLSearchParams(JSON.parse(signature));
      query.set("limit", String(limit));
      if (from) {
        if (cursorKind === "slug") query.set("after", String(from));
        else {
          const c = from as KeysetCursor;
          query.set("before", String(c.before));
          query.set("beforeId", c.beforeId);
        }
      }
      append ? setLoadingMore(true) : setLoading(true);
      setError("");
      try {
        const data = await get<Record<string, any>>(`${path}?${query}`, controller.signal);
        if (controller.signal.aborted) return;
        const page = (data[listKey] ?? []) as T[];
        setItems((rows) => {
          const base = append ? rows : [];
          return [...base, ...page.filter((row) => !base.some((existing) => existing.id === row.id))];
        });
        setCursor(data.nextCursor ?? null);
      } catch (e) {
        if (!controller.signal.aborted) setError((e as Error).message);
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [begin, path, listKey, cursorKind, signature, limit],
  );

  useEffect(() => {
    if (!enabled) return;
    setItems([]);
    setCursor(null);
    void load(null, false);
  }, [load, enabled]);

  const loadMore = useCallback(() => {
    const { cursor } = state.current;
    if (cursor) void load(cursor, true);
  }, [load]);

  const reload = useCallback(() => load(null, false), [load]);

  return { items, setItems, cursor, loading, loadingMore, error, loadMore, reload };
}
