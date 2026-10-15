import { lookupPayment, verifyPaymentWebhook } from '../integrations/index';
import { type CommerceEnv, id, json, statement as s } from './types';
import { envMinutes, PAYMENT_DUE_MINUTES } from '../shared';

type VerifiedEvent = { eventKey: string; reference: string; amount: number; currency: string; status: 'succeeded' | 'failed' | 'expired' | 'ignored' | 'provider_event'; providerTx?: string; kind?: string };
// Exhausted attempts keep their unfinished status for operators but leave every next_check range scan.
export const EXHAUSTED = 8_640_000_000_000_000;

function technicalId(value: string) { return /^[a-zA-Z0-9:_-]{1,200}$/.test(value) ? value : 'redacted'; }
export function lookupEvent(reference: string, result: { amount: number; currency: string; providerTx?: string }): VerifiedEvent {
  return { eventKey: `lookup:${reference}:succeeded:${result.amount}:${result.currency}`, reference, amount: result.amount, currency: result.currency, status: 'succeeded', ...(result.providerTx ? { providerTx: result.providerTx } : {}) };
}
/** Checkout due date plus grace (0–120 minutes, default 30). */
export function expiryDeadline(env: CommerceEnv, createdAt: number) {
  return createdAt + (PAYMENT_DUE_MINUTES + envMinutes(env.EXPIRY_GRACE_MIN, 30, 120)) * 60_000;
}
/** Total provider lookups per attempt before it is filed as reconciliation_exhausted. */
export const MAX_CHECKS = 8;
const MINUTE = 60_000;
// Before the deadline only two early checkpoints catch a paid order whose webhook was lost; an abandoned order then
// needs one lookup at the deadline. After it, only inconclusive answers continue, 5, 10, 20, 40 and 60 minutes apart.
const EARLY = [10, 30], LATE = [5, 15, 35, 75, 135];
/**
 * First checkpoint after `now`. Checkpoints are anchored to creation and to the deadline, so a late cron run skips the
 * ones it missed instead of adding lookups, and every grace value still gets a check at or after its deadline.
 */
export function nextLookup(env: CommerceEnv, createdAt: number, now: number) {
  const deadline = expiryDeadline(env, createdAt);
  const points = [...EARLY.map(m => createdAt + m * MINUTE).filter(t => t < deadline), deadline, ...LATE.map(m => deadline + m * MINUTE)];
  return points.find(t => t > now) ?? now + 60 * MINUTE;
}

