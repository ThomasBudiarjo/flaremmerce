import { beforeEach, afterEach, expect, it } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { storageRequest, receiveEmail, type StorageEnv } from '../src/storage';
import type { IntegrationEnv } from '../src/integrations';
let mf: Miniflare, env: StorageEnv & IntegrationEnv, cookie: string;
const secret = 'test-secret-at-least-thirty-two-characters';
const png = new Uint8Array([137,80,78,71,13,10,26,10,0]);
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules:true, script:'export default {fetch(){return new Response("ok")}}', compatibilityDate:'2026-08-06', d1Databases:{DB:'storage'}, r2Buckets:['MEDIA','PRIVATE_FILES'] }));
  const DB = await mf.getD1Database('DB');
  for (const name of ['0001_commerce','0002_integrations','0003_storage']) await DB.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  env = { DB:DB as unknown as D1Database, PUBLIC_ORIGIN:'https://shop.example', MEDIA_ORIGIN:'https://media.example', MEDIA:await mf.getR2Bucket('MEDIA') as unknown as R2Bucket, PRIVATE_FILES:await mf.getR2Bucket('PRIVATE_FILES') as unknown as R2Bucket, BETTER_AUTH_SECRET:secret, GOOGLE_CLIENT_ID:'test', GOOGLE_CLIENT_SECRET:'test' };
  const now = Date.now();
  await DB.batch([
    DB.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('owner','owner','owner@example.com',1,now,now),
    DB.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('session','token-owner','owner',now+3600000,now,now),
    DB.prepare('INSERT INTO admin_roles VALUES (?,?,?)').bind('owner','owner',now),
    DB.prepare('INSERT INTO products (id,slug,name) VALUES (?,?,?)').bind('product','product','Product'),
  ]);
  cookie = `__Secure-better-auth.session_token=${encodeURIComponent(`token-owner.${createHmac('sha256',secret).update('token-owner').digest('base64')}`)}`;
});
afterEach(async () => { await mf?.dispose(); });
function upload(path = '/api/admin/media', body: BodyInit = png, type = 'image/png', auth = cookie, origin = env.PUBLIC_ORIGIN) {
  return storageRequest(new Request(`https://shop.example${path}`, { method:'POST', headers:{Cookie:auth,Origin:origin,'Content-Type':type},body }),env);
}
it('stores immutable public media with metadata and optional product FK', async () => {
  const a = await upload('/api/admin/media?productId=product'), b = await upload();
  expect(a!.status).toBe(201); expect(b!.status).toBe(201);
  const first = await a!.json() as any, second = await b!.json() as any;
  expect(first.url).not.toBe(second.url);
  const row = await env.DB.prepare('SELECT * FROM product_media WHERE id=?').bind(first.id).first<any>();
  expect(row.product_id).toBe('product');
  const object = await env.MEDIA!.get(row.object_key);
  expect(new Uint8Array(await object!.arrayBuffer())).toEqual(png);
  expect(object!.httpMetadata!.cacheControl).toContain('immutable');
  expect((await upload('/api/admin/media?productId=missing'))!.status).toBe(400);
});
it('fails closed for origin, anonymous, revoked role/session, SVG, signature, size and missing HTTPS', async () => {
  expect((await upload(undefined,undefined,undefined,'',env.PUBLIC_ORIGIN))!.status).toBe(401);
  expect((await upload(undefined,undefined,undefined,cookie,'https://evil.example'))!.status).toBe(403);
  expect((await upload(undefined,'<svg/>','image/svg+xml'))!.status).toBe(415);
  expect((await upload(undefined,'<html/>','image/png'))!.status).toBe(415);
  expect((await upload(undefined,new Uint8Array(5242881)))!.status).toBe(413);
  env.MEDIA_ORIGIN = 'http://media.example'; expect((await upload())!.status).toBe(503); env.MEDIA_ORIGIN='https://media.example';
  await env.DB.prepare('DELETE FROM admin_roles').run(); expect((await upload())!.status).toBe(403);
  await env.DB.prepare('DELETE FROM session').run(); expect((await upload())!.status).toBe(401);
  expect((await env.MEDIA!.list()).objects).toHaveLength(0);
});
it('downloads private HTML only as no-store nosniff attachment with fresh authorization', async () => {
  const result = await upload('/api/admin/files','<script>alert(1)</script>','text/html');
  const data = await result!.json() as any; expect(data.url).toBeUndefined();
  const get = (auth: string) => storageRequest(new Request(`https://shop.example/api/admin/files/${data.id}`, {headers:{Cookie:auth}}),env);
  expect((await get(''))!.status).toBe(401);
  const response = (await get(cookie))!;
  expect(response.headers.get('Content-Type')).toBe('application/octet-stream');
  expect(response.headers.get('Content-Disposition')).toContain('attachment;');
  expect(response.headers.get('Cache-Control')).toContain('no-store');
  expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
  expect(await response.text()).toBe('<script>alert(1)</script>');
  expect((await env.MEDIA!.list()).objects).toHaveLength(0);
  await env.DB.prepare('DELETE FROM session').run(); expect((await get(cookie))!.status).toBe(401);
});
it('stores bounded raw inbound mail privately and rejects oversize streams without parsing HTML', async () => {
  const raw = 'Subject: unsafe\r\n\r\n<script>unsafe</script>';
  let rejected = '';
  const message = (body: Uint8Array, rawSize = body.length) => ({ from:'sender@example.com',to:'support@example.com',rawSize,raw:new ReadableStream({start(c){c.enqueue(body);c.close();}}),setReject(reason:string){rejected=reason;} }) as unknown as ForwardableEmailMessage;
  await receiveEmail(message(new TextEncoder().encode(raw)),env);
  const row = await env.DB.prepare('SELECT * FROM support_messages').first<any>();
  expect(await (await env.PRIVATE_FILES!.get(row.object_key))!.text()).toBe(raw);
  expect((await env.MEDIA!.list()).objects).toHaveLength(0);
  await receiveEmail(message(new Uint8Array(5242881),1),env); expect(rejected).toBeTruthy();
  expect(await env.DB.prepare('SELECT count(*) n FROM support_messages').first('n')).toBe(1);
});
it('cleans up an object after a definite D1 insert failure', async () => {
  await env.DB.exec("CREATE TRIGGER storage_failure BEFORE INSERT ON private_files BEGIN SELECT RAISE(ABORT,'storage_failure'); END;");
  expect((await upload('/api/admin/files','private'))!.status).toBe(503);
  expect((await env.PRIVATE_FILES!.list()).objects).toHaveLength(0);
  expect(await storageRequest(new Request('https://shop.example/api/catalog'),env)).toBeNull();
});
