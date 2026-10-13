import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { handleIntegrationRequest, requireAdmin, getCustomer, verifyTurnstile, verifyPaymentWebhook, createPayment, lookupPayment, type IntegrationEnv } from '../src/integrations';

let mf: Miniflare, env: IntegrationEnv;
const secret = 'test-secret-at-least-thirty-two-characters';
const request = (path: string, value?: unknown, cookie?: string) => new Request(`https://shop.example${path}`, {method:value === undefined ? 'GET':'POST', headers:{Origin:'https://shop.example', 'Content-Type':'application/json', ...(cookie ? {Cookie:cookie}: {})}, ...(value === undefined ? {} : {body:JSON.stringify(value)})});
async function identity(id: string, verified = true) {
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id,id,`${id}@example.com`,verified ? 1:0,now,now),
    env.DB.prepare("INSERT INTO account (id,account_id,provider_id,user_id,created_at,updated_at) VALUES (?,?,'google',?,?,?)").bind(id,id,id,now,now),
    env.DB.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(id,`token-${id}`,id,now+3600000,now,now),
  ]);
  const token = `token-${id}`;
  return `__Secure-better-auth.session_token=${encodeURIComponent(`${token}.${createHmac('sha256',secret).update(token).digest('base64')}`)}`;
}
beforeEach(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({modules:true, script:'export default {fetch(){return new Response("ok")}}', compatibilityDate:'2026-08-06', d1Databases:{DB:'integrations'}}));
  const DB = await mf.getD1Database('DB');
  // D1 exec doesn't support embedded newlines in individual statements.
  await DB.exec(readFileSync(new URL('../migrations/0002_integrations.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  env = {DB:DB as unknown as D1Database, PUBLIC_ORIGIN:'https://shop.example', BETTER_AUTH_SECRET:secret, GOOGLE_CLIENT_ID:'test-google', GOOGLE_CLIENT_SECRET:'test-google-secret', BOOTSTRAP_SECRET:secret, TURNSTILE_SECRET_KEY:'test-turnstile', DOKU_CLIENT_ID:'MCH-test', DOKU_SECRET_KEY:secret};
});
afterEach(async () => { vi.unstubAllGlobals(); await mf.dispose(); });

describe('public authentication and installation', () => {
  it('logs in without providers only in explicit development and keeps sessions server-validated', async () => {
    const dev = {...env, APP_ENV:'development', DEV_LOGIN_ENABLED:'true', GOOGLE_CLIENT_ID:undefined, GOOGLE_CLIENT_SECRET:undefined};
    const path = '/api/auth/development-login';
    for (const flags of [{}, {APP_ENV:'production', DEV_LOGIN_ENABLED:'true'}, {APP_ENV:'development'}]) {
      expect((await handleIntegrationRequest(request(path,{}), {...env,...flags}))?.status).not.toBe(200);
    }
    expect((await handleIntegrationRequest(request(path),dev))?.status).not.toBe(200);
    expect((await handleIntegrationRequest(new Request(`https://shop.example${path}`, {method:'POST',headers:{Origin:'https://evil.example'},body:'{}'}),dev))?.status).toBe(403);
    const proxied = () => new Request(`http://shop.example${path}`, {method:'POST',headers:{Origin:'http://shop.example', 'Content-Type':'application/json'},body:'{}'});
    expect((await handleIntegrationRequest(proxied(),env))?.status).toBe(403);
    expect((await handleIntegrationRequest(proxied(),dev))?.status).toBe(200);
    expect((await handleIntegrationRequest(new Request(`http://shop.example${path}`, {method:'POST',headers:{Origin:'http://evil.example'},body:'{}'}),dev))?.status).toBe(403);
    const response = await handleIntegrationRequest(request(path,{}),dev);
    expect(response?.status).toBe(200);
    const cookie = response!.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    expect(await requireAdmin(request('/admin',undefined,cookie),dev)).toEqual({id:'flaremmerce-dev-admin'});
    expect((await handleIntegrationRequest(request('/api/setup'),dev))?.status).toBe(200);
    expect(await env.DB.prepare('SELECT owner_id FROM installation').first('owner_id')).toBe('flaremmerce-dev-admin');
    await expect(requireAdmin(request('/admin',undefined,cookie),env)).rejects.toMatchObject({status:401});
    expect(await getCustomer(request('/customer',undefined,cookie),env)).toBeNull();
    expect((await handleIntegrationRequest(request(path,{}),dev))?.status).toBe(200);
    await env.DB.prepare('DELETE FROM admin_roles').run();
    expect((await handleIntegrationRequest(request(path,{}),dev))?.status).not.toBe(200);
    await expect(requireAdmin(request('/admin',undefined,cookie),dev)).rejects.toMatchObject({status:403});
  });
  it('does not let dev login take over an existing Google installation', async () => {
    const cookie = await identity('owner');
    expect((await handleIntegrationRequest(request('/api/setup',{secret},cookie),env))?.status).toBe(200);
    expect((await handleIntegrationRequest(request('/api/auth/development-login',{}),{...env,APP_ENV:'development',DEV_LOGIN_ENABLED:'true'}))?.status).not.toBe(200);
    expect(await env.DB.prepare('SELECT owner_id FROM installation').first('owner_id')).toBe('owner');
    expect(await env.DB.prepare('SELECT count(*) n FROM admin_roles').first('n')).toBe(1);
  });
  it('rejects tampered sessions and observes immediate revocation on admin checks', async () => {
    const cookie = await identity('owner');
    expect(await getCustomer(request('/api/auth/get-session',undefined,cookie),env)).toEqual({id:'owner'});
    await env.DB.prepare('INSERT INTO admin_roles VALUES (?,?,?)').bind('owner','owner',Date.now()).run();
    expect(await requireAdmin(request('/admin',undefined,cookie),env)).toEqual({id:'owner'});
    await env.DB.prepare('DELETE FROM session WHERE user_id=?').bind('owner').run();
    await expect(requireAdmin(request('/admin',undefined,cookie),env)).rejects.toMatchObject({status:401});
    expect(await getCustomer(request('/api/auth/get-session',undefined,`${cookie}tampered`),env)).toBeNull();
  });
  it('bypasses a valid compact cache and reads fresh roles for sensitive access', async () => {
    const cookie = await identity('cached');
    await env.DB.prepare('INSERT INTO admin_roles VALUES (?,?,?)').bind('cached','cached',Date.now()).run();
    const response = await handleIntegrationRequest(request('/api/auth/get-session',undefined,cookie),env);
    const cache = response!.headers.getSetCookie().find(c=>c.startsWith('__Secure-better-auth.session_data='));
    expect(cache).toBeTruthy();
    const cookies = `${cookie}; ${cache!.split(';')[0]}`;
    await env.DB.prepare('DELETE FROM admin_roles WHERE user_id=?').bind('cached').run();
    await expect(requireAdmin(request('/admin',undefined,cookies),env)).rejects.toMatchObject({status:403});
    await env.DB.prepare('DELETE FROM session WHERE user_id=?').bind('cached').run();
    expect(await getCustomer(request('/customer',undefined,cookies),env)).toBeNull();
    await expect(requireAdmin(request('/admin',undefined,cookies),env)).rejects.toMatchObject({status:401});
  });
  it('only bootstraps one verified Google identity under concurrency and never reopens', async () => {
    const [a,b] = await Promise.all([identity('a'),identity('b')]);
    const results = await Promise.all([handleIntegrationRequest(request('/api/setup',{secret},a),env),handleIntegrationRequest(request('/api/setup',{secret},b),env)]);
    expect(results.filter(r=>r?.status === 200)).toHaveLength(1);
    expect(await env.DB.prepare('SELECT count(*) n FROM admin_roles').first('n')).toBe(1);
    expect((await handleIntegrationRequest(request('/api/setup',{secret},a),env))?.status).toBe(409);
    await expect(env.DB.prepare('DELETE FROM installation').run()).rejects.toThrow();
  });
  it('rejects wrong origin, secret, unverified identity and public role escalation', async () => {
    const cookie = await identity('unverified',false);
    expect((await handleIntegrationRequest(request('/api/setup',{secret:'wrong'},cookie),env))?.status).toBe(403);
    expect((await handleIntegrationRequest(request('/api/setup',{secret},cookie),env))?.status).toBe(403);
    const cross = new Request('https://shop.example/api/setup',{method:'POST',headers:{Origin:'https://evil.example'},body:'{}'});
    expect((await handleIntegrationRequest(cross,env))?.status).toBe(403);
    expect((await handleIntegrationRequest(request('/api/admin/roles',{userId:'unverified',admin:true},cookie),env))?.status).toBe(403);
    expect((await handleIntegrationRequest(request('/api/auth/sign-up/email',{email:'a@example.com',password:'password'}),env))?.status).not.toBe(200);
    expect((await handleIntegrationRequest(request('/api/setup'),env))?.headers.get('Cache-Control')).toContain('no-store');
  });
});

async function notification(status: string, original = 'ref1') {
  const raw = JSON.stringify({order:{invoice_number:'ref1',amount:10000},transaction:{status,original_request_id:original,type:'SALE'}});
  const time = '2026-10-12T00:00:00Z', id = 'documented-notification-id';
  const digest = createHmac; // Signature fixture deliberately independent of integration implementation.
  const {createHash} = await import('node:crypto');
  const components = `Client-Id:MCH-test\nRequest-Id:${id}\nRequest-Timestamp:${time}\nRequest-Target:/api/payment/webhook\nDigest:${createHash('sha256').update(raw).digest('base64')}`;
  return new Request('https://shop.example/api/payment/webhook',{method:'POST',body:raw,headers:{'Client-Id':'MCH-test','Request-Id':id,'Request-Timestamp':time,Signature:`HMACSHA256=${digest('sha256',secret).update(components).digest('base64')}`}});
}
describe('provider boundaries', () => {
  it('uses the precreated reference and refuses mismatched creation responses', async () => {
    const input = {reference:'stable-attempt1',amount:10000,returnUrl:'https://shop.example/payment/return'};
    const provider = vi.fn(async (url:unknown,init:any) => {
      expect(url).toBe('https://api-sandbox.doku.com/checkout/v1/payment');
      expect(init.headers['Request-Id']).toBe(input.reference);
      expect(JSON.parse(init.body).order.invoice_number).toBe(input.reference);
      return Response.json({response:{order:{invoice_number:input.reference,amount:input.amount,currency:'IDR'},payment:{url:'https://sandbox.doku.com/checkout'},uuid:'documented-uuid'}});
    });
    vi.stubGlobal('fetch',provider);
    expect(await createPayment(input,env)).toEqual({url:'https://sandbox.doku.com/checkout',providerId:'documented-uuid'});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({response:{order:{invoice_number:'other',amount:10000},payment:{url:'https://sandbox.doku.com/checkout'}}})));
    await expect(createPayment(input,env)).rejects.toMatchObject({status:502});
    await expect(createPayment(input,{...env,DOKU_SECRET_KEY:undefined})).rejects.toMatchObject({status:503});
  });
  it('validates raw signatures, stable identity, and ignores Checkout FAILED/unknown statuses', async () => {
    expect(await verifyPaymentWebhook(await notification('SUCCESS'),env)).toEqual({eventKey:'doku:MCH-test:documented-notification-id',reference:'ref1',amount:10000,currency:'IDR',status:'succeeded'});
    expect((await verifyPaymentWebhook(await notification('FAILED'),env)).status).toBe('ignored');
    for (const status of ['EXPIRED','AUTHORIZED','paid']) await expect(verifyPaymentWebhook(await notification(status),env)).rejects.toMatchObject({status:422});
    await expect(verifyPaymentWebhook(await notification('SUCCESS','different'),env)).rejects.toMatchObject({status:422});
    const valid = await notification('SUCCESS');
    const tampered = new Request(valid,{body:(await valid.text()).replace('10000','20000')});
    await expect(verifyPaymentWebhook(tampered,env)).rejects.toMatchObject({status:401});
    const bom = await notification('SUCCESS');
    const bomRaw = await bom.text();
    await expect(verifyPaymentWebhook(new Request(bom,{body:`\uFEFF${bomRaw}`}),env)).rejects.toMatchObject({status:401});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({order:{invoice_number:'ref1',amount:10000},transaction:{status:'EXPIRED'}})));
    expect(await lookupPayment('ref1',env)).toEqual({status:'unknown'});
  });
  it('reconciles only authoritative matching sale and signs GET without Digest', async () => {
    const {createHmac} = await import('node:crypto');
    vi.stubGlobal('fetch',vi.fn(async (url:unknown, init:any) => {
      expect(url).toBe('https://api-sandbox.doku.com/orders/v1/status/ref1');
      const h = init.headers;
      const text = `Client-Id:MCH-test\nRequest-Id:${h['Request-Id']}\nRequest-Timestamp:${h['Request-Timestamp']}\nRequest-Target:/orders/v1/status/ref1`;
      expect(h.Signature).toBe(`HMACSHA256=${createHmac('sha256',secret).update(text).digest('base64')}`);
      return Response.json({order:{invoice_number:'ref1',amount:'10000'},transaction:{status:'SUCCESS',type:'SALE'}});
    }));
    expect(await lookupPayment('ref1',env)).toEqual({status:'succeeded',amount:10000,currency:'IDR'});
    for (const status of ['FAILED','PENDING']) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({order:{invoice_number:'ref1',amount:10000},transaction:{status}})));
      expect(await lookupPayment('ref1',env)).toEqual({status:'pending'});
    }
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({order:{invoice_number:'other',amount:10000},transaction:{status:'SUCCESS'}})));
    expect(await lookupPayment('ref1',env)).toEqual({status:'unknown'});
  });
  it('fails closed for invalid, wrong-host, wrong-action and network Turnstile results', async () => {
    for (const result of [{success:false},{success:true,hostname:'evil.example',action:'checkout'},{success:true,hostname:'shop.example',action:'other'}]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json(result)));
      await expect(verifyTurnstile('token',env)).rejects.toMatchObject({status:403});
    }
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network')}));
    await expect(verifyTurnstile('token',env)).rejects.toMatchObject({status:503});
  });
  it('quotes authoritative catalog grams and persists only provider tariffs', async () => {
    await env.DB.exec('CREATE TABLE product_variants (id TEXT PRIMARY KEY, weight INTEGER); INSERT INTO product_variants VALUES (\'sku\', 350);');
    Object.assign(env,{RAJAONGKIR_API_KEY:'test',RAJAONGKIR_ORIGIN:'1',RAJAONGKIR_COURIERS:'jne'});
    const fetcher = vi.fn(async (_url:unknown,init:any) => {expect(init.body.get('weight')).toBe('700'); return Response.json({meta:{code:200,status:'success'},data:[{code:'jne',service:'REG',cost:12000}]});});
    vi.stubGlobal('fetch',fetcher);
    const response = await handleIntegrationRequest(request('/api/shipping/quote',{destination:'2',items:[{variantId:'sku',quantity:2}],amount:1}),env);
    const result = await response!.json() as any;
    expect(result.quotes[0].amount).toBe(12000);
    expect(await env.DB.prepare('SELECT weight FROM shipping_quotes WHERE id=?').bind(result.quotes[0].id).first('weight')).toBe(700);
  });
});
