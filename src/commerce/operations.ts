import { type CommerceEnv, json, statement as s } from './types';

// Partial age indexes keep each oldest-first sample bounded even after years of history.
// The planner picks them unaided for orders/reviews, but for payments/outbox it prefers the
// status-prefixed recovery indexes plus a sort of every unfinished row (EXPLAIN QUERY PLAN).
export async function operations(env: CommerceEnv) {
  const now = Date.now();
  const queries = {
    orders: "SELECT id,reference,status,created_at AS createdAt FROM orders WHERE status='pending_payment' ORDER BY created_at,id LIMIT 21",
    payments: "SELECT id,order_id AS orderId,reference,status,checks AS attempts,created_at AS createdAt FROM payment_attempts INDEXED BY operations_payments_age WHERE status IN ('created','pending','unknown') ORDER BY created_at,id LIMIT 21",
    outbox: "SELECT id,order_id AS orderId,status,attempts,created_at AS createdAt FROM outbox_events INDEXED BY operations_outbox_age WHERE status IN ('pending','dead') ORDER BY created_at,id LIMIT 21",
    reviews: "SELECT id,order_id AS orderId,status,created_at AS createdAt FROM manual_review WHERE status='open' ORDER BY created_at,id LIMIT 21",
  };
  const sections = Object.fromEntries(await Promise.all(Object.entries(queries).map(async ([name, query]) => {
    const { results } = await s(env, query).all<{ createdAt: number }>();
    return [name, { items: results.slice(0, 20).map(row => ({ ...row, ageMs: Math.max(0, now - row.createdAt) })), hasMore: results.length > 20, atLeast: results.length }];
  })));
  return json({ now, sampleLimit: 20, sections });
}
