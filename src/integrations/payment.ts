import type { IntegrationEnv } from './index';
import { body, demand, digest, encode, base64, equal } from './security';

async function signature(raw: string, client: string, id: string, timestamp: string, path: string, secret: string) {
  const data = `Client-Id:${client}\nRequest-Id:${id}\nRequest-Timestamp:${timestamp}\nRequest-Target:${path}\nDigest:${await digest(raw)}`;
  const key = await crypto.subtle.importKey('raw', encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return `HMACSHA256=${base64(await crypto.subtle.sign('HMAC', key, encode(data)))}`;
}
function credentials(env: IntegrationEnv) {
  demand(env.DOKU_CLIENT_ID && env.DOKU_SECRET_KEY, 503, 'Payment unavailable');
  return {client:env.DOKU_CLIENT_ID, secret:env.DOKU_SECRET_KEY};
}
export async function createPayment(input: {reference:string; amount:number; returnUrl:string}, env: IntegrationEnv): Promise<{url:string; providerId?:string}> {
  const {client,secret} = credentials(env);
  demand(/^[A-Za-z0-9-]{1,30}$/.test(input.reference) && Number.isSafeInteger(input.amount) && input.amount > 0 && input.amount <= 999999999999);
  const callback = new URL(input.returnUrl);
  demand(callback.origin === new URL(env.PUBLIC_ORIGIN).origin && callback.protocol === 'https:');
  const path = '/checkout/v1/payment', id = input.reference, timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const raw = JSON.stringify({order:{invoice_number:input.reference, amount:input.amount, currency:'IDR', callback_url:callback.href, disable_retry_payment:true}, payment:{payment_due_date:60, type:'SALE'}});
  const response = await fetch(`${env.DOKU_MODE === 'production' ? 'https://api.doku.com' : 'https://api-sandbox.doku.com'}${path}`, {
    method:'POST', headers:{'Content-Type':'application/json', 'Client-Id':client, 'Request-Id':id, 'Request-Timestamp':timestamp, Signature:await signature(raw,client,id,timestamp,path,secret)}, body:raw, signal:AbortSignal.timeout(15000),
  });
  demand(response.ok, 502, 'Payment provider rejected request');
  const result: any = await response.json();
  demand(typeof result.response?.payment?.url === 'string', 502, 'Invalid payment response');
  demand(result.response.order?.invoice_number === input.reference && result.response.order?.amount === input.amount && (!result.response.order.currency || result.response.order.currency === 'IDR'), 502, 'Payment identity mismatch');
  const url = new URL(result.response.payment.url);
  demand(url.protocol === 'https:', 502, 'Invalid payment URL');
  return {url:url.href, ...(typeof result.response.uuid === 'string' ? {providerId:result.response.uuid}: {})};
}
export async function verifyPaymentWebhook(request: Request, env: IntegrationEnv): Promise<{eventKey:string; reference:string; amount:number; currency:string; status:'succeeded'|'failed'|'expired'}> {
  const {client,secret} = credentials(env);
  demand(request.method === 'POST', 405, 'Method not allowed');
  const id = request.headers.get('Request-Id'), timestamp = request.headers.get('Request-Timestamp'), supplied = request.headers.get('Signature');
  demand(request.headers.get('Client-Id') === client && id && id.length <= 128 && timestamp && timestamp.length <= 64 && Number.isFinite(Date.parse(timestamp)) && supplied, 401, 'Invalid payment signature');
  const raw = await body(request, 65536);
  const expected = await signature(raw,client,id,timestamp,new URL(request.url).pathname,secret);
  demand(await equal(supplied,expected), 401, 'Invalid payment signature');
  let event: any; try { event = JSON.parse(raw); } catch { demand(false); }
  demand(event && typeof event === 'object');
  demand(typeof event.order?.amount === 'number' || (typeof event.order?.amount === 'string' && /^\d+(\.0+)?$/.test(event.order.amount)));
  const reference = event.order?.invoice_number, amount = Number(event.order?.amount);
  demand(typeof reference === 'string' && /^[A-Za-z0-9-]{1,30}$/.test(reference) && Number.isSafeInteger(amount) && amount > 0);
  demand(!event.order.currency || event.order.currency === 'IDR');
  // Reject authorization, capture, refund, void and undocumented expiry payloads.
  demand(!event.transaction?.type || event.transaction.type === 'SALE', 422, 'Unsupported payment event');
  const status = event.transaction?.status;
  // DOKU explicitly says Checkout merchants must ignore FAILED: another method can succeed.
  demand(status === 'SUCCESS', 422, 'Unsupported payment status');
  if (event.transaction.original_request_id) demand(event.transaction.original_request_id === reference, 422, 'Payment identity mismatch');
  return {eventKey:`doku:${client}:${id}`, reference, amount, currency:'IDR', status:'succeeded'};
}
export async function lookupPayment(_reference: string, _env: IntegrationEnv): Promise<{status:'pending'|'succeeded'|'failed'|'expired'|'unknown'; amount?:number; currency?:string}> {
  // No verified product-specific lookup contract: NEVER infer expiry from local time.
  return {status:'unknown'};
}
