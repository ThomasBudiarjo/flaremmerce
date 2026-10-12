import type { IntegrationEnv } from './index';
import { demand, digest, json, origin } from './security';

export async function shipping(request: Request, env: IntegrationEnv) {
  demand(request.method === 'POST', 405, 'Method not allowed'); origin(request, env);
  demand(env.RAJAONGKIR_API_KEY && env.RAJAONGKIR_ORIGIN && env.RAJAONGKIR_COURIERS, 503, 'Shipping unavailable');
  const input = await json(request);
  const destination = String(input.destination);
  demand(/^[1-9]\d{0,9}$/.test(destination) && Array.isArray(input.items) && input.items.length > 0 && input.items.length <= 50);
  const items = new Map<string, number>();
  for (const item of input.items) {
    demand(typeof item.variantId === 'string' && item.variantId.length > 0 && item.variantId.length <= 128 && Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 100);
    const count = (items.get(item.variantId) || 0) + item.quantity; demand(count <= 100); items.set(item.variantId,count);
  }
  let weight = 0;
  for (const [id,quantity] of items) {
    const variant = await env.DB.prepare('SELECT weight FROM product_variants WHERE id = ?').bind(id).first<{weight:number}>();
    demand(variant && Number.isSafeInteger(variant.weight) && variant.weight > 0, 400, 'Invalid shipping item');
    weight += variant.weight * quantity;
  }
  demand(Number.isSafeInteger(weight) && weight > 0 && weight <= 1000000);
  const response = await fetch('https://rajaongkir.komerce.id/api/v1/calculate/domestic-cost', {
    method:'POST', headers:{key:env.RAJAONGKIR_API_KEY, 'Content-Type':'application/x-www-form-urlencoded'},
    body:new URLSearchParams({origin:env.RAJAONGKIR_ORIGIN, destination, weight:String(weight), courier:env.RAJAONGKIR_COURIERS, price:'lowest'}), signal:AbortSignal.timeout(10000),
  });
  demand(response.ok, 502, 'Shipping provider unavailable');
  const result: any = await response.json();
  demand(result.meta?.code === 200 && result.meta?.status === 'success' && Array.isArray(result.data) && result.data.length <= 100, 502, 'Invalid shipping response');
  const fingerprint = await digest(JSON.stringify({origin:env.RAJAONGKIR_ORIGIN,destination,weight,items:[...items].sort(([a],[b])=>a.localeCompare(b))}));
  const expiresAt = Date.now() + 300000;
  const quotes = result.data.map((entry: any) => {
    demand(typeof entry.code === 'string' && typeof entry.service === 'string' && Number.isSafeInteger(entry.cost) && entry.cost > 0, 502, 'Invalid shipping tariff');
    return {id:crypto.randomUUID(), service:`${entry.code}:${entry.service}`, amount:entry.cost as number, expiresAt, details:JSON.stringify(entry)};
  });
  if (quotes.length) await env.DB.batch(quotes.map((q: {id:string;service:string;amount:number;details:string}) => env.DB.prepare('INSERT INTO shipping_quotes (id, fingerprint, destination, service, amount, weight, expires_at, details_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(q.id,fingerprint,destination,q.service,q.amount,weight,expiresAt,q.details)));
  return {quotes:quotes.map(({details, ...q}: {details:string;id:string;service:string;amount:number;expiresAt:number}) => q)};
}
