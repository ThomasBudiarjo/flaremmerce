import type { IntegrationEnv } from './index';
import { requireAdmin } from './auth';
import { demand, json, origin } from './security';
import { ADMIN_ROLES, type AdminRole, adminPermits } from '../shared';

const audit = (env: IntegrationEnv, actor: string, action: string, target: string, details: unknown, when = 'WHERE changes()=1') =>
  env.DB.prepare(`INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) SELECT ?,?,?,?,?,? ${when}`).bind(crypto.randomUUID(), actor, action, target, JSON.stringify(details), Date.now());
function cursor(url: URL) {
  const before = Number(url.searchParams.get('before') ?? Number.MAX_SAFE_INTEGER), beforeId = url.searchParams.get('beforeId') ?? '';
  const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') ?? 50)));
  demand(Number.isSafeInteger(before) && Number.isSafeInteger(limit) && beforeId.length <= 200, 400, 'Invalid pagination');
  return { before, beforeId: url.searchParams.has('beforeId') ? beforeId : '\uffff', limit };
}
// Cannot leave the installation without an owner: the guard is part of the single write statement.
const otherOwner = "EXISTS(SELECT 1 FROM admin_roles o WHERE o.role='owner' AND o.user_id<>admin_roles.user_id)";

export const adminUserPaths = (path: string) => path === '/api/admin/me' || path === '/api/admin/roles' || path.startsWith('/api/admin/roles/') || path === '/api/admin/customers' || path.startsWith('/api/admin/users/');

