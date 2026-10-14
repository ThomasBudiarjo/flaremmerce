import type { IntegrationEnv } from './index';

/** Integration-owned expired rows, one bounded indexed DELETE each. Orders keep their own quote snapshot. */
export async function integrationRetention(env: IntegrationEnv) {
  const now = Date.now(), bounded = (table: string, column: string, before: number) =>
    env.DB.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE ${column}<? LIMIT 200)`).bind(before);
  await env.DB.batch([
    bounded('shipping_quotes', 'expires_at', now - 3_600_000),
    bounded('session', 'expires_at', now),
    bounded('verification', 'expires_at', now),
  ]);
}
