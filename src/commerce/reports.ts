import { envCount, normalizeEmail, normalizePhone, riskHash, riskSecret } from '../shared';
import { type CommerceEnv, HttpError, id, json, statement as s } from './types';

const HELD = "EXISTS(SELECT 1 FROM manual_review r WHERE r.order_id=orders.id AND r.status='open')";
// Admin tabs; `held` (an open review blocks fulfillment) is not an order status but cuts across them.
const statuses: Record<string, string> = {
  pending_payment: "status='pending_payment'", paid: "status='paid'", completed: "status='completed'", cancelled: "status='cancelled'",
  to_fulfill: `status='paid' AND fulfillment IN ('unfulfilled','processing') AND NOT ${HELD}`,
  shipped: "status='paid' AND fulfillment='shipped'",
  held: "id IN (SELECT order_id FROM manual_review WHERE status='open')",
};
const DAY = 86_400_000, WIB = 7 * 3_600_000;
/** Start of a WIB calendar day (YYYY-MM-DD) in epoch ms; null when the text is not a real date. */
function wibDay(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const time = Date.parse(`${value}T00:00:00+07:00`);
  return Number.isNaN(time) || new Date(time + WIB).toISOString().slice(0, 10) !== value ? null : time;
}
export const wibMidnight = (now: number) => Math.floor((now + WIB) / DAY) * DAY - WIB;

/** WHERE clauses for admin order lists and exports. `q` is an exact reference, or an email/phone matched by its risk hash. */
export async function orderFilter(env: CommerceEnv, params: URLSearchParams) {
  const where: string[] = [], values: (string | number)[] = [];
  const status = params.get('status');
  if (status !== null && status !== '') {
    if (!statuses[status]) throw new HttpError(400, 'Invalid status filter');
    where.push(statuses[status]);
  }
  for (const [name, op, shift] of [['from', '>=', 0], ['to', '<', DAY]] as const) {
    const raw = params.get(name);
    if (raw === null || raw === '') continue;
    const day = wibDay(raw);
    if (day === null) throw new HttpError(400, `Invalid ${name} date`);
    where.push(`created_at${op}?`); values.push(day + shift);
  }
  const q = params.get('q')?.trim();
  if (q) {
    if (q.length > 254) throw new HttpError(400, 'Invalid search');
    // Raw contact data is never searched; the same keyed hash checkout stores is compared instead.
    const phone = normalizePhone(q);
    if (q.includes('@')) { where.push('email_hash=?'); values.push(await riskHash(riskSecret(env), 'email', normalizeEmail(q))); }
    else if (phone) { where.push('phone_hash=?'); values.push(await riskHash(riskSecret(env), 'phone', phone)); }
    else { where.push('reference=?'); values.push(q); }
  }
  return { where, values, filters: { status: status || null, from: params.get('from') || null, to: params.get('to') || null, q: q ? (q.includes('@') ? 'email' : normalizePhone(q) ? 'phone' : 'reference') : null } };
}

type Filter = Awaited<ReturnType<typeof orderFilter>>;
export const orderPage = (env: CommerceEnv, filter: Filter, columns: string, before: number, beforeId: string, limit: number) =>
  s(env, `SELECT ${columns} FROM orders WHERE ${[...filter.where, '(created_at<? OR (created_at=? AND id<?))'].join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`, ...filter.values, before, before, beforeId, limit).all<Record<string, unknown>>();

/** Spreadsheet formula injection: text that a spreadsheet would evaluate gets a leading apostrophe. */
export function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}
const header = ['reference', 'created_at', 'status', 'fulfillment', 'hold', 'total', 'currency', 'name', 'email', 'phone', 'address', 'subdistrict', 'district', 'city', 'province', 'postal_code', 'shipping_service', 'shipping_amount'];
const EXPORT_PAGE = 500;

