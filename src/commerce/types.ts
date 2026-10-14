import type { IntegrationEnv } from '../integrations/index';
export { HttpError, hash } from '../shared';

export interface CommerceEnv extends IntegrationEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS?: Queue;
  PUBLIC_ORIGIN: string;
}
export const id = () => crypto.randomUUID();
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
export const statement = (env: CommerceEnv, sql: string, ...values: (string | number | null)[]) => env.DB.prepare(sql).bind(...values);
/** Keyset page from a `limit + 1` query. */
export function page<T>(rows: T[], limit: number, cursor: (last: T) => { before: unknown; beforeId: unknown }) {
  const items = rows.slice(0, limit), last = items.at(-1);
  return { items, nextCursor: rows.length > limit && last ? cursor(last) : null };
}
