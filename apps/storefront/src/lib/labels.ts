/** Order status, fulfillment and timeline kinds as shown to shoppers. Unknown kinds fall back to the raw code. */
export const labels: Record<string, string> = {
  pending_payment: "Menunggu pembayaran",
  paid: "Pembayaran terkonfirmasi",
  completed: "Pesanan selesai",
  cancelled: "Dibatalkan",
  processing: "Sedang dipersiapkan",
  shipped: "Sudah dikirim",
  delivered: "Sudah diterima",
  unfulfilled: "Belum diproses",
  preparing: "Persiapan",
  production: "Produksi",
  ready_to_ship: "Siap kirim",
  payment_recorded: "Pembayaran dicatat",
  cancelled_by_customer: "Dibatalkan oleh pembeli",
  campaign_updated: "Estimasi pre-order diperbarui",
  auto_completed: "Selesai otomatis setelah pengiriman",
};
export const paymentLabels: Record<string, string> = {
  created: "Sedang dibuat",
  pending: "Menunggu pembayaran",
  unknown: "Belum diketahui",
  succeeded: "Berhasil",
  failed: "Ditolak penyedia",
  expired: "Kedaluwarsa",
};
