import { betterAuth } from 'better-auth';
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from './schema';
import type { IntegrationEnv } from './index';
import { demand, equal, json, origin } from './security';

export function auth(env: IntegrationEnv) {
  demand(env.BETTER_AUTH_SECRET && env.BETTER_AUTH_SECRET.length >= 32 && env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET, 503, 'Authentication unavailable');
  return betterAuth({
    secret:env.BETTER_AUTH_SECRET, baseURL:env.PUBLIC_ORIGIN, trustedOrigins:[env.PUBLIC_ORIGIN],
    database:drizzleAdapter(drizzle(env.DB, {schema}), {provider:'sqlite', schema, transaction:false}),
    emailAndPassword:{enabled:false},
    socialProviders:{google:{clientId:env.GOOGLE_CLIENT_ID, clientSecret:env.GOOGLE_CLIENT_SECRET}},
    account:{accountLinking:{enabled:false}},
    session:{cookieCache:{enabled:true, maxAge:60, strategy:'compact'}},
    advanced:{useSecureCookies:true},
  });
}
export async function getCustomer(request: Request, env: IntegrationEnv): Promise<{id:string}|null> {
  if (!request.headers.get('Cookie')) return null;
  const session = await auth(env).api.getSession({headers:request.headers});
  return session ? {id:session.user.id} : null;
}
async function fresh(request: Request, env: IntegrationEnv) {
  // The official option is disableCookieCache, not bypassCookieCache.
  const session = await auth(env).api.getSession({headers:request.headers, query:{disableCookieCache:true}});
  demand(session, 401, 'Authentication required'); return session;
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
