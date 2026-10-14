/** Fetch wrapper for admin APIs: same-origin credentials, JSON in/out, typed HTTP errors. */
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

type Options = {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
};

export async function api<T = any>(path: string, options: Options = {}): Promise<T> {
  const { method, body, signal } = options;
  const response = await fetch(path, {
    method: method ?? (body !== undefined ? "POST" : "GET"),
    credentials: "same-origin",
    cache: "no-store",
    signal,
    headers: body !== undefined ? { "Content-Type": "application/json" } : {},
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      (typeof data?.error === "object" && data.error?.message) ||
      data?.message ||
      (typeof data?.error === "string" ? data.error : null) ||
      "Permintaan gagal. Periksa izin akun dan konfigurasi layanan.";
    throw new HttpError(response.status, message, data?.details);
  }
  return data as T;
}

export const get = <T = any>(path: string, signal?: AbortSignal) => api<T>(path, { signal });
export const post = <T = any>(path: string, body?: unknown) => api<T>(path, { body: body ?? {} });
export const patch = <T = any>(path: string, body: unknown) => api<T>(path, { method: "PATCH", body });
export const del = <T = any>(path: string) => api<T>(path, { method: "DELETE" });
