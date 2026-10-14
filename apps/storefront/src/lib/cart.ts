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
export async function api(path: string, body?: unknown, headers?: HeadersInit) {
  const response = await fetch(path, {
    method: body ? "POST" : "GET",
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
    if (!retry.ok) throw Object.assign(new Error(typeof result.error === "string" ? result.error : "Checkout gagal."), { status: retry.status });
    return result;
  }
  if (!response.ok)
    throw Object.assign(new Error(
      data.error?.message ||
        data.message ||
        (typeof data.error === "string"
          ? data.error
          : "Permintaan gagal. Silakan coba lagi."),
    ), { status: response.status });
  return data;
}
export async function google(callbackURL: string) {
  const data = await api("/api/auth/sign-in/social", {
    provider: "google",
    callbackURL,
  });
  if (data.url) location.assign(data.url);
  else throw new Error("Google sign-in belum tersedia.");
}