export async function applyPayment(env: CommerceEnv, event: VerifiedEvent) {
  const { eventKey: key, reference, amount, currency, status } = event, providerTx = event.providerTx ?? null;
  const now = Date.now();
  if (status === 'provider_event') {
    // Recorded as already-processed evidence plus an operator review; no payment, order or stock change.
    await env.DB.batch([
      s(env, "INSERT OR IGNORE INTO payment_events(event_key,reference,amount,currency,status,provider_tx,processed,kind,created_at) VALUES(?,?,?,?,'ignored',?,1,?,?)", key, reference, amount, currency, providerTx, event.kind ?? null, now),
      s(env, `INSERT OR IGNORE INTO manual_review(id,event_key,order_id,reason,created_at)
        SELECT ?,?,o.id,CASE WHEN o.id IS NULL THEN 'unknown_reference' ELSE 'provider_event' END,? FROM (SELECT 1) LEFT JOIN payment_attempts a ON a.reference=? LEFT JOIN orders o ON o.id=a.order_id`, id(), key, now, reference),
    ]);
    console.info('payment_transition', { status, outcome: 'review' });
    return;
  }
  if (status === 'ignored') {
    // Authenticated Checkout FAILED is durable/acknowledged, never terminal failure.
    await s(env, 'INSERT OR IGNORE INTO payment_events(event_key,reference,amount,currency,status,provider_tx,processed,created_at) VALUES(?,?,?,?,?,?,1,?)', key, reference, amount, currency, status, providerTx, now).run();
    return;
  }
  // All decisions are inside the serialized D1 batch. Success racing with cancellation is either
  // consumed+paid, or late-payment review; it can never consume released reservations.
  // A success matching the event that actually paid the order (applied=1, same reference/amount/currency) is that
  // payment seen twice, recorded but not reviewed, when both carry the same provider transaction (webhook retry under
  // a new Request-Id), or when one side lacks it and one of the two is a status lookup (lookup racing the webhook).
  // Two webhooks without a shared transaction may be two real payments of the same amount: reviewed.
  const outcome = await env.DB.batch([
    s(env, 'INSERT OR IGNORE INTO payment_events(event_key,reference,amount,currency,status,provider_tx,created_at) VALUES(?,?,?,?,?,?,?)', key, reference, amount, currency, status, providerTx, now),
    s(env, `INSERT OR IGNORE INTO manual_review(id,event_key,order_id,reason,created_at)
      SELECT ?,e.event_key,o.id,CASE WHEN o.id IS NULL THEN 'unknown_reference' WHEN o.total<>e.amount OR o.currency<>e.currency THEN 'payment_mismatch' WHEN o.status IN ('paid','completed') THEN 'additional_payment_confirmation' ELSE 'late_payment' END,?
      FROM payment_events e LEFT JOIN payment_attempts a ON a.reference=e.reference LEFT JOIN orders o ON o.id=a.order_id
      WHERE e.event_key=? AND e.processed=0 AND (o.id IS NULL OR o.total<>e.amount OR o.currency<>e.currency OR (e.status='succeeded' AND (o.status='cancelled' OR (o.status IN ('paid','completed') AND NOT EXISTS(
        SELECT 1 FROM payment_events p WHERE p.reference=e.reference AND p.applied=1 AND p.amount=e.amount AND p.currency=e.currency
        AND (p.provider_tx=e.provider_tx OR ((p.provider_tx IS NULL OR e.provider_tx IS NULL) AND (p.event_key LIKE 'lookup:%' OR e.event_key LIKE 'lookup:%'))))))))`, id(), now, key),
    s(env, `UPDATE payment_attempts SET status=? WHERE status<>'succeeded' AND reference IN (SELECT e.reference FROM payment_events e JOIN orders o ON o.reference=e.reference WHERE e.event_key=? AND e.processed=0 AND e.amount=o.total AND e.currency=o.currency AND NOT EXISTS(SELECT 1 FROM manual_review r WHERE r.event_key=e.event_key))`, status, key),
    // Uncorrelated scalar subquery: the planner seeks the order by primary key instead of scanning a status range.
    s(env, `UPDATE orders SET status=CASE WHEN ?='succeeded' THEN 'paid' ELSE 'cancelled' END
      WHERE status='pending_payment' AND id=(SELECT o.id FROM payment_events e JOIN payment_attempts a ON a.reference=e.reference JOIN orders o ON o.id=a.order_id WHERE e.event_key=? AND e.processed=0 AND e.amount=o.total AND e.currency=o.currency AND NOT EXISTS(SELECT 1 FROM manual_review r WHERE r.event_key=e.event_key))`, status, key),
    // Must directly follow the order UPDATE: changes() is its own row count (trigger writes excluded).
    s(env, `UPDATE payment_events SET processed=1,applied=CASE WHEN processed=0 AND ?='succeeded' AND changes()=1 THEN 1 ELSE applied END WHERE event_key=?`, status, key),
  ]);
  console.info('payment_transition', { status, outcome: outcome[3].meta.changes ? 'transitioned' : outcome[1].meta.changes ? 'review' : 'no_transition' });
}

export async function webhook(request: Request, env: CommerceEnv) {
  const event = await verifyPaymentWebhook(request, env);
  await applyPayment(env, event);
  return json({ received: true });
}

