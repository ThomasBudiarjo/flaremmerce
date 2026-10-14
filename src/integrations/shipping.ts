import type { IntegrationEnv } from './index';
import { demand, json, origin } from './security';
import { HttpError, digest, MAX_CART_LINES } from '../shared';

type Destination = {id:string; label:string; province:string; city:string; district:string; subdistrict:string; postalCode:string};
// Absent outside workerd (Node tests); search then simply goes to the provider.
const sharedCache = () => typeof caches === 'undefined' ? null : caches.default;
// Each search upserts what it returned so checkout and quotes can trust server-side destination data.
const remember = (env: IntegrationEnv, list: Destination[]) => list.length ? env.DB.batch(list.map(d => env.DB.prepare('INSERT INTO shipping_destinations(id,label,province,city,district,subdistrict,postal_code,updated_at) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET label=excluded.label,province=excluded.province,city=excluded.city,district=excluded.district,subdistrict=excluded.subdistrict,postal_code=excluded.postal_code,updated_at=excluded.updated_at WHERE label<>excluded.label OR postal_code<>excluded.postal_code OR city<>excluded.city OR district<>excluded.district OR subdistrict<>excluded.subdistrict OR province<>excluded.province').bind(d.id,d.label,d.province,d.city,d.district,d.subdistrict,d.postalCode,Date.now()))) : Promise.resolve();

