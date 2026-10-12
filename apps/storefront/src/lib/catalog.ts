export type Variant = {
  id: string;
  sku: string;
  name: string;
  price: number;
  weight: number;
  available: number | null;
  mode: "stock" | "preorder";
  campaign?: {
    id: string;
    startsAt: string | number;
    endsAt: string | number;
    shipFrom: string | number;
    shipTo: string | number;
    quota: number | null;
    available: number | null;
  };
};
export type Product = {
  id: string;
  slug: string;
  name: string;
  description: string;
  imageUrl?: string;
  variants: Variant[];
};
export const money = (value: number) =>
  new Intl.NumberFormat("id-ID", {
    style: "currency",
    currency: "IDR",
    maximumFractionDigits: 0,
  }).format(value);
export const date = (value: string | number) =>
  new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeZone: "Asia/Jakarta",
  }).format(new Date(value));
// Composition contract: parent Worker supplies locals.catalog(path), calling its API
// handler directly. Alternatively bind CATALOG_API or set API_ORIGIN to a distinct API service.
// Never fetch the current SSR origin recursively and never query guessed SQL columns.
export async function catalog(locals: any, path = "/api/catalog") {
  let response: Response;
  if (locals.catalog) response = await locals.catalog(path);
  else {
    const env = locals.runtime?.env;
    if (env?.CATALOG_API)
      response = await env.CATALOG_API.fetch(
        new Request("https://catalog.internal" + path),
      );
    else if (env?.API_ORIGIN)
      response = await fetch(new URL(path, env.API_ORIGIN));
    else throw new Error("Katalog belum terhubung.");
  }
  if (response.status === 404 && path !== "/api/catalog")
    return { product: undefined };
  if (!response.ok) throw new Error("Katalog sementara tidak tersedia.");
  return response.json();
}