export async function adminUsers(request: Request, env: IntegrationEnv): Promise<unknown> {
  const url = new URL(request.url), path = url.pathname, method = request.method;
  if (method !== 'GET' && method !== 'HEAD') origin(request, env);
  const actor = await requireAdmin(request, env);
  demand(adminPermits(actor.role, path), 403, 'Role not permitted');
  if (path === '/api/admin/me' && method === 'GET') {
    const user = await env.DB.prepare('SELECT id,name,email FROM user WHERE id=?').bind(actor.id).first();
    return { user, role: actor.role, areas: actor.role === 'owner' ? ['owner', 'ops', 'catalog'] : [actor.role] };
  }
  if (path === '/api/admin/roles' && method === 'GET') {
    const { results } = await env.DB.prepare('SELECT r.user_id AS userId,u.name,u.email,r.role,r.granted_by AS grantedBy,r.created_at AS createdAt,r.user_id IN (SELECT owner_id FROM installation) AS installationOwner FROM admin_roles r JOIN user u ON u.id=r.user_id ORDER BY r.created_at,r.user_id LIMIT 200').all();
    return { admins: results.map(row => ({ ...row, installationOwner: !!row.installationOwner })) };
  }
  if (path === '/api/admin/roles' && method === 'POST') {
    const input = await json(request);
    demand(input && typeof input.userId === 'string' && input.userId.length > 0 && input.userId.length <= 128 && ADMIN_ROLES.includes(input.role));
    const role: AdminRole = input.role;
    const current = await env.DB.prepare('SELECT role FROM admin_roles WHERE user_id=?').bind(input.userId).first<AdminRole>('role');
    if (current === role) return { ok: true, changed: false };
    if (current) {
      const [result] = await env.DB.batch([
        env.DB.prepare(`UPDATE admin_roles SET role=? WHERE user_id=? AND role=? AND (role<>'owner' OR ${otherOwner})`).bind(role, input.userId, current),
        audit(env, actor.id, 'role.change', input.userId, { fromRole: current, role }),
      ]);
      demand(result.meta.changes === 1, 409, 'The last owner cannot be demoted');
      return { ok: true, changed: true };
    }
    const target = await env.DB.prepare("SELECT u.id FROM user u JOIN account a ON a.user_id=u.id WHERE u.id=? AND u.email_verified=1 AND a.provider_id='google' AND u.id NOT IN (SELECT user_id FROM customer_bans)").bind(input.userId).first();
    demand(target, 400, 'Verified Google identity required');
    const [, audited] = await env.DB.batch([
      env.DB.prepare('INSERT INTO admin_roles(user_id,granted_by,created_at,role) VALUES(?,?,?,?) ON CONFLICT(user_id) DO NOTHING').bind(input.userId, actor.id, Date.now(), role),
      audit(env, actor.id, 'role.grant', input.userId, { role }),
    ]);
    return { ok: true, changed: audited.meta.changes === 1 };
  }
  const revoke = path.match(/^\/api\/admin\/roles\/([^/]+)$/);
  if (revoke && method === 'DELETE') {
    const target = decodeURIComponent(revoke[1]);
    const current = await env.DB.prepare('SELECT role FROM admin_roles WHERE user_id=?').bind(target).first<AdminRole>('role');
    if (!current) return { ok: true, changed: false };
    demand(!await env.DB.prepare('SELECT 1 AS owner FROM installation WHERE owner_id=?').bind(target).first('owner'), 409, 'The installation owner cannot be revoked');
    const [result] = await env.DB.batch([
      env.DB.prepare(`DELETE FROM admin_roles WHERE user_id=? AND user_id NOT IN (SELECT owner_id FROM installation) AND (role<>'owner' OR ${otherOwner})`).bind(target),
      audit(env, actor.id, 'role.revoke', target, { fromRole: current }),
    ]);
    demand(result.meta.changes === 1, 409, 'The last owner cannot be revoked');
    return { ok: true, changed: true };
  }
  if (path === '/api/admin/customers' && method === 'GET') {
    const { before, beforeId, limit } = cursor(url);
    const { results } = await env.DB.prepare(`SELECT u.id,u.name,u.email,u.created_at AS createdAt,(SELECT count(*) FROM orders o WHERE o.customer_id=u.id) AS orders,
      EXISTS(SELECT 1 FROM customer_bans b WHERE b.user_id=u.id) AS banned,EXISTS(SELECT 1 FROM admin_roles r WHERE r.user_id=u.id) AS admin
      FROM user u WHERE u.created_at<? OR (u.created_at=? AND u.id<?) ORDER BY u.created_at DESC,u.id DESC LIMIT ?`).bind(before, before, beforeId, limit + 1).all<Record<string, unknown> & { createdAt: number; id: string }>();
    const items = results.slice(0, limit), last = items.at(-1);
    return { customers: items.map(row => ({ ...row, banned: !!row.banned, admin: !!row.admin })), nextCursor: results.length > limit && last ? { before: last.createdAt, beforeId: last.id } : null };
  }
  const user = path.match(/^\/api\/admin\/users\/([^/]+)\/(revoke-sessions|ban)$/);
  if (user && method === 'POST') {
    const target = decodeURIComponent(user[1]);
    const row = await env.DB.prepare('SELECT u.id,r.role FROM user u LEFT JOIN admin_roles r ON r.user_id=u.id WHERE u.id=?').bind(target).first<{ id: string; role: AdminRole | null }>();
    demand(row, 404, 'User not found');
    if (user[2] === 'revoke-sessions') {
      // Signing an administrator out everywhere is an owner decision.
      demand(!row.role || actor.role === 'owner', 403, 'Role not permitted');
      const [deleted] = await env.DB.batch([
        env.DB.prepare('DELETE FROM session WHERE user_id=?').bind(target),
        audit(env, actor.id, 'user.revoke_sessions', target, {}, ''),
      ]);
      return { ok: true, revoked: deleted.meta.changes };
    }
    const input = await json(request);
    demand(input && typeof input.banned === 'boolean');
    demand(!row.role, 409, 'Administrators cannot be banned');
    const now = Date.now();
    const statements = input.banned ? [
      env.DB.prepare('INSERT INTO customer_bans(user_id,actor,created_at) SELECT ?,?,? WHERE NOT EXISTS(SELECT 1 FROM admin_roles WHERE user_id=?) ON CONFLICT(user_id) DO NOTHING').bind(target, actor.id, now, target),
      audit(env, actor.id, 'user.ban', target, { banned: true }),
      // Existing sessions end with the ban; a fresh sign-in stays signed out for commerce.
      env.DB.prepare('DELETE FROM session WHERE user_id=? AND EXISTS(SELECT 1 FROM customer_bans WHERE user_id=?)').bind(target, target),
    ] : [
      env.DB.prepare('DELETE FROM customer_bans WHERE user_id=?').bind(target),
      audit(env, actor.id, 'user.unban', target, { banned: false }),
    ];
    const [result] = await env.DB.batch(statements);
    return { ok: true, banned: input.banned, changed: result.meta.changes === 1 };
  }
  demand(false, 404, 'Endpoint not found');
}
