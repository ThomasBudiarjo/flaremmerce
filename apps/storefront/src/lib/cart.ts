import { MAX_CART_LINES, MAX_LINE_QUANTITY } from "../../../../src/shared";
export { MAX_CART_LINES, MAX_LINE_QUANTITY };
export type CartItem = { variantId: string; quantity: number };
const key = "flaremmerce-cart";
/**
 * Stored cart, repaired to what the cart preview accepts: one line per variant ID of at most 100 characters, 1–100 units each. A bad
 * entry is dropped on its own; a cart the server refuses would otherwise stay stuck in localStorage.
 */
export function readCart(): CartItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(value)) return [];
    const lines = new Map<string, number>();
    for (const v of value) {
      if (!v || typeof v !== "object" || typeof v.variantId !== "string" || !v.variantId || v.variantId.length > 100 || !Number.isInteger(v.quantity) || v.quantity < 1) continue;
      if (!lines.has(v.variantId) && lines.size >= MAX_CART_LINES) continue;
      lines.set(v.variantId, Math.min(MAX_LINE_QUANTITY, (lines.get(v.variantId) ?? 0) + v.quantity));
    }
    return [...lines].map(([variantId, quantity]) => ({ variantId, quantity }));
  } catch {
    return [];
  }
}
export function writeCart(items: CartItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
  syncCartCount(items);
}
/**
 * Header badge is filled by islands that already run on the page; cached SSR HTML never carries a
 * count and no extra script is shipped just for it.
 */
export function syncCartCount(items: CartItem[] = readCart()) {
  if (typeof document === "undefined") return;
  const count = items.reduce((sum, item) => sum + item.quantity, 0);
  for (const badge of document.querySelectorAll<HTMLElement>("[data-cart-count]")) {
    badge.textContent = count ? String(count) : "";
    badge.hidden = !count;
    badge.closest("a")?.setAttribute("aria-label", count ? `Keranjang, ${count} barang` : "Keranjang");
  }
}
/** Error from api(): `status` is absent for network failures; `details` carries server data such as the authoritative total. */
export type ApiError = Error & { status?: number; details?: any };
const failure = (data: any, status: number, fallback: string): ApiError =>
  Object.assign(new Error(data.error?.message || data.message || (typeof data.error === "string" ? data.error : fallback)), { status, details: data.details });
export async function api(path: string, body?: unknown, headers?: HeadersInit, method?: string) {
  const response = await fetch(path, {
    method: method ?? (body ? "POST" : "GET"),
    credentials: "same-origin",
    cache: "no-store",
    headers: {
      ...(body ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  // Scope is established before Siteverify is consumed; retry the exact key/body once.
  if (path === "/api/checkout" && response.status === 428 && data.error === "checkout_scope_required") {
    const retry = await fetch(path, {
      method: "POST", credentials: "same-origin", cache: "no-store",
      headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const result = await retry.json().catch(() => ({}));
    if (!retry.ok) throw failure(result, retry.status, "Checkout gagal.");
    return result;
  }
  if (!response.ok) throw failure(data, response.status, "Permintaan gagal. Silakan coba lagi.");
  return data;
}
/** A response that proves the server did not act (validation, limits, conflicts); 408 and 5xx/network stay ambiguous. */
export const definiteRefusal = (error: unknown) => {
  const status = (error as ApiError).status;
  return status !== undefined && status >= 400 && status < 500 && status !== 408;
};
/** Small private text file; the token never enters a URL or history. */
export function downloadText(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
export function confirmationText(reference: string, token: string, origin: string) {
  return [
    "Konfirmasi pesanan Flaremmerce",
    "",
    `Referensi: ${reference}`,
    `Token akses privat: ${token}`,
    "",
    `Cek status di ${origin}/order: masukkan referensi dan token di atas.`,
    "Simpan file ini secara privat. Siapa pun yang memegang token dapat melihat pesanan dan alamat pengiriman.",
    "Token tidak dapat dipulihkan dan tidak dikirim lewat email.",
    "",
  ].join("\r\n");
}
export async function google(callbackURL: string) {
  const data = await api("/api/auth/sign-in/social", {
    provider: "google",
    callbackURL,
  });
  if (data.url) location.assign(data.url);
  else throw new Error("Google sign-in belum tersedia.");
}
