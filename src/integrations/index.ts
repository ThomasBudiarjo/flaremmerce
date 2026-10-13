import { auth, setup, roles } from './auth';
import { shipping } from './shipping';
import { body, IntegrationError, origin } from './security';
export { requireAdmin, getCustomer } from './auth';
export { verifyTurnstile, IntegrationError } from './security';
export { createPayment, verifyPaymentWebhook, lookupPayment } from './payment';

export interface IntegrationEnv {
  DB: D1Database;
  PUBLIC_ORIGIN: string;
  APP_ENV?: string;
  DEV_LOGIN_ENABLED?: string;
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
        const raw = await body(request);
        const headers = new Headers(request.headers);
        // After our exact-origin guard, restore the canonical origin for Better Auth.
        headers.set('Origin', new URL(env.PUBLIC_ORIGIN).origin);
        request = new Request(request, {body:raw, headers});
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
