import { requireAdmin } from './integrations/auth';
import { demand, origin } from './integrations/security';
import { adminPermits, HttpError, readBounded } from './shared';

export interface StorageEnv {
  DB: D1Database;
  PUBLIC_ORIGIN: string;
  MEDIA?: R2Bucket;
  PRIVATE_FILES?: R2Bucket;
  MEDIA_ORIGIN?: string;
}
const LIMIT = 5 * 1024 * 1024;
const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' };

async function bounded(stream: ReadableStream<Uint8Array> | null, limit = LIMIT): Promise<Uint8Array> {
  demand(stream, 400, 'Empty body');
  const bytes = await readBounded(stream, limit);
  demand(bytes.length > 0, 400, 'Empty body');
  return bytes;
}
function imageExtension(type: string, bytes: Uint8Array): string {
  const starts = (signature: number[]) => signature.every((b, i) => bytes[i] === b);
  if (type === 'image/jpeg' && starts([255, 216, 255])) return 'jpg';
  if (type === 'image/png' && starts([137, 80, 78, 71, 13, 10, 26, 10])) return 'png';
  if (type === 'image/webp' && bytes.length >= 12 && starts([82, 73, 70, 70]) && bytes.slice(8, 12).every((b, i) => b === [87, 69, 66, 80][i])) return 'webp';
  throw new HttpError(415, 'Unsupported image or signature');
}
async function persist(bucket: R2Bucket, key: string, bytes: Uint8Array, type: string, statement: D1PreparedStatement, reference: D1PreparedStatement, publicMedia = false) {
  // Random immutable keys plus a conditional write defend against accidental overwrite.
  const object = await bucket.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' }, httpMetadata: { contentType: type, ...(publicMedia ? { cacheControl: 'public, max-age=31536000, immutable' } : {}) } });
  demand(object, 409, 'Object key conflict');
  try { await statement.run(); }
  catch (error) {
    // A failed/ambiguous D1 response may have committed: never delete a referenced object.
    try {
      const referenced = await reference.first();
      if (!referenced) await bucket.delete(key);
    } catch { /* Leave for operator orphan reconciliation; no sensitive logs. */ }
    throw error;
  }
}

