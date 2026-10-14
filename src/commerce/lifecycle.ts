import { envCount } from '../shared';
import { type CommerceEnv, statement as s } from './types';

const DAY = 86_400_000;
export const REDACTED = '{"redacted":true}';

/** Shipped orders without an open review become delivered + completed after AUTO_COMPLETE_DAYS, at most 20 per run. */
export async function autoComplete(env: CommerceEnv) {
  const days = envCount(env.AUTO_COMPLETE_DAYS, 14), now = Date.now();
  // In-flight paid orders are few; the status index bounds the scan and the shipped event dates the hand-over.
  const { results } = await s(env, `SELECT o.id FROM orders o JOIN order_events e ON e.order_id=o.id AND e.kind='shipped'
    WHERE o.status='paid' AND o.fulfillment='shipped' AND e.created_at<? AND NOT EXISTS(SELECT 1 FROM manual_review r WHERE r.order_id=o.id AND r.status='open') ORDER BY e.created_at LIMIT 20`, now - days * DAY).all<{ id: string }>();
  if (!results.length) return 0;
  const ids = results.map(r => r.id), marks = ids.map(() => '?').join(',');
  // The event is written only for still-eligible orders, and the UPDATE only moves orders that got the event:
  // both are re-evaluated inside one serialized batch, so a review opened meanwhile keeps the order untouched.
  const [events] = await env.DB.batch([
    s(env, `INSERT OR IGNORE INTO order_events(id,order_id,kind,details_json,created_at) SELECT id || ':auto_completed',id,'auto_completed',?,? FROM orders
      WHERE id IN (${marks}) AND status='paid' AND fulfillment='shipped' AND NOT EXISTS(SELECT 1 FROM manual_review r WHERE r.order_id=orders.id AND r.status='open')`, JSON.stringify({ afterDays: days }), now, ...ids),
    s(env, `UPDATE orders SET fulfillment='delivered',status='completed' WHERE id IN (${marks}) AND status='paid' AND fulfillment='shipped' AND EXISTS(SELECT 1 FROM order_events WHERE id=orders.id || ':auto_completed')`, ...ids),
  ]);
  return events.meta.changes;
}

/** Commerce-side retention: idempotency records after 7 days and, only when configured, PII on finished orders. */
export async function commerceRetention(env: CommerceEnv) {
  const now = Date.now();
  // A retry after seven days creates a new order instead of returning the old one; clients never retry that late.
  await s(env, `DELETE FROM checkout_requests WHERE rowid IN (SELECT rowid FROM checkout_requests WHERE created_at<? AND NOT EXISTS(SELECT 1 FROM orders WHERE id=checkout_requests.order_id AND status='pending_payment') LIMIT 200)`, now - 7 * DAY).run();
  const raw = env.ORDER_PII_RETENTION_DAYS;
  if (!raw) return;
  const days = envCount(raw, 0);
  if (!days) return;
  // The immutability trigger allows exactly this marker on completed or cancelled orders, once. The planner would
  // otherwise pick orders_status_page and rescan every already-redacted row; the partial index holds only pending work.
  await s(env, `UPDATE orders SET contact_json=?,address_json=?,pii_redacted_at=? WHERE rowid IN (SELECT rowid FROM orders INDEXED BY orders_pii_pending WHERE pii_redacted_at IS NULL AND status IN ('completed','cancelled') AND created_at<? LIMIT 100)`,
    REDACTED, REDACTED, now, now - days * DAY).run();
}
