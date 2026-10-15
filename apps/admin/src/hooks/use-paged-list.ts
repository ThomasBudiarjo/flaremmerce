import { useCallback, useEffect, useRef, useState } from "react";
import { get } from "@/lib/api";
import { href, useRoute } from "@/lib/router";
import { useLatestRequest } from "./use-latest-request";

/** Mirrors PAGE_SIZES, DEFAULT_PAGE_SIZE and MAX_PAGE in src/shared.ts. */
export const PAGE_SIZES = [10, 25, 50] as const;
export const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE = 1000;

export type Paging = {
  page: number;
  pageSize: number;
  setPage: (page: number) => void;
  setPageSize: (size: number) => void;
};

export const pageSizeOf = (value: string | null) => {
  const size = Number(value);
  return (PAGE_SIZES as readonly number[]).includes(size) ? size : DEFAULT_PAGE_SIZE;
};
export const pageOf = (value: string | null) => {
  const page = Number(value);
  return Number.isInteger(page) && page >= 1 && page <= MAX_PAGE ? page : 1;
};

/**
 * Page (?page=) and page size (?limit=) of the list that owns the URL. Changes replace the URL like
 * filter changes do. Spread `keep` into filter navigations so a filter change keeps the page size
 * but returns to page one.
 */
export function useUrlPaging(): Paging & { keep: Record<string, string> } {
  const { route, navigate } = useRoute();
  const page = pageOf(route.query.get("page"));
  const pageSize = pageSizeOf(route.query.get("limit"));
  const go = (nextPage: number, nextSize: number) => {
    const query = Object.fromEntries(route.query);
    delete query.page;
    delete query.limit;
    if (nextPage > 1) query.page = String(nextPage);
    if (nextSize !== DEFAULT_PAGE_SIZE) query.limit = String(nextSize);
    navigate(href(route.name, route.params, query), true);
  };
  return {
    page,
    pageSize,
    setPage: (next) => go(next, pageSize),
    setPageSize: (size) => go(1, size),
    keep: pageSize === DEFAULT_PAGE_SIZE ? {} : { limit: String(pageSize) },
  };
}

/** Paging held in component state, for lists that do not own the URL (sheets); a new `scope` returns to page one. */
export function useLocalPaging(scope: string, initialSize = DEFAULT_PAGE_SIZE): Paging {
  const [state, setState] = useState({ scope, page: 1, pageSize: initialSize });
  if (state.scope !== scope) setState({ ...state, scope, page: 1 });
  const page = state.scope === scope ? state.page : 1;
  return {
    page,
    pageSize: state.pageSize,
    setPage: (next) => setState((s) => ({ ...s, page: next })),
    setPageSize: (size) => setState((s) => ({ ...s, page: 1, pageSize: size })),
  };
}

type Cursor = { before: number; beforeId: string };

// A keyset page can only be reached by walking forward from page one. The cursors walked so far are
// kept per list, filter and page size, so "previous" and returning from a detail page reopen the
// same rows. Module memory: a reload starts again at page one.
const cursorTrails = new Map<string, (Cursor | null)[]>();

type Options = {
  /** Response field holding the array, e.g. "orders", "items", "products". */
  listKey: string;
  /**
   * "offset": numbered pages with a total; the server counts every matching row, so use it for
   * bounded tables. "keyset": previous/next only; each page reads about `pageSize` rows however
   * large the table grows.
   */
  mode: "offset" | "keyset";
  paging: Paging;
  /** Filter parameters; callers reset `paging` to page one when they change. */
  params?: Record<string, string>;
  /** Set false to defer the first load (e.g. waiting on a role). */
  enabled?: boolean;
};

/** One page of a server-paginated list, plus the props for <Paginator>. */
export function usePagedList<T extends { id: string }>(path: string, options: Options) {
  const { listKey, mode, paging, params, enabled = true } = options;
  const { page, pageSize } = paging;
  const [items, setItems] = useState<T[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasNext, setHasNext] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const begin = useLatestRequest();
  const signature = JSON.stringify(params ?? {});
  const trailKey = `${path}?${signature}&limit=${pageSize}`;
  const setPage = useRef(paging.setPage);
  setPage.current = paging.setPage;

  const load = useCallback(async () => {
    const controller = begin();
    const query = new URLSearchParams(JSON.parse(signature));
    query.set("limit", String(pageSize));
    if (mode === "offset") query.set("page", String(page));
    else if (page > 1) {
      const cursor = cursorTrails.get(trailKey)?.[page - 1];
      // A page this tab has not walked to (reload, shared link): start over from page one.
      if (!cursor) return setPage.current(1);
      query.set("before", String(cursor.before));
      query.set("beforeId", cursor.beforeId);
    }
    setLoading(true);
    setError("");
    let moved = false;
    try {
      const data = await get<Record<string, any>>(`${path}?${query}`, controller.signal);
      if (controller.signal.aborted) return;
      if (mode === "offset") {
        const count = Number(data.total ?? 0);
        const last = Math.max(1, Math.ceil(count / pageSize));
        // The list shrank below this page (deletions, an old link): show the last page that exists.
        if (page > last) {
          moved = true;
          return setPage.current(last);
        }
        setTotal(count);
        setHasNext(page < last);
      } else {
        const trail = (cursorTrails.get(trailKey) ?? [null]).slice(0, page);
        if (data.nextCursor) trail[page] = data.nextCursor;
        cursorTrails.set(trailKey, trail);
        setTotal(null);
        setHasNext(!!data.nextCursor);
      }
      setItems((data[listKey] ?? []) as T[]);
    } catch (e) {
      if (!controller.signal.aborted) {
        // The rows kept during the refresh may belong to another page or filter; do not leave them looking current.
        setItems([]);
        setTotal(null);
        setHasNext(false);
        setError((e as Error).message);
      }
    } finally {
      if (!controller.signal.aborted && !moved) setLoading(false);
    }
  }, [begin, path, listKey, mode, signature, page, pageSize, trailKey]);

  // A page or filter change keeps the current rows until the new page arrives, so the table
  // refreshes in place rather than flashing empty; `loading` with rows present means "refreshing".
  useEffect(() => {
    if (!enabled) return;
    void load();
  }, [load, enabled]);

  return {
    items,
    setItems,
    loading,
    error,
    reload: load,
    total,
    paginator: {
      page,
      pageSize,
      total,
      hasNext,
      loading,
      count: items.length,
      onPageChange: paging.setPage,
      onPageSizeChange: paging.setPageSize,
    },
  };
}
