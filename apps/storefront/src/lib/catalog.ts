export type Variant = {
  id: string;
  sku: string;
  name: string;
  price: number;
  weight: number;
  /** Public catalog never exposes exact counts. */
  stockLevel: "in_stock" | "low" | "out";
  maxPerOrder?: number | null;
  mode: "stock" | "preorder";
  campaign?: {
    id: string;
    startsAt: string | number;
    endsAt: string | number;
    shipFrom: string | number;
    shipTo: string | number;
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
// Middleware supplies the in-process API; no recursive same-origin network requests.
export async function catalog(locals: any, path = "/api/catalog") {
  const response: Response = await locals.catalog(path);
  if (response.status === 404 && path !== "/api/catalog")
    return { product: undefined };
  if (!response.ok) throw new Error("Katalog sementara tidak tersedia.");
  return response.json();
}
