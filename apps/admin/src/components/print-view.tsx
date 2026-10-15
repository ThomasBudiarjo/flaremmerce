import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dateWIB, money } from "@/lib/format";
import type { OrderDetail } from "@/lib/types";

export function addressLines(address: Record<string, any>) {
  return [address.line, [address.subdistrict, address.district].filter(Boolean).join(", "), [address.city, address.province].filter(Boolean).join(", "), address.postalCode].filter(
    (line) => line && String(line).trim(),
  ) as string[];
}

/**
 * Opens the print dialog once a job is set and clears it after printing. While a job is active
 * the app root is hidden from print so only the portal'd PrintView reaches paper.
 */
export function usePrint<T>() {
  const [job, setJob] = useState<T | null>(null);
  useEffect(() => {
    if (!job) return;
    const root = document.getElementById("root");
    root?.classList.add("print:hidden");
    const done = () => setJob(null);
    window.addEventListener("afterprint", done);
    const timer = setTimeout(() => window.print(), 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("afterprint", done);
      root?.classList.remove("print:hidden");
    };
  }, [job]);
  return [job, setJob] as const;
}

function Document({ mode, order }: { mode: "invoice" | "packing"; order: OrderDetail }) {
  const subtotal = order.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  return (
    <section className="break-after-page p-8 last:break-after-auto" data-print-order={order.reference}>
      <div className="flex justify-between gap-4">
        <div>
          <p className="text-xl font-semibold">{mode === "invoice" ? "Invoice" : "Packing slip"}</p>
          <p>Flaremmerce</p>
        </div>
        <div className="text-right">
          <p className="font-medium">{order.reference}</p>
          <p>{dateWIB(order.createdAt)}</p>
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-6">
        <div>
          <p className="font-medium">Kirim ke</p>
          <p>{order.contact.name}</p>
          {order.contact.phone && <p>{order.contact.phone}</p>}
          {addressLines(order.address).map((line) => (
            <p key={line}>{line}</p>
          ))}
        </div>
        <div>
          <p className="font-medium">Pengiriman</p>
          <p>{order.shipping.service?.toUpperCase() ?? "—"}</p>
          {order.tracking && <p>Resi {order.tracking.number}</p>}
        </div>
      </div>
      <table className="mt-6 w-full border-collapse">
        <thead>
          <tr className="border-b text-left">
            <th className="py-1">Produk</th>
            <th className="py-1">SKU</th>
            <th className="py-1 text-right">Jumlah</th>
            {mode === "invoice" && <th className="py-1 text-right">Harga</th>}
            {mode === "invoice" && <th className="py-1 text-right">Subtotal</th>}
            {mode === "packing" && <th className="py-1 text-right">Dicek</th>}
          </tr>
        </thead>
        <tbody>
          {order.items.map((item) => (
            <tr key={item.id} className="border-b">
              <td className="py-1">
                {item.productName} · {item.name}
              </td>
              <td className="py-1">{item.sku}</td>
              <td className="py-1 text-right">{item.quantity}</td>
              {mode === "invoice" && <td className="py-1 text-right">{money(item.price, order.currency)}</td>}
              {mode === "invoice" && <td className="py-1 text-right">{money(item.price * item.quantity, order.currency)}</td>}
              {mode === "packing" && <td className="py-1 text-right">☐</td>}
            </tr>
          ))}
        </tbody>
      </table>
      {mode === "invoice" && (
        <div className="mt-4 ml-auto grid w-64 gap-1">
          <p className="flex justify-between">
            <span>Subtotal</span>
            <span>{money(subtotal, order.currency)}</span>
          </p>
          <p className="flex justify-between">
            <span>Ongkir</span>
            <span>{money(order.shipping.amount ?? 0, order.currency)}</span>
          </p>
          <p className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{money(order.total, order.currency)}</span>
          </p>
        </div>
      )}
    </section>
  );
}

/** Print-only documents, one page per order. */
export function PrintView({ mode, orders }: { mode: "invoice" | "packing"; orders: OrderDetail[] }) {
  return createPortal(
    <div className="hidden text-sm text-black print:block" data-print-view={mode}>
      {orders.map((order) => (
        <Document key={order.id} mode={mode} order={order} />
      ))}
    </div>,
    document.body,
  );
}
