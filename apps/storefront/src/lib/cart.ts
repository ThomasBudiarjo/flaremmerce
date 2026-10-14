import { MAX_CART_LINES } from "../../../../src/shared";
export { MAX_CART_LINES };
export type CartItem = { variantId: string; quantity: number };
const key = "flaremmerce-cart";
export function readCart(): CartItem[] {
  try {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value)
      ? value
          .filter(
            (v) =>
              typeof v.variantId === "string" &&
              Number.isInteger(v.quantity) &&
              v.quantity > 0,
          )
          .slice(0, MAX_CART_LINES)
      : [];
  } catch {
    return [];
  }
}
export function writeCart(items: CartItem[]) {
  localStorage.setItem(key, JSON.stringify(items));
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
