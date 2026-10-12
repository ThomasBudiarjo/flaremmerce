import type { IntegrationEnv } from '../integrations/index';

export interface CommerceEnv extends IntegrationEnv {
  DB: D1Database;
  ASSETS: Fetcher;
  JOBS?: Queue;
  PUBLIC_ORIGIN: string;
}
export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}
export const id = () => crypto.randomUUID();
export async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), b => b.toString(16).padStart(2, '0')).join('');
}
export const json = (data: unknown, status = 200, headers: HeadersInit = {}) =>
  Response.json(data, { status, headers: { 'Cache-Control': 'private, no-store', ...headers } });
export const statement = (env: CommerceEnv, sql: string, ...values: (string | number | null)[]) => env.DB.prepare(sql).bind(...values);
