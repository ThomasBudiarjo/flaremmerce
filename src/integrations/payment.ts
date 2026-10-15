import type { IntegrationEnv } from './index';
import { body, demand, equal } from './security';
import { base64, digest, encode, envMinutes, PAYMENT_CREATE_TIMEOUT_MS, PAYMENT_DUE_MINUTES } from '../shared';

async function signature(raw: string | null, client: string, id: string, timestamp: string, path: string, secret: string) {
  const data = `Client-Id:${client}\nRequest-Id:${id}\nRequest-Timestamp:${timestamp}\nRequest-Target:${path}${raw === null ? '' : `\nDigest:${await digest(raw)}`}`;
  const key = await crypto.subtle.importKey('raw', encode(secret), {name:'HMAC', hash:'SHA-256'}, false, ['sign']);
  return `HMACSHA256=${base64(await crypto.subtle.sign('HMAC', key, encode(data)))}`;
}
function credentials(env: IntegrationEnv) {
  demand(env.DOKU_CLIENT_ID && env.DOKU_SECRET_KEY, 503, 'Payment unavailable');
  return {client:env.DOKU_CLIENT_ID, secret:env.DOKU_SECRET_KEY};
}
// Same payment seen via webhook and status lookup: DOKU reports channel and transaction date on both.
// Dates are compared as instants so representation differences cannot fork the identity.
function transactionIdentity(event: any): string | undefined {
  const channel = event?.channel?.id, date = event?.transaction?.date;
  if (typeof channel !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(channel) || typeof date !== 'string' || date.length > 64) return undefined;
  const instant = Date.parse(date);
  return Number.isFinite(instant) ? `${channel}@${instant}` : undefined;
}
export async function createPayment(input: {reference:string; amount:number; returnUrl:string}, env: IntegrationEnv): Promise<{url:string; providerId?:string} | {rejected:true}> {
  const {client,secret} = credentials(env);
  demand(/^[A-Za-z0-9-]{1,30}$/.test(input.reference) && Number.isSafeInteger(input.amount) && input.amount > 0 && input.amount <= 999999999999);
  const callback = new URL(input.returnUrl);
  demand(callback.origin === new URL(env.PUBLIC_ORIGIN).origin && callback.protocol === 'https:');
  const path = '/checkout/v1/payment', id = input.reference, timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const raw = JSON.stringify({order:{invoice_number:input.reference, amount:input.amount, currency:'IDR', callback_url:callback.href, disable_retry_payment:true}, payment:{payment_due_date:PAYMENT_DUE_MINUTES, type:'SALE'}});
  const response = await fetch(`${env.DOKU_MODE === 'production' ? 'https://api.doku.com' : 'https://api-sandbox.doku.com'}${path}`, {
    method:'POST', headers:{'Content-Type':'application/json', 'Client-Id':client, 'Request-Id':id, 'Request-Timestamp':timestamp, Signature:await signature(raw,client,id,timestamp,path,secret)}, body:raw, signal:AbortSignal.timeout(PAYMENT_CREATE_TIMEOUT_MS),
  });
  // A 4xx is a definite refusal: no payment page exists. Timeout/conflict/rate-limit replies may
  // follow or race an accepted request, so they stay ambiguous like 5xx and network failures.
  if (response.status >= 400 && response.status < 500 && ![408,409,425,429].includes(response.status)) return {rejected:true};
  demand(response.ok, 502, 'Payment provider rejected request');
  const result: any = await response.json();
  demand(typeof result.response?.payment?.url === 'string', 502, 'Invalid payment response');
  demand(result.response.order?.invoice_number === input.reference && result.response.order?.amount === input.amount && (!result.response.order.currency || result.response.order.currency === 'IDR'), 502, 'Payment identity mismatch');
  const url = new URL(result.response.payment.url);
  demand(url.protocol === 'https:', 502, 'Invalid payment URL');
  return {url:url.href, ...(typeof result.response.uuid === 'string' ? {providerId:result.response.uuid}: {})};
}
export type WebhookEvent = {eventKey:string; reference:string; amount:number; currency:string; status:'succeeded'|'ignored'|'provider_event'; providerTx?:string; kind?:string};
export async function verifyPaymentWebhook(request: Request, env: IntegrationEnv): Promise<WebhookEvent> {
  const {client,secret} = credentials(env);
  demand(request.method === 'POST', 405, 'Method not allowed');
  const id = request.headers.get('Request-Id'), timestamp = request.headers.get('Request-Timestamp'), supplied = request.headers.get('Signature');
  demand(request.headers.get('Client-Id') === client && id && id.length <= 128 && timestamp && timestamp.length <= 64 && Number.isFinite(Date.parse(timestamp)) && supplied, 401, 'Invalid payment signature');
  // Bounds replay of a captured signed notification; dedup still relies on Request-Id.
  demand(Math.abs(Date.now() - Date.parse(timestamp)) <= envMinutes(env.WEBHOOK_MAX_SKEW_MIN, 15, 1440) * 60_000, 401, 'Invalid payment signature');
  const raw = await body(request, 65536);
  const expected = await signature(raw,client,id,timestamp,new URL(request.url).pathname,secret);
  demand(await equal(supplied,expected), 401, 'Invalid payment signature');
  let event: any; try { event = JSON.parse(raw); } catch { demand(false); }
  demand(event && typeof event === 'object');
  const reference = event.order?.invoice_number, eventKey = `doku:${client}:${id}`;
  demand(typeof reference === 'string' && /^[A-Za-z0-9-]{1,30}$/.test(reference));
  const type = event.transaction?.type, status = event.transaction?.status;
  // Authenticated refund/chargeback/void/capture or undocumented statuses are evidence for an operator, never a
  // state change: acknowledged so DOKU stops retrying. Only a sanitized type:status label is kept, no payload.
  if ((type && type !== 'SALE') || (status !== 'SUCCESS' && status !== 'FAILED')) {
    const label = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(value) ? value.toUpperCase() : 'UNKNOWN';
    const amount = Number(event.order?.amount);
    return {eventKey, reference, amount:Number.isSafeInteger(amount) && amount > 0 ? amount : 0, currency:'IDR', status:'provider_event', kind:`${label(type ?? 'SALE')}:${label(status)}`};
  }
  demand(typeof event.order?.amount === 'number' || (typeof event.order?.amount === 'string' && /^\d+(\.0+)?$/.test(event.order.amount)));
  const amount = Number(event.order?.amount);
  demand(Number.isSafeInteger(amount) && amount > 0);
  demand(!event.order.currency || event.order.currency === 'IDR');
  // DOKU explicitly says Checkout merchants must ignore FAILED: another method can succeed.
  if (event.transaction.original_request_id) demand(event.transaction.original_request_id === reference, 422, 'Payment identity mismatch');
  const providerTx = transactionIdentity(event);
  return {eventKey, reference, amount, currency:'IDR', status:status === 'SUCCESS' ? 'succeeded' : 'ignored', ...(providerTx ? {providerTx} : {})};
}
// `not_found` (HTTP 404): DOKU holds no invoice under this reference. Commerce decides what that means for an attempt.
export type LookupResult = {status:'succeeded'|'not_paid'; amount:number; currency:string; providerTx?:string} | {status:'unknown'|'not_found'};
export async function lookupPayment(reference: string, env: IntegrationEnv): Promise<LookupResult> {
  const {client,secret} = credentials(env);
  demand(/^[A-Za-z0-9-]{1,30}$/.test(reference));
  const path = `/orders/v1/status/${reference}`, id = crypto.randomUUID(), timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
  const response = await fetch(`${env.DOKU_MODE === 'production' ? 'https://api.doku.com' : 'https://api-sandbox.doku.com'}${path}`, {
    headers:{'Client-Id':client,'Request-Id':id,'Request-Timestamp':timestamp,Signature:await signature(null,client,id,timestamp,path,secret)}, signal:AbortSignal.timeout(10000),
  });
  if (response.status === 404) return {status:'not_found'};
  if (!response.ok) return {status:'unknown'};
  const result: any = await response.json();
  const amount = Number(result.order?.amount);
  if (result.order?.invoice_number !== reference || !Number.isSafeInteger(amount) || amount <= 0 || (result.order.currency && result.order.currency !== 'IDR') || (result.transaction?.type && result.transaction.type !== 'SALE')) return {status:'unknown'};
  const providerTx = transactionIdentity(result);
  if (result.transaction?.status === 'SUCCESS') return {status:'succeeded',amount,currency:'IDR',...(providerTx ? {providerTx} : {})};
  // Authoritative "not paid right now". Only commerce decides, after the Checkout due date plus
  // grace, whether that becomes a terminal expiry; before it the attempt simply stays pending.
  if (['PENDING','FAILED','TIMEOUT','REDIRECT','EXPIRED'].includes(result.transaction?.status)) return {status:'not_paid',amount,currency:'IDR'};
  return {status:'unknown'};
}
