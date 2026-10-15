/** Formatting and enum labels. Money is integer IDR; all timestamps render in Asia/Jakarta. */
export const money = (n: number, currency = "IDR") =>
  new Intl.NumberFormat("id-ID", { style: "currency", currency, maximumFractionDigits: 0 }).format(n);

export const number = (n: number) => new Intl.NumberFormat("id-ID").format(n);

export const dateWIB = (n: number | null | undefined) =>
  n == null ? "—" : new Date(n).toLocaleDateString("id-ID", { timeZone: "Asia/Jakarta", day: "numeric", month: "short", year: "numeric" });

export const timeWIB = (n: number | null | undefined) =>
  n == null ? "—" : new Date(n).toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

/** `datetime-local` value for an epoch ms, interpreted in WIB. */
export const wibInput = (n: number) => new Date(n + 7 * 3_600_000).toISOString().slice(0, 16);

/** Epoch ms of a `datetime-local` value read as WIB wall time. */
export function fromWibInput(value: string) {
  const time = Date.parse(`${value}:00+07:00`);
  return Number.isNaN(time) ? null : time;
}

export const orderStatus: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Terbayar",
  completed: "Selesai",
  cancelled: "Dibatalkan",
};

export const fulfillmentStatus: Record<string, string> = {
  unfulfilled: "Belum diproses",
  processing: "Diproses",
  shipped: "Dikirim",
  delivered: "Terkirim",
};

export const paymentStatus: Record<string, string> = {
  created: "Dibuat",
  pending: "Menunggu",
  unknown: "Belum diketahui",
  succeeded: "Berhasil",
  failed: "Gagal",
  expired: "Kedaluwarsa",
  ignored: "Diabaikan",
};

export const reviewReason: Record<string, string> = {
  payment_mismatch: "Nominal atau mata uang tidak cocok",
  unknown_reference: "Referensi pembayaran tidak dikenal",
  additional_payment_confirmation: "Konfirmasi pembayaran tambahan",
  late_payment: "Pembayaran setelah reservasi dilepas",
  reconciliation_exhausted: "Rekonsiliasi perlu ditindaklanjuti",
  outbox_exhausted: "Pekerjaan latar perlu ditindaklanjuti",
  risk_velocity: "Lonjakan pesanan mencurigakan",
  risk_disposable_email: "Email sekali pakai",
  provider_event: "Event penyedia pembayaran tidak dikenal",
};

export const reviewStatus: Record<string, string> = {
  open: "Terbuka",
  resolved: "Selesai",
};

export const milestoneKind: Record<string, string> = {
  preparing: "Sedang disiapkan",
  production: "Dalam produksi",
  ready_to_ship: "Siap dikirim",
};

export const eventKind: Record<string, string> = {
  created: "Pesanan dibuat",
  payment_recorded: "Pembayaran tercatat",
  processing: "Pesanan diproses",
  shipped: "Pesanan dikirim",
  delivered: "Pesanan terkirim",
  preparing: "Sedang disiapkan",
  production: "Dalam produksi",
  ready_to_ship: "Siap dikirim",
  cancelled_by_customer: "Dibatalkan oleh pembeli",
  campaign_updated: "Estimasi pre-order diperbarui",
  auto_completed: "Selesai otomatis setelah pengiriman",
};

export const variantMode: Record<string, string> = {
  stock: "Ready stock",
  preorder: "Pre-order",
};

export const blocklistKind: Record<string, string> = {
  email: "Email",
  phone: "Nomor HP",
  ip: "Alamat IP",
};

export const roleLabel: Record<string, string> = {
  owner: "Owner",
  ops: "Operasional",
  catalog: "Katalog",
};

// Same codes as the server's tracking-page table (src/shared.ts); unknown codes are still accepted.
export const couriers: Record<string, string> = {
  jne: "JNE",
  jnt: "J&T Express",
  sicepat: "SiCepat",
  anteraja: "AnterAja",
  pos: "Pos Indonesia",
  tiki: "TIKI",
  ninja: "Ninja Xpress",
  lion: "Lion Parcel",
  ide: "ID Express",
  sap: "SAP Express",
  wahana: "Wahana",
};

export const operationSection: Record<string, string> = {
  orders: "Menunggu pembayaran",
  payments: "Percobaan pembayaran",
  outbox: "Outbox belum selesai",
  reviews: "Review terbuka",
};

export const outboxStatus: Record<string, string> = {
  pending: "Menunggu",
  dead: "Gagal permanen",
};

/** Human age such as "3 jam" for a duration in ms. */
export function age(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)} menit`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} jam`;
  return `${Math.floor(hours / 24)} hari`;
}

/** "3 jam lalu"; anything under a minute (or slightly in the future from clock skew) is "baru saja". */
export const ago = (ms: number) => (ms < 60_000 ? "baru saja" : `${age(ms)} lalu`);

/** Today's calendar date (YYYY-MM-DD) in Asia/Jakarta. */
export const todayWIB = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10);

/** Calendar date `days` after a YYYY-MM-DD date (negative goes back). */
export const shiftDay = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** HH:MM in WIB. */
export const clockWIB = (n: number) => new Date(n).toLocaleTimeString("id-ID", { timeZone: "Asia/Jakarta", hour: "2-digit", minute: "2-digit" });

/** "1–15 Okt 2026 WIB", "28 Sep – 15 Okt 2026 WIB" or "15 Okt 2026 WIB" for an epoch range. */
export function rangeWIB(since: number, until: number) {
  const parts = (n: number) => {
    const d = new Date(n + 7 * 3_600_000);
    return { day: d.getUTCDate(), month: d.toLocaleDateString("id-ID", { timeZone: "UTC", month: "short" }), year: d.getUTCFullYear() };
  };
  const a = parts(since), b = parts(until);
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year} WIB`;
  if (a.month !== b.month) return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year} WIB`;
  if (a.day !== b.day) return `${a.day}–${b.day} ${b.month} ${b.year} WIB`;
  return `${b.day} ${b.month} ${b.year} WIB`;
}

/** Same rule as the server's normalizePhone (src/shared.ts): Indonesian mobile as +628…, else null. */
export function normalizePhone(value: string) {
  const match = /^(?:\+62|62|0)(8[1-9]\d{6,10})$/.exec(value.trim().replace(/[\s().-]/g, ""));
  return match ? `+62${match[1]}` : null;
}

/** WhatsApp click-to-chat link for an Indonesian mobile number, or null. */
export function whatsappLink(phone: string | null | undefined) {
  const normalized = phone ? normalizePhone(phone) : null;
  return normalized ? `https://wa.me/${normalized.slice(1)}` : null;
}

/** URL slug (same alphabet the server accepts): lowercase ASCII words joined by single hyphens, at most 100 characters. */
export function slugify(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 100)
    .replace(/-+$/, "");
}

export const label = (map: Record<string, string>, value: string | null | undefined) =>
  (value && map[value]) || value || "—";