export async function storageRequest(request: Request, env: StorageEnv): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/api/admin/media' && path !== '/api/admin/files' && !path.startsWith('/api/admin/files/')) return null;
  try {
    const download = /^\/api\/admin\/files\/([a-f0-9-]{36})$/.exec(path);
    demand(download ? request.method === 'GET' : (path === '/api/admin/media' || path === '/api/admin/files') && request.method === 'POST', 405, 'Method not allowed');
    if (!download) origin(request, env);
    const actor = await requireAdmin(request, env);
    demand(adminPermits(actor.role, path), 403, 'Role not permitted');
    if (download) {
      demand(env.PRIVATE_FILES, 503, 'Private storage unavailable');
      const row = await env.DB.prepare('SELECT object_key FROM private_files WHERE id=?').bind(download[1]).first<{ object_key: string }>();
      demand(row, 404, 'File not found');
      const object = await env.PRIVATE_FILES.get(row.object_key);
      demand(object, 404, 'File not found');
      await env.DB.prepare('INSERT INTO audit_logs(id,actor,action,target,details_json,created_at) VALUES(?,?,?,?,?,?)').bind(crypto.randomUUID(), actor.id, 'file.download', download[1], '{}', Date.now()).run();
      return new Response(object.body, { headers: { ...headers, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="${download[1]}.bin"`, 'Content-Security-Policy': "default-src 'none'; sandbox" } });
    }
    const media = path === '/api/admin/media', bucket = media ? env.MEDIA : env.PRIVATE_FILES;
    demand(bucket, 503, 'Storage unavailable');
    let publicOrigin: URL | undefined;
    if (media) {
      try { publicOrigin = new URL(env.MEDIA_ORIGIN ?? ''); } catch { throw new HttpError(503, 'Public media origin unavailable'); }
      demand(publicOrigin.protocol === 'https:' && !publicOrigin.username && !publicOrigin.password && publicOrigin.pathname === '/' && !publicOrigin.search && !publicOrigin.hash && !publicOrigin.hostname.endsWith('.r2.dev'), 503, 'Public media origin unavailable');
    }
    demand(Number(request.headers.get('Content-Length') || 0) <= LIMIT, 413, 'Body too large');
    const bytes = await bounded(request.body);
    const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
    const extension = media ? imageExtension(type, bytes) : 'bin';
    const productId = url.searchParams.get('productId');
    demand(!productId || (media && productId.length <= 128), 400, 'Invalid product');
    if (productId) demand(await env.DB.prepare('SELECT id FROM products WHERE id=?').bind(productId).first(), 400, 'Invalid product');
    const id = crypto.randomUUID(), key = `${media ? 'media' : 'files'}/${id}.${extension}`;
    const publicUrl = media ? `${publicOrigin!.origin}/${key}` : undefined;
    const statement = media
      ? env.DB.prepare('INSERT INTO product_media (id,product_id,object_key,url,content_type,size,actor_id,created_at) VALUES (?,?,?,?,?,?,?,?)').bind(id, productId, key, publicUrl!, type, bytes.length, actor.id, Date.now())
      : env.DB.prepare('INSERT INTO private_files (id,object_key,size,actor_id,created_at) VALUES (?,?,?,?,?)').bind(id, key, bytes.length, actor.id, Date.now());
    await persist(bucket, key, bytes, media ? type : 'application/octet-stream', statement, env.DB.prepare(`SELECT id FROM ${media ? 'product_media' : 'private_files'} WHERE object_key=?`).bind(key), media);
    return Response.json({ id, ...(publicUrl ? { url: publicUrl } : {}) }, { status: 201, headers });
  } catch (error) {
    return Response.json({ error: error instanceof HttpError ? error.message : 'Storage unavailable' }, { status: error instanceof HttpError ? error.status : 503, headers });
  }
}

/** Inbound mail older than INBOUND_RETENTION_DAYS (default 180): objects first, then rows, 50 per run. */
export async function inboundRetention(env: StorageEnv & { INBOUND_RETENTION_DAYS?: string }) {
  if (!env.PRIVATE_FILES) return 0;
  const days = Number(env.INBOUND_RETENTION_DAYS ?? 180);
  const cutoff = Date.now() - (Number.isSafeInteger(days) && days > 0 ? days : 180) * 86_400_000;
  const { results } = await env.DB.prepare('SELECT id,object_key FROM support_messages WHERE created_at<? ORDER BY created_at,id LIMIT 50').bind(cutoff).all<{ id: string; object_key: string }>();
  if (!results.length) return 0;
  // A row is only removed after its object is gone; a failed R2 delete leaves both for the next run.
  await env.PRIVATE_FILES.delete(results.map(r => r.object_key));
  await env.DB.prepare(`DELETE FROM support_messages WHERE id IN (${results.map(() => '?').join(',')})`).bind(...results.map(r => r.id)).run();
  return results.length;
}

/** Raw mail remains private/untrusted. No MIME/HTML rendering, forwarding or outbound API. */
export async function receiveEmail(message: ForwardableEmailMessage, env: StorageEnv): Promise<void> {
  if (message.rawSize > LIMIT || message.from.length > 320 || message.to.length > 320 || /[\r\n\0]/.test(message.from + message.to)) {
    message.setReject('Message exceeds supported limits'); return;
  }
  demand(env.PRIVATE_FILES, 503, 'Private storage unavailable');
  let bytes: Uint8Array;
  try { bytes = await bounded(message.raw); }
  catch (error) {
    if (error instanceof HttpError) { message.setReject('Message exceeds supported limits'); return; }
    throw error;
  }
  const id = crypto.randomUUID(), key = `inbound/${id}.eml`;
  await persist(env.PRIVATE_FILES, key, bytes, 'application/octet-stream', env.DB.prepare('INSERT INTO support_messages (id,object_key,sender,recipient,size,created_at) VALUES (?,?,?,?,?,?)').bind(id, key, message.from, message.to, bytes.length, Date.now()), env.DB.prepare('SELECT id FROM support_messages WHERE object_key=?').bind(key));
}