export async function destinations(request: Request, env: IntegrationEnv) {
  demand(request.method === 'POST', 405, 'Method not allowed'); origin(request, env);
  const input = await json(request);
  demand(input && typeof input.search === 'string');
  const search = input.search.trim().toLowerCase().replace(/\s+/g, ' ');
  demand(search.length >= 3 && search.length <= 100 && /^[\p{L}\p{N}\s.,'()-]+$/u.test(search) && /[\p{L}\p{N}]/u.test(search), 400, 'Enter a region or postal code (3–100 characters)');
  demand(env.RAJAONGKIR_API_KEY, 503, 'Shipping unavailable');
  // Internal key only: the client response stays private/no-store, the cached copy never leaves the Worker.
  const cache = sharedCache(), key = new Request(`${new URL(env.PUBLIC_ORIGIN).origin}/__internal/shipping-destinations?q=${encodeURIComponent(search)}`);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) {
    const cached = await hit.json() as {destinations:Destination[]};
    await remember(env, cached.destinations);
    return cached;
  }
  const result = await searchProvider(env, search);
  await remember(env, result.destinations);
  await cache?.put(key, Response.json(result, {headers:{'Cache-Control':`public, max-age=${result.destinations.length ? 86400 : 3600}`}})).catch(() => {});
  return result;
}

async function searchProvider(env: IntegrationEnv, search: string): Promise<{destinations:Destination[]}> {
  demand(env.RAJAONGKIR_API_KEY, 503, 'Shipping unavailable');
  const url = new URL('https://rajaongkir.komerce.id/api/v1/destination/domestic-destination');
  url.search = new URLSearchParams({search, limit:'20', offset:'0'}).toString();
  let response: Response, result: any;
  try {
    response = await fetch(url.toString(), {headers:{key:env.RAJAONGKIR_API_KEY}, signal:AbortSignal.timeout(10000)});
    result = await response.json();
  } catch { throw new HttpError(502, 'Destination search unavailable'); }
  if ((response.ok || response.status === 404) && result?.meta?.code === 404 && result.meta.status === 'error' && result.data === null) return {destinations:[]};
  demand(response.ok, 502, 'Destination search unavailable');
  demand(result?.meta?.code === 200 && result.meta.status === 'success' && Array.isArray(result.data) && result.data.length <= 20, 502, 'Invalid destination response');
  const seen = new Set<string>();
  return {destinations:result.data.map((entry: any) => {
    demand(entry && (typeof entry.id === 'number' || typeof entry.id === 'string') && /^[1-9]\d{0,9}$/.test(String(entry.id)), 502, 'Invalid destination response');
    const id = String(entry.id);
    demand(!seen.has(id), 502, 'Invalid destination response'); seen.add(id);
    for (const field of ['label','province_name','city_name','district_name','subdistrict_name','zip_code']) {
      demand(typeof entry[field] === 'string' && entry[field].trim().length > 0 && entry[field].length <= 500, 502, 'Invalid destination response');
    }
    return {id, label:entry.label, province:entry.province_name, city:entry.city_name, district:entry.district_name, subdistrict:entry.subdistrict_name, postalCode:entry.zip_code};
  })};
}

export async function shipping(request: Request, env: IntegrationEnv) {
  demand(request.method === 'POST', 405, 'Method not allowed'); origin(request, env);
  demand(env.RAJAONGKIR_API_KEY && env.RAJAONGKIR_ORIGIN && env.RAJAONGKIR_COURIERS, 503, 'Shipping unavailable');
  const input = await json(request);
  const destination = String(input.destination);
  demand(/^[1-9]\d{0,9}$/.test(destination) && Array.isArray(input.items) && input.items.length > 0 && input.items.length <= MAX_CART_LINES);
  const items = new Map<string, number>();
  for (const item of input.items) {
    demand(typeof item.variantId === 'string' && item.variantId.length > 0 && item.variantId.length <= 128 && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 100);
    const count = (items.get(item.variantId) || 0) + item.quantity; demand(count <= 100); items.set(item.variantId,count);
  }
  // Only destinations a search returned are quotable; checkout snapshots the address from the same row.
  demand(await env.DB.prepare('SELECT 1 AS known FROM shipping_destinations WHERE id=?').bind(destination).first('known'), 400, 'Pilih wilayah tujuan dari hasil pencarian');
  // At most 30 distinct IDs: one query stays below D1's 100-bind limit.
  const ids = [...items.keys()];
  const {results} = await env.DB.prepare(`SELECT id,weight FROM product_variants WHERE id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all<{id:string;weight:number}>();
  const weights = new Map(results.map(row => [row.id, row.weight]));
  let weight = 0;
  for (const [id,quantity] of items) {
    const grams = weights.get(id);
    demand(grams !== undefined && Number.isSafeInteger(grams) && grams > 0, 400, 'Invalid shipping item');
    weight += grams * quantity;
  }
  demand(Number.isSafeInteger(weight) && weight > 0 && weight <= 1000000);
  const fingerprint = await digest(JSON.stringify({origin:env.RAJAONGKIR_ORIGIN,destination,weight,items:[...items].sort(([a],[b])=>a.localeCompare(b))}));
  // Reuse unexpired tariffs for the same cart and destination instead of calling the provider again.
  // Two minutes of remaining validity leaves time to complete checkout with a reused quote.
  const reusable = await env.DB.prepare('SELECT id,service,amount,expires_at AS expiresAt FROM shipping_quotes WHERE fingerprint=? AND expires_at>? AND destination=? AND weight=? ORDER BY amount,id LIMIT 10').bind(fingerprint, Date.now() + 120000, destination, weight).all<{id:string;service:string;amount:number;expiresAt:number}>();
  // Concurrent first quotes may both persist; offer each service once.
  if (reusable.results.length) return {quotes:reusable.results.filter((q, i, all) => all.findIndex(o => o.service === q.service) === i)};
  const response = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
    method:'POST', headers:{key:env.RAJAONGKIR_API_KEY, 'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({origin:env.RAJAONGKIR_ORIGIN, destination, weight:String(weight), courier:env.RAJAONGKIR_COURIERS, price:'lowest'}), signal:AbortSignal.timeout(10000),
  });
  demand(response.ok, 502, 'Shipping provider unavailable');
  const result: any = await response.json();
  demand(result.meta?.code === 200 && result.meta?.status === 'success' && Array.isArray(result.data) && result.data.length <= 100, 502, 'Invalid shipping response');
  const expiresAt = Date.now() + 300000;
  const quotes = result.data.map((entry: any) => {
    demand(typeof entry.code === 'string' && typeof entry.service === 'string' && Number.isSafeInteger(entry.cost) && entry.cost > 0, 502, 'Invalid shipping tariff');
    return {id:crypto.randomUUID(), service:`${entry.code}:${entry.service}`, amount:entry.cost as number, expiresAt, details:JSON.stringify(entry)};
  }).sort((a: {amount:number}, b: {amount:number}) => a.amount - b.amount).slice(0, 10);
  if (quotes.length) await env.DB.batch(quotes.map((q: {id:string;service:string;amount:number;details:string}) => env.DB.prepare('INSERT INTO shipping_quotes (id, fingerprint, destination, service, amount, weight, expires_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(q.id,fingerprint,destination,q.service,q.amount,weight,expiresAt,q.details)));
  return {quotes:quotes.map(({details, ...q}: {details:string;id:string;service:string;amount:number;expiresAt:number}) => q)};
}
