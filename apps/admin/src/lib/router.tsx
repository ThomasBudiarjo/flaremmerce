import React, { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
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

/** Tiny history-API router for the /admin/ SPA. The worker serves index.html for every deep link. */
export const BASE = "/admin/";

export type Area = "any" | "ops" | "catalog" | "owner";

type RouteDef = { name: string; segments: string[]; area: Area };

// Literal segments outrank `:param` at the same depth; keep more specific entries first.
const routes: RouteDef[] = [
  { name: "dashboard", segments: [], area: "any" },
  { name: "orders", segments: ["orders"], area: "ops" },
  { name: "order-detail", segments: ["orders", ":id"], area: "ops" },
  { name: "products", segments: ["products"], area: "catalog" },
  { name: "product-new", segments: ["products", "new"], area: "catalog" },
  { name: "product-edit", segments: ["products", ":id"], area: "catalog" },
  { name: "inventory", segments: ["inventory"], area: "catalog" },
  { name: "preorders", segments: ["preorders"], area: "catalog" },
  { name: "categories", segments: ["categories"], area: "catalog" },
  { name: "customers", segments: ["customers"], area: "ops" },
  { name: "reviews", segments: ["reviews"], area: "ops" },
  { name: "review-detail", segments: ["reviews", ":id"], area: "ops" },
  { name: "blocklist", segments: ["blocklist"], area: "ops" },
  { name: "operations", segments: ["operations"], area: "ops" },
  { name: "settings-team", segments: ["settings", "team"], area: "owner" },
];

export type Route = {
  name: string;
  params: Record<string, string>;
  query: URLSearchParams;
  area: Area;
};

function parse(pathname: string, search: string): Route | null {
  if (!pathname.startsWith(BASE)) return null;
  const parts = pathname.slice(BASE.length).split("/").filter(Boolean).map(decodeURIComponent);
  for (const route of routes) {
    if (route.segments.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const match = route.segments.every((segment, i) =>
      segment.startsWith(":") ? (params[segment.slice(1)] = parts[i], true) : segment === parts[i],
    );
    if (match) return { name: route.name, params, query: new URLSearchParams(search), area: route.area };
  }
  return { name: "not-found", params: {}, query: new URLSearchParams(search), area: "any" };
}

/** App-relative href (without the /admin/ base) used by Link and navigate. */
export function href(name: string, params: Record<string, string> = {}, query?: Record<string, string>) {
  const route = routes.find((r) => r.name === name);
  if (!route) throw new Error(`Unknown route ${name}`);
  const path = route.segments.map((s) => (s.startsWith(":") ? encodeURIComponent(params[s.slice(1)] ?? "") : s)).join("/");
  const search = new URLSearchParams(query);
  return `/${path}${search.size ? `?${search}` : ""}`;
}

const DEFAULT_GUARD_MESSAGE = "Perubahan yang belum disimpan akan hilang.";
// Guards live outside React so navigate() can consult them synchronously from any event handler.
const guards = new Set<{ message: string }>();

/**
 * While `dirty`, every in-app navigation (Link, navigate, back/forward) asks for confirmation
 * first, and leaving or reloading the page triggers the browser's unload prompt.
 */
export function useNavigationGuard(dirty: boolean, message = DEFAULT_GUARD_MESSAGE) {
  useEffect(() => {
    if (!dirty) return;
    const entry = { message };
    guards.add(entry);
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", warn);
    return () => {
      guards.delete(entry);
      window.removeEventListener("beforeunload", warn);
    };
  }, [dirty, message]);
}

type Navigate = (to: string, replace?: boolean, force?: boolean) => void;

const RouterContext = createContext<{ route: Route; navigate: Navigate }>({
  route: parse("/admin/", "")!,
  navigate: () => {},
});

const here = () => location.pathname + location.search;
const resolve = (to: string) => (to.startsWith(BASE) ? to : BASE + to.replace(/^\//, ""));

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname, location.search) ?? parse(BASE, "")!);
  const [prompt, setPrompt] = useState<{ message: string; proceed: () => void } | null>(null);
  const current = useRef(here());
  const bypass = useRef(false);

  const go = useCallback((target: string, replace: boolean) => {
    if (replace) history.replaceState(null, "", target);
    else history.pushState(null, "", target);
    window.dispatchEvent(new Event("admin:navigate"));
  }, []);

  /** `force` skips the unsaved-changes guard, for navigations that follow a successful save. */
  const navigate = useCallback<Navigate>(
    (to, replace = false, force = false) => {
      const target = resolve(to);
      const [guard] = guards;
      if (!force && guard && target !== here()) {
        setPrompt({ message: guard.message, proceed: () => go(target, replace) });
        return;
      }
      go(target, replace);
    },
    [go],
  );

  // A layout effect, so the listeners exist before any page's passive effects run: a page that
  // corrects its own URL on mount (an unknown list page) would otherwise navigate unheard.
  useLayoutEffect(() => {
    const update = () => {
      current.current = here();
      setRoute(parse(location.pathname, location.search) ?? parse(BASE, "")!);
      window.scrollTo(0, 0);
    };
    const pop = () => {
      const [guard] = guards;
      if (bypass.current || !guard) {
        bypass.current = false;
        update();
        return;
      }
      // The browser already moved; put the guarded page back until the user decides.
      history.pushState(null, "", current.current);
      setPrompt({
        message: guard.message,
        proceed: () => {
          bypass.current = true;
          history.back();
        },
      });
    };
    window.addEventListener("popstate", pop);
    window.addEventListener("admin:navigate", update);
    return () => {
      window.removeEventListener("popstate", pop);
      window.removeEventListener("admin:navigate", update);
    };
  }, []);

  return (
    <RouterContext.Provider value={{ route, navigate }}>
      {children}
      <AlertDialog open={!!prompt} onOpenChange={(open) => !open && setPrompt(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Buang perubahan?</AlertDialogTitle>
            <AlertDialogDescription>{prompt?.message}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Tetap di sini</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const proceed = prompt?.proceed;
                setPrompt(null);
                guards.clear();
                proceed?.();
              }}
            >
              Buang
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </RouterContext.Provider>
  );
}

export function useRoute() {
  return useContext(RouterContext);
}

export function Link({
  to,
  children,
  onClick,
  ...props
}: React.ComponentProps<"a"> & { to: string }) {
  const { navigate } = useRoute();
  return (
    <a
      href={resolve(to)}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
        event.preventDefault();
        navigate(to);
      }}
      {...props}
    >
      {children}
    </a>
  );
}