export async function reconcile(env: CommerceEnv) {
  const now = Date.now();
  // Combined reconciliation + outbox work stays below the Free invocation subrequest budget.
  const rows = await s(env, `SELECT a.reference,a.checks,a.order_id,a.created_at,a.url,o.total FROM payment_attempts a JOIN orders o ON o.id=a.order_id
    WHERE a.status IN ('created','pending','unknown') AND a.next_check<=? AND a.checks<${MAX_CHECKS} ORDER BY a.next_check LIMIT 5`, now)
    .all<{ reference: string; checks: number; order_id: string; created_at: number; url: string | null; total: number }>();
  for (const row of rows.results) {
    const deadline = expiryDeadline(env, row.created_at);
    // Claim a bounded retry slot before lookup; crashes recover at the next checkpoint.
    const claim = await s(env, `UPDATE payment_attempts SET checks=checks+1,next_check=? WHERE reference=? AND checks=? AND next_check<=? AND status IN ('created','pending','unknown')`, nextLookup(env, row.created_at, now), row.reference, row.checks, now).run();
    if (!claim.meta.changes) continue;
    console.info('payment_lookup_retry', { orderId: technicalId(row.order_id), attempt: row.checks + 1 });
    try {
      const result = await lookupPayment(row.reference, env);
      const expire = (amount: number) => applyPayment(env, { eventKey: `expiry:${row.reference}`, reference: row.reference, amount, currency: 'IDR', status: 'expired' });
      if (result.status === 'succeeded') await applyPayment(env, lookupEvent(row.reference, result));
      // Only an authoritative not-paid answer after due date + grace releases stock; the clock alone never does.
      else if (result.status === 'not_paid' && now >= deadline) await expire(result.amount);
      // DOKU has no invoice and the shopper never received a payment page (creation failed ambiguously), so nothing
      // can have been paid. With a page issued, a missing invoice is unexplained: hold for the exhausted review.
      else if (result.status === 'not_found' && now >= deadline && !row.url) await expire(row.total);
      else console.warn('payment_lookup_unknown', { orderId: technicalId(row.order_id), kind: result.status === 'not_found' ? (row.url ? 'not_found_with_link' : 'not_found_not_due') : result.status === 'not_paid' ? 'not_due' : 'nonterminal' });
    } catch { console.warn('payment_lookup_failure', { orderId: technicalId(row.order_id), kind: 'lookup_error' }); }
  }
  // Single deterministic review path, also repairing a crash between the last claim and this sweep.
  // The bound covers the longest gap between checkpoints, so a just-exhausted attempt is filed in the same run.
  await env.DB.batch([
    s(env, `INSERT OR IGNORE INTO manual_review(id,event_key,order_id,reason,created_at)
      SELECT 'recovery:' || reference,'recovery:' || reference,order_id,'reconciliation_exhausted',?
      FROM payment_attempts WHERE status IN ('created','pending','unknown') AND next_check<=? AND checks>=${MAX_CHECKS} ORDER BY next_check LIMIT 5`, now, now + 3_600_000),
    s(env, `UPDATE payment_attempts SET next_check=? WHERE status IN ('created','pending','unknown') AND next_check<=? AND checks>=${MAX_CHECKS}
      AND EXISTS(SELECT 1 FROM manual_review r WHERE r.event_key='recovery:' || payment_attempts.reference)`, EXHAUSTED, now + 3_600_000),
  ]);
}

export async function consumeOutbox(env: CommerceEnv, outboxId: string) {
  const now = Date.now();
  // Baseline has only internal durable effects, not email or implicit shipping.
  await env.DB.batch([
    s(env, `INSERT OR IGNORE INTO order_events(id,order_id,kind,created_at) SELECT id || ':handled',order_id,'payment_recorded',? FROM outbox_events WHERE id=? AND status='pending'`, now, outboxId),
    s(env, "UPDATE outbox_events SET status='done' WHERE id=? AND status='pending'", outboxId),
  ]);
}

export async function recoverOutbox(env: CommerceEnv) {
  const now = Date.now();
  const rows = await s(env, "SELECT id,attempts FROM outbox_events WHERE status='pending' AND next_run<=? ORDER BY next_run LIMIT 10", now).all<{ id: string; attempts: number }>();
  for (const row of rows.results) {
    if (row.attempts >= 8) {
      const result = await env.DB.batch([
        s(env, `INSERT OR IGNORE INTO manual_review(id,event_key,order_id,reason,created_at) SELECT ?,id,order_id,'outbox_exhausted',? FROM outbox_events WHERE id=? AND status='pending'`, id(), now, row.id),
        s(env, "UPDATE outbox_events SET status='dead' WHERE id=? AND status='pending'", row.id),
      ]);
      if (result[1].meta.changes) console.warn('outbox_dead', { outboxId: technicalId(row.id), attempts: row.attempts });
      continue;
    }
    const claim = await s(env, "UPDATE outbox_events SET attempts=attempts+1,next_run=? WHERE id=? AND status='pending' AND attempts=? AND next_run<=?", now + Math.min(3_600_000, 30_000 * 2 ** row.attempts), row.id, row.attempts, now).run();
    if (!claim.meta.changes) continue;
    console.info('outbox_retry', { outboxId: technicalId(row.id), attempt: row.attempts + 1 });
    try {
      if (env.JOBS) await env.JOBS.send({ outboxId: row.id });
      else await consumeOutbox(env, row.id);
    } catch { console.warn('outbox_failure', { outboxId: technicalId(row.id), kind: 'delivery_error' }); }
  }
}
