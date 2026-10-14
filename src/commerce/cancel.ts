import { lookupPayment } from '../integrations/index';
import { applyPayment, lookupEvent } from './payments';
import { type CommerceEnv, HttpError, id, statement as s } from './types';

export type CancelActor = { kind: 'customer' } | { kind: 'admin'; actor: string; reason?: string };
/** Extra statements run first in the same batch; `condition` gates the order UPDATE on their effect. */
export type CancelGuard = { before: D1PreparedStatement[]; condition: string; values: (string | number | null)[] };

// A pending order is only cancelled after DOKU authoritatively says it is unpaid right now.
// A success found here is applied (never discarded); lookup errors leave the hold untouched.
async function confirmUnpaid(env: CommerceEnv, reference: string) {
  let result: Awaited<ReturnType<typeof lookupPayment>>;
  try { result = await lookupPayment(reference, env); }
  catch { throw new HttpError(503, 'Cannot confirm payment status; try again later'); }
  if (result.status === 'succeeded') {
    await applyPayment(env, lookupEvent(reference, result));
    throw new HttpError(409, 'Payment already succeeded; order cannot be cancelled');
  }
  if (result.status !== 'not_paid') throw new HttpError(503, 'Cannot confirm payment status; try again later');
}

export async function cancelOrder(env: CommerceEnv, orderId: string, by: CancelActor, guard?: CancelGuard) {
  const order = await s(env, 'SELECT id,reference,status FROM orders WHERE id=?', orderId).first<{ id: string; reference: string; status: string }>();
  if (!order) throw new HttpError(404, 'Order not found');
  if (order.status === 'pending_payment') await confirmUnpaid(env, order.reference);
  else if (order.status !== 'cancelled') throw new HttpError(409, 'Only unpaid orders can be cancelled');
  else if (!guard) return { order: { id: order.id, reference: order.reference, status: 'cancelled' }, changed: false, results: [] as D1Result[] };
  const now = Date.now(), before = guard?.before ?? [];
  // A success landing between lookup and this batch wins the conditional UPDATE; a later one
  // becomes late_payment review. changes() is the order UPDATE's own count, not its triggers'.
  const results = await env.DB.batch([...before,
    s(env, `UPDATE orders SET status='cancelled' WHERE id=? AND status='pending_payment'${guard?.condition ?? ''}`, orderId, ...(guard?.values ?? [])),
    by.kind === 'customer'
      ? s(env, `INSERT INTO order_events(id,order_id,kind,details_json,created_at) SELECT ?,?,'cancelled_by_customer','{}',? WHERE changes()=1`, `${orderId}:cancelled_by_customer`, orderId, now)
      : s(env, `INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,'order.cancel',?,?,? WHERE changes()=1`, id(), by.actor, orderId, JSON.stringify({ reference: order.reference, ...(by.reason ? { reason: by.reason } : {}) }), now),
    s(env, `UPDATE payment_attempts SET status='expired' WHERE order_id=? AND status IN ('created','pending','unknown') AND EXISTS(SELECT 1 FROM orders WHERE id=? AND status='cancelled')`, orderId, orderId),
  ]);
  const status = await s(env, 'SELECT status FROM orders WHERE id=?', orderId).first<string>('status');
  return { order: { id: order.id, reference: order.reference, status }, changed: results[before.length].meta.changes > 0, results };
}
