import { auth, setup, roles } from './auth';
import { shipping } from './shipping';
import { body, IntegrationError, origin } from './security';
export { requireAdmin, getCustomer } from './auth';
export { verifyTurnstile, IntegrationError } from './security';
export { createPayment, verifyPaymentWebhook, lookupPayment } from './payment';

export interface IntegrationEnv {
  DB: D1Database;
  PUBLIC_ORIGIN: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  BETTER_AUTH_SECRET?: string;
  BOOTSTRAP_SECRET?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_ACTION?: string;
  DOKU_CLIENT_ID?: string;
  DOKU_SECRET_KEY?: string;
  DOKU_MODE?: 'sandbox'|'production';
  RAJAONGKIR_API_KEY?: string;
  RAJAONGKIR_ORIGIN?: string;
  RAJAONGKIR_COURIERS?: string;
}
export async function handleIntegrationRequest(request: Request, env: IntegrationEnv): Promise<Response|null> {
  const path = new URL(request.url).pathname;
  if (!(path.startsWith('/api/auth/') || path === '/api/setup' || path === '/api/shipping/quote' || path === '/api/admin/roles')) return null;
  try {
    let response: Response;
    if (path.startsWith('/api/auth/')) {
      if (!['GET','HEAD'].includes(request.method)) {
        origin(request,env);
        const raw = await body(request); request = new Request(request, {body:raw});
      }
      response = await auth(env).handler(request);
    } else {
      const result = path === '/api/setup' ? await setup(request,env) : path === '/api/admin/roles' ? await roles(request,env) : await shipping(request,env);
      response = Response.json(result);
    }
    const headers = new Headers(response.headers); headers.set('Cache-Control','private, no-store');
    return new Response(response.body, {status:response.status, headers});
  } catch (error) {
    return Response.json({error:error instanceof IntegrationError ? error.message : 'Integration unavailable'}, {status:error instanceof IntegrationError ? error.status : 503, headers:{'Cache-Control':'private, no-store'}});
  }
}
