import { useEffect, useSyncExternalStore } from "react";
import { BASE, href, useRoute } from "@/lib/router";

/**
 * Last visited URL (with its filters) and loaded row ids per list route, so "back" returns to the
 * same filtered list and detail pages can step to the previous/next row. Kept in sessionStorage:
 * it survives a reload but not the tab.
 */
type Entry = { url: string; ids: string[] };
const PREFIX = "admin:list:";
const listeners = new Set<() => void>();

function read(name: string): Entry | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + name);
    return raw ? (JSON.parse(raw) as Entry) : null;
  } catch {
    return null;
  }
}

function write(name: string, entry: Entry) {
  try {
    const raw = JSON.stringify(entry);
    if (sessionStorage.getItem(PREFIX + name) === raw) return;
    sessionStorage.setItem(PREFIX + name, raw);
  } catch {
    return;
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** App-relative URL of the list as last seen, falling back to the unfiltered list. */
export function listHref(name: string) {
  return read(name)?.url ?? href(name);
}

/** Reactive variant of listHref for links that stay mounted while the list changes (the sidebar). */
export function useListHref(name: string) {
  return useSyncExternalStore(subscribe, () => listHref(name));
}

/** Previous and next ids around `id` in the remembered list; undefined at either end or when unknown. */
export function neighbours(name: string, id: string) {
  const ids = read(name)?.ids ?? [];
  const index = ids.indexOf(id);
  if (index < 0) return { prev: undefined, next: undefined, index: -1, total: ids.length };
  return { prev: ids[index - 1] as string | undefined, next: ids[index + 1] as string | undefined, index, total: ids.length };
}

/** Records the current URL and the rows a list page has loaded. Call from the list page. */
export function useRememberList(name: string, ids: string[]) {
  const { route } = useRoute();
  const signature = ids.join(",");
  const search = route.query.toString();
  useEffect(() => {
    if (route.name !== name) return;
    const url = `/${location.pathname.slice(BASE.length)}${search ? `?${search}` : ""}`;
    write(name, { url, ids: signature ? signature.split(",") : [] });
  }, [name, route.name, search, signature]);
}
