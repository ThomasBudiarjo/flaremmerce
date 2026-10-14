import React, { createContext, useCallback, useContext, useEffect, useState } from "react";

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

const RouterContext = createContext<{ route: Route; navigate: (to: string, replace?: boolean) => void }>({
  route: parse("/admin/", "")!,
  navigate: () => {},
});

export function RouterProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parse(location.pathname, location.search) ?? parse(BASE, "")!);
  const navigate = useCallback((to: string, replace = false) => {
    const target = to.startsWith(BASE) ? to : BASE + to.replace(/^\//, "");
    if (replace) history.replaceState(null, "", target);
    else history.pushState(null, "", target);
    window.dispatchEvent(new Event("admin:navigate"));
  }, []);
  useEffect(() => {
    const update = () => {
      setRoute(parse(location.pathname, location.search) ?? parse(BASE, "")!);
      window.scrollTo(0, 0);
    };
    window.addEventListener("popstate", update);
    window.addEventListener("admin:navigate", update);
    return () => {
      window.removeEventListener("popstate", update);
      window.removeEventListener("admin:navigate", update);
    };
  }, []);
  return <RouterContext.Provider value={{ route, navigate }}>{children}</RouterContext.Provider>;
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
      href={BASE + to.replace(/^\//, "")}
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
