import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import type { IntegrationEnv } from './index';
import { demand, devLoginEnabled, equal, json, origin } from './security';
import { ADMIN_ROLES, type AdminRole, HttpError } from '../shared';
export { devLoginEnabled };
// One Better Auth instance per isolate and env binding object; construction is not free per request.
const instances = new WeakMap<IntegrationEnv, ReturnType<typeof createAuth>>();
export function auth(env: IntegrationEnv) {
  let instance = instances.get(env);
  if (!instance) { instance = createAuth(env); instances.set(env, instance); }
  return instance;
}
function createAuth(env: IntegrationEnv) {
  const development = devLoginEnabled(env);
  demand(env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32 && (development || (env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)), 503, 'Authentication unavailable');
  return betterAuth({
    secret:env.BETTER_AUTH_SECRET, baseURL:env.PUBLIC_ORIGIN, trustedOrigins:[env.PUBLIC_ORIGIN],
    database:drizzleAdapter(drizzle(env.DB, {schema}), {provider:'sqlite', schema, transaction:false}),
    emailAndPassword:{enabled:false},
    socialProviders:env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET ? {google:{clientId:env.GOOGLE_CLIENT_ID, clientSecret:env.GOOGLE_CLIENT_SECRET}} : {},
    plugins:development ? [{
      id:'development-login',
      endpoints:{developmentLogin:createAuthEndpoint('/development-login', {method:'POST'}, async ctx => {
        // Fixed local identity: callers cannot choose an email or impersonate a user.
        const adapter = ctx.context.internalAdapter;
        const existing = await adapter.findUserByEmail('admin@flaremmerce.test');
        const user = existing?.user ?? await adapter.createUser({id:'flaremmerce-dev-admin', email:'admin@flaremmerce.test', name:'Admin lokal', emailVerified:false}, {method:'development-login'});
        demand(user.id === 'flaremmerce-dev-admin', 409, 'Development identity conflict');
        // Never take over a previously initialized installation or restore a revoked role.
        await env.DB.batch([
          env.DB.prepare('INSERT INTO admin_roles (user_id, granted_by, created_at) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM installation)').bind(user.id, user.id, Date.now()),
          env.DB.prepare('INSERT INTO installation (id, owner_id, initialized_at) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING').bind(user.id, Date.now()),
        ]);
        demand(await env.DB.prepare('SELECT user_id FROM admin_roles WHERE user_id=?').bind(user.id).first(), 403, 'Development administrator unavailable');
        const session = await adapter.createSession(user.id, false);
        await setSessionCookie(ctx, {session, user}, false);
        return ctx.json({ok:true});
      })},
    }] : [],
    account:{accountLinking:{enabled:false}},
    session:{cookieCache:{enabled:true, maxAge:60, strategy:'compact'}},
    advanced:{useSecureCookies:!development || new URL(env.PUBLIC_ORIGIN).protocol === 'https:'},
  });
}
/** A banned customer is signed out for commerce unless the caller asks to see the ban (checkout refuses it). */
export async function getCustomer(request: Request, env: IntegrationEnv, options: {includeBanned?:boolean} = {}): Promise<{id:string; banned?:true}|null> {
  if (!/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get('Cookie') ?? '')) return null;
  // Commerce uses this identity for checkout and private order/PII authorization.
  const session = await auth(env).api.getSession({headers:request.headers, query:{disableCookieCache:true}});
  if (!session || (session.user.id === 'flaremmerce-dev-admin' && !devLoginEnabled(env))) return null;
  const banned = await env.DB.prepare('SELECT 1 AS banned FROM customer_bans WHERE user_id=?').bind(session.user.id).first('banned');
  if (banned) return options.includeBanned ? {id:session.user.id, banned:true} : null;
  return {id:session.user.id};
}
async function fresh(request: Request, env: IntegrationEnv) {
  // The official option is disableCookieCache, not bypassCookieCache.
  const session = await auth(env).api.getSession({headers:request.headers, query:{disableCookieCache:true}});
  demand(session && (session.user.id !== 'flaremmerce-dev-admin' || devLoginEnabled(env)), 401, 'Authentication required'); return session;
}
export async function requireAdmin(request: Request, env: IntegrationEnv): Promise<{id:string; role:AdminRole}> {
  const session = await fresh(request, env);
  const role = await env.DB.prepare('SELECT role FROM admin_roles WHERE user_id = ?').bind(session.user.id).first<AdminRole>('role');
  demand(role && ADMIN_ROLES.includes(role), 403, 'Administrator required'); return {id:session.user.id, role};
}
export async function setup(request: Request, env: IntegrationEnv) {
  const installed = await env.DB.prepare('SELECT owner_id FROM installation WHERE id = 1').first();
  if (request.method === 'GET') return {initialized:!!installed};
  demand(request.method === 'POST', 405, 'Method not allowed'); origin(request, env);
  demand(!installed, 409, 'Already initialized');
  demand(env.BOOTSTRAP_SECRET && env.BOOTSTRAP_SECRET.length >= 32, 503, 'Setup unavailable');
  const input = await json(request);
  demand(typeof input.secret === 'string' && input.secret.length <= 1024 && await equal(input.secret, env.BOOTSTRAP_SECRET), 403, 'Setup rejected');
  const session = await fresh(request, env);
  const google = await env.DB.prepare("SELECT id FROM account WHERE user_id = ? AND provider_id = 'google'").bind(session.user.id).first();
  demand(session.user.emailVerified && google, 403, 'Verified Google identity required');
  // D1 batch is atomic. The singleton constraint fails the entire losing batch.
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT INTO installation (id, owner_id, initialized_at) VALUES (1, ?, ?)').bind(session.user.id, Date.now()),
      env.DB.prepare('INSERT INTO admin_roles (user_id, granted_by, created_at) VALUES (?, ?, ?)').bind(session.user.id, session.user.id, Date.now()),
    ]);
  } catch (error) {
    if (/UNIQUE constraint failed|PRIMARY KEY/.test(String(error))) throw new HttpError(409, 'Already initialized');
    throw error;
  }
  return {initialized:true};
}