/** Streams keyset pages (each one bounded query) up to the row cap; the export itself is audited before any PII leaves. */
export async function exportOrders(env: CommerceEnv, actor: string, params: URLSearchParams) {
  const filter = await orderFilter(env, params), cap = Math.min(envCount(params.get('limit') ?? undefined, 5000), 5000);
  await s(env, "INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) VALUES(?,?,'orders.export','orders',?,?)", id(), actor, JSON.stringify({ filters: filter.filters, cap }), Date.now()).run();
  let cursor: [number, string] = [Number.MAX_SAFE_INTEGER, ''], sent = 0, started = false;
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) { started = true; controller.enqueue(encoder.encode(`${header.join(',')}\r\n`)); }
      const size = Math.min(EXPORT_PAGE, cap - sent);
      const { results } = size > 0 ? await orderPage(env, filter, `id,reference,created_at,status,fulfillment,total,currency,contact_json,address_json,shipping_json,${HELD} AS held`, cursor[0], cursor[1], size) : { results: [] };
      if (!results.length) { controller.close(); return; }
      const lines = results.map(row => {
        const contact = JSON.parse(String(row.contact_json)), address = JSON.parse(String(row.address_json)), shipping = JSON.parse(String(row.shipping_json));
        return [row.reference, new Date(Number(row.created_at)).toISOString(), row.status, row.fulfillment, row.held ? 'held' : '', row.total, row.currency, contact.name, contact.email, contact.phone,
          address.line, address.subdistrict, address.district, address.city, address.province, address.postalCode, shipping.service, shipping.amount].map(csvCell).join(',');
      });
      controller.enqueue(encoder.encode(`${lines.join('\r\n')}\r\n`));
      sent += results.length;
      const last = results.at(-1)!;
      cursor = [Number(last.created_at), String(last.id)];
      if (results.length < size || sent >= cap) controller.close();
    },
  });
  const day = new Date(wibMidnight(Date.now()) + WIB).toISOString().slice(0, 10);
  return new Response(stream, { headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="orders-${day}.csv"`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
}

/**
 * Dashboard counters from indexed ranges. Sales count paid and completed orders by payment time; 7d and 30d are WIB
 * calendar days ending today, like the order list presets. `revenue` is gross (items + shipping), split in the response.
 */
export async function summary(env: CommerceEnv, url: URL) {
  const range = url.searchParams.get('range') ?? 'today', now = Date.now(), days: Record<string, number> = { today: 1, '7d': 7, '30d': 30 };
  if (!Object.hasOwn(days, range)) throw new HttpError(400, 'Invalid range');
  const since = wibMidnight(now) - (days[range] - 1) * DAY;
  // CROSS JOIN keeps the scan on the range's paid events instead of every paid and completed order ever.
  const [paid, pending, toFulfill, reviews, low] = await env.DB.batch([
    s(env, `SELECT count(*) AS n,coalesce(sum(o.total),0) AS revenue,coalesce(sum(json_extract(o.shipping_json,'$.amount')),0) AS shipping
      FROM order_events e CROSS JOIN orders o ON o.id=e.order_id WHERE e.kind='paid' AND e.created_at>=? AND o.status IN ('paid','completed')`, since),
    s(env, "SELECT count(*) AS n FROM orders WHERE status='pending_payment'"),
    s(env, `SELECT count(*) AS n FROM orders WHERE status='paid' AND fulfillment IN ('unfulfilled','processing') AND NOT ${HELD}`),
    s(env, "SELECT count(*) AS n FROM manual_review WHERE status='open'"),
    s(env, `SELECT count(*) AS n FROM product_variants v JOIN inventory i ON i.variant_id=v.id JOIN products p ON p.id=v.product_id WHERE ${LOW_STOCK}`, envCount(env.LOW_STOCK_DEFAULT, 5)),
  ]);
  const first = (r: D1Result) => r.results[0] as { n: number; revenue?: number; shipping?: number };
  const count = first(paid).n, revenue = first(paid).revenue ?? 0, shipping = first(paid).shipping ?? 0;
  return json({ range, since, now, revenue, itemsRevenue: revenue - shipping, shipping, paidOrders: count, averageOrderValue: count ? Math.round(revenue / count) : 0,
    pendingPayment: first(pending).n, toFulfill: first(toFulfill).n, openReviews: first(reviews).n, lowStock: first(low).n });
}
/** Active ready-stock variants at or below their threshold (per-variant, else LOW_STOCK_DEFAULT bound as the only parameter). */
export const LOW_STOCK = "v.mode='stock' AND v.active=1 AND p.active=1 AND i.on_hand-i.reserved<=coalesce(v.low_stock_threshold,?)";
