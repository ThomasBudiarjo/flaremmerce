import { betterAuth } from 'better-auth';
import { createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import type { IntegrationEnv } from './index';
import { demand, equal, json, origin } from './security';

export function devLoginEnabled(env: IntegrationEnv) {
  return env.APP_ENV === 'development' && env.DEV_LOGIN_ENABLED === 'true';
}
export function auth(env: IntegrationEnv) {
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
export async function getCustomer(request: Request, env: IntegrationEnv): Promise<{id:string}|null> {
  if (!/(?:^|;\s*)(?:__Secure-)?better-auth\.session_token=/.test(request.headers.get('Cookie') ?? '')) return null;
  // Commerce uses this identity for checkout and private order/PII authorization.
  const session = await auth(env).api.getSession({headers:request.headers, query:{disableCookieCache:true}});
  if (session?.user.id === 'flaremmerce-dev-admin' && !devLoginEnabled(env)) return null;
  return session ? {id:session.user.id} : null;
}
async function fresh(request: Request, env: IntegrationEnv) {
  // The official option is disableCookieCache, not bypassCookieCache.
  const session = await auth(env).api.getSession({headers:request.headers, query:{disableCookieCache:true}});
  demand(session && (session.user.id !== 'flaremmerce-dev-admin' || devLoginEnabled(env)), 401, 'Authentication required'); return session;
}
export async function requireAdmin(request: Request, env: IntegrationEnv): Promise<{id:string}> {
  const session = await fresh(request, env);
  const role = await env.DB.prepare('SELECT user_id FROM admin_roles WHERE user_id = ?').bind(session.user.id).first();
  demand(role, 403, 'Administrator required'); return {id:session.user.id};
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
  await env.DB.batch([
    env.DB.prepare('INSERT INTO installation (id, owner_id, initialized_at) VALUES (1, ?, ?)').bind(session.user.id, Date.now()),
    env.DB.prepare('INSERT INTO admin_roles (user_id, granted_by, created_at) VALUES (?, ?, ?)').bind(session.user.id, session.user.id, Date.now()),
  ]);
  return {initialized:true};
}
export async function roles(request: Request, env: IntegrationEnv) {
  demand(request.method === 'POST', 405, 'Method not allowed'); origin(request, env);
  const actor = await requireAdmin(request, env), input = await json(request);
  demand(typeof input.userId === 'string' && input.userId.length <= 128 && typeof input.admin === 'boolean');
  demand(input.userId !== actor.id, 409, 'Cannot change own role');
  const target = await env.DB.prepare("SELECT u.id FROM user u JOIN account a ON a.user_id=u.id WHERE u.id=? AND u.email_verified=1 AND a.provider_id='google'").bind(input.userId).first();
  demand(target, 400, 'Verified Google identity required');
  await env.DB.batch([
    input.admin ? env.DB.prepare('INSERT INTO admin_roles (user_id, granted_by, created_at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO NOTHING').bind(input.userId, actor.id, Date.now()) : env.DB.prepare('DELETE FROM admin_roles WHERE user_id=? AND user_id NOT IN (SELECT owner_id FROM installation)').bind(input.userId),
    env.DB.prepare('INSERT INTO integration_role_audit (id, actor_id, target_id, admin, created_at) VALUES (?, ?, ?, ?, ?)').bind(crypto.randomUUID(), actor.id, input.userId, input.admin ? 1:0, Date.now()),
  ]);
  return {ok:true};
}
