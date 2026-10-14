import type { IntegrationEnv } from './index';
import { getCustomer } from './auth';
import { demand, json, origin } from './security';
import { normalizePhone } from '../shared';

export const MAX_ADDRESSES = 5;
export const addressPath = (path: string) => path === '/api/account/addresses' || path.startsWith('/api/account/addresses/');
const select = `SELECT a.id,a.label,a.name,a.phone,a.line,a.destination,d.label AS destinationLabel,d.city,d.postal_code AS postalCode,a.created_at AS createdAt,a.updated_at AS updatedAt
  FROM customer_addresses a JOIN shipping_destinations d ON d.id=a.destination`;
const text = (value: unknown, max: number) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max ? value.trim() : null;

type Fields = { label?: string; name?: string; phone?: string; line?: string; destination?: string };
async function fields(env: IntegrationEnv, input: any, partial: boolean): Promise<Fields> {
  demand(input && typeof input === 'object' && !Array.isArray(input));
  const allowed = ['label', 'name', 'phone', 'line', 'destination'];
  demand(Object.keys(input).every(key => allowed.includes(key)), 400, 'Unknown address field');
  const out: Fields = {};
  for (const [key, max] of [['label', 50], ['name', 200], ['line', 500]] as const) {
    if (input[key] === undefined && partial) continue;
    const value = text(input[key], max);
    demand(value, 400, `Invalid ${key}`); out[key] = value;
  }
  if (input.phone !== undefined || !partial) {
    const phone = typeof input.phone === 'string' ? normalizePhone(input.phone) : null;
    demand(phone, 400, 'Nomor HP tidak valid'); out.phone = phone;
  }
  if (input.destination !== undefined || !partial) {
    // Same rule as quotes and checkout: only a destination a search returned (server-side row) is accepted.
    demand(typeof input.destination === 'string' && /^[1-9]\d{0,9}$/.test(input.destination), 400, 'Invalid destination');
    demand(await env.DB.prepare('SELECT 1 AS known FROM shipping_destinations WHERE id=?').bind(input.destination).first('known'), 400, 'Pilih wilayah tujuan dari hasil pencarian');
    out.destination = input.destination;
  }
  demand(Object.keys(out).length > 0, 400, 'No changes');
  return out;
}

/** Signed-in customers only, freshly validated session; every statement is scoped to the caller's user id. */
export async function addresses(request: Request, env: IntegrationEnv): Promise<unknown> {
  const path = new URL(request.url).pathname, method = request.method;
  if (method !== 'GET') origin(request, env);
  const customer = await getCustomer(request, env);
  demand(customer, 401, 'Sign in required');
  const user = customer.id, item = path.match(/^\/api\/account\/addresses\/([a-f0-9-]{36})$/)?.[1];
  const list = async () => (await env.DB.prepare(`${select} WHERE a.user_id=? ORDER BY a.created_at,a.id LIMIT ${MAX_ADDRESSES}`).bind(user).all()).results;
  if (path === '/api/account/addresses' && method === 'GET') return { addresses: await list(), max: MAX_ADDRESSES };
  if (path === '/api/account/addresses' && method === 'POST') {
    const input = await fields(env, await json(request), false), id = crypto.randomUUID(), now = Date.now();
    demand(((await env.DB.prepare('SELECT count(*) AS n FROM customer_addresses WHERE user_id=?').bind(user).first<number>('n')) ?? 0) < MAX_ADDRESSES, 409, `Maksimal ${MAX_ADDRESSES} alamat tersimpan`);
    try {
      await env.DB.prepare('INSERT INTO customer_addresses(id,user_id,label,name,phone,line,destination,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)').bind(id, user, input.label, input.name, input.phone, input.line, input.destination, now, now).run();
    } catch (error) {
      demand(!/address_limit/.test(String(error)), 409, `Maksimal ${MAX_ADDRESSES} alamat tersimpan`);
      throw error;
    }
    return { address: await env.DB.prepare(`${select} WHERE a.id=? AND a.user_id=?`).bind(id, user).first() };
  }
  demand(item, 404, 'Address not found');
  if (method === 'PATCH') {
    const input = await fields(env, await json(request), true), entries = Object.entries(input);
    const result = await env.DB.prepare(`UPDATE customer_addresses SET ${entries.map(([key]) => `${key}=?`).join(',')},updated_at=? WHERE id=? AND user_id=?`).bind(...entries.map(([, value]) => value), Date.now(), item, user).run();
    demand(result.meta.changes === 1, 404, 'Address not found');
    return { address: await env.DB.prepare(`${select} WHERE a.id=? AND a.user_id=?`).bind(item, user).first() };
  }
  if (method === 'DELETE') {
    const result = await env.DB.prepare('DELETE FROM customer_addresses WHERE id=? AND user_id=?').bind(item, user).run();
    demand(result.meta.changes === 1, 404, 'Address not found');
    return { deleted: true };
  }
  demand(false, 405, 'Method not allowed');
}
