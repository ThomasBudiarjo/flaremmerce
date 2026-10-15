import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHmac } from 'node:crypto';
import { handleIntegrationRequest, requireAdmin, getCustomer, verifyTurnstile, verifyPaymentWebhook, createPayment, lookupPayment, type IntegrationEnv } from '../src/integrations';
import { integrationRetention } from '../src/integrations/retention';

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
  for (const name of ['0002_integrations','0011_admin_access','0013_accounts']) await DB.exec(readFileSync(new URL(`../migrations/${name}.sql`,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
  await DB.exec("INSERT INTO shipping_destinations VALUES('2','MENTENG, JAKARTA PUSAT, DKI JAKARTA, 10310','DKI JAKARTA','JAKARTA PUSAT','MENTENG','MENTENG','10310',0)");
  env = {DB:DB as unknown as D1Database, PUBLIC_ORIGIN:'https://shop.example', BETTER_AUTH_SECRET:secret, GOOGLE_CLIENT_ID:'test-google', GOOGLE_CLIENT_SECRET:'test-google-secret', BOOTSTRAP_SECRET:secret, TURNSTILE_SECRET_KEY:'test-turnstile', DOKU_CLIENT_ID:'MCH-test', DOKU_SECRET_KEY:secret};
});
afterEach(async () => { vi.unstubAllGlobals(); await mf.dispose(); });

describe('public authentication and installation', () => {
  it('logs in without providers only in explicit development and keeps sessions server-validated', async () => {
    const dev = {...env, APP_ENV:'development', DEV_LOGIN_ENABLED:'true', DEV_LOGIN_ALLOW_REMOTE:'true', GOOGLE_CLIENT_ID:undefined, GOOGLE_CLIENT_SECRET:undefined};
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
    expect(await requireAdmin(request('/admin',undefined,cookie),dev)).toEqual({id:'flaremmerce-dev-admin',role:'owner'});
    expect((await handleIntegrationRequest(request('/api/setup'),dev))?.status).toBe(200);
    expect(await env.DB.prepare('SELECT owner_id FROM installation').first('owner_id')).toBe('flaremmerce-dev-admin');
    await expect(requireAdmin(request('/admin',undefined,cookie),env)).rejects.toMatchObject({status:401});
    expect(await getCustomer(request('/customer',undefined,cookie),env)).toBeNull();
    expect((await handleIntegrationRequest(request(path,{}),dev))?.status).toBe(200);
    await env.DB.prepare('DELETE FROM admin_roles').run();
    expect((await handleIntegrationRequest(request(path,{}),dev))?.status).not.toBe(200);
    await expect(requireAdmin(request('/admin',undefined,cookie),dev)).rejects.toMatchObject({status:403});
  });
  it('logs in to staging only with the passphrase secret, bootstrapping the owner once', async () => {
    const passphrase = 'staging-passphrase-at-least-32-characters';
    const staging = {...env, APP_ENV:'staging', STAGING_LOGIN_SECRET:passphrase, GOOGLE_CLIENT_ID:undefined, GOOGLE_CLIENT_SECRET:undefined};
    const path = '/api/auth/staging-login';
    const { stagingLoginEnabled } = await import('../src/integrations/auth');
    expect(stagingLoginEnabled(staging)).toBe(true);
    for (const flags of [{STAGING_LOGIN_SECRET:undefined}, {STAGING_LOGIN_SECRET:'too-short'}, {APP_ENV:'production'}, {APP_ENV:undefined}, {APP_ENV:'development', DEV_LOGIN_ENABLED:'true'}]) {
      expect(stagingLoginEnabled({...staging, ...flags})).toBe(false);
      expect((await handleIntegrationRequest(request(path,{secret:passphrase}), {...staging, ...flags}))?.status).not.toBe(200);
    }
    // Without Google and without a staging secret there is no sign-in method at all.
    expect((await handleIntegrationRequest(request('/api/auth/get-session'), {...staging, STAGING_LOGIN_SECRET:undefined}))?.status).toBe(503);
    expect((await handleIntegrationRequest(request(path,{secret:`${passphrase}x`}),staging))?.status).toBe(403);
    expect((await handleIntegrationRequest(request(path,{}),staging))?.status).toBe(400);
    expect((await handleIntegrationRequest(new Request(`https://shop.example${path}`, {method:'POST',headers:{Origin:'https://evil.example','Content-Type':'application/json'},body:JSON.stringify({secret:passphrase})}),staging))?.status).toBe(403);
    expect(await env.DB.prepare('SELECT count(*) n FROM installation').first('n')).toBe(0);
    const response = await handleIntegrationRequest(request(path,{secret:passphrase}),staging);
    expect(response?.status).toBe(200);
    const cookie = response!.headers.getSetCookie().map(c=>c.split(';')[0]).join('; ');
    expect(cookie).toContain('__Secure-better-auth.session_token=');
    expect(await requireAdmin(request('/admin',undefined,cookie),staging)).toEqual({id:'flaremmerce-staging-admin',role:'owner'});
    expect(await env.DB.prepare('SELECT owner_id FROM installation').first('owner_id')).toBe('flaremmerce-staging-admin');
    expect((await handleIntegrationRequest(request(path,{secret:passphrase}),staging))?.status).toBe(200);
    expect(await env.DB.prepare('SELECT count(*) n FROM admin_roles').first('n')).toBe(1);
    // Switching the mode off (secret removed, or a production env) invalidates the fixed identity's session.
    await expect(requireAdmin(request('/admin',undefined,cookie),{...staging, STAGING_LOGIN_SECRET:undefined, GOOGLE_CLIENT_ID:'g', GOOGLE_CLIENT_SECRET:'g'})).rejects.toMatchObject({status:401});
    await expect(requireAdmin(request('/admin',undefined,cookie),env)).rejects.toMatchObject({status:401});
    expect(await getCustomer(request('/customer',undefined,cookie),env)).toBeNull();
    // A revoked role is never restored by logging in again.
    await env.DB.prepare('DELETE FROM admin_roles').run();
    expect((await handleIntegrationRequest(request(path,{secret:passphrase}),staging))?.status).toBe(403);
    await expect(requireAdmin(request('/admin',undefined,cookie),staging)).rejects.toMatchObject({status:403});
  });
  it('does not let staging login take over an existing Google installation', async () => {
    const cookie = await identity('owner');
    expect((await handleIntegrationRequest(request('/api/setup',{secret},cookie),env))?.status).toBe(200);
    const passphrase = 'staging-passphrase-at-least-32-characters';
    expect((await handleIntegrationRequest(request('/api/auth/staging-login',{secret:passphrase}),{...env,APP_ENV:'staging',STAGING_LOGIN_SECRET:passphrase}))?.status).toBe(403);
    expect(await env.DB.prepare('SELECT owner_id FROM installation').first('owner_id')).toBe('owner');
    expect(await env.DB.prepare('SELECT count(*) n FROM admin_roles').first('n')).toBe(1);
  });
  it('does not let dev login take over an existing Google installation', async () => {
    const cookie = await identity('owner');
    expect((await handleIntegrationRequest(request('/api/setup',{secret},cookie),env))?.status).toBe(200);
    expect((await handleIntegrationRequest(request('/api/auth/development-login',{}),{...env,APP_ENV:'development',DEV_LOGIN_ENABLED:'true',DEV_LOGIN_ALLOW_REMOTE:'true'}))?.status).not.toBe(200);
    expect(await env.DB.prepare('SELECT owner_id FROM installation').first('owner_id')).toBe('owner');
    expect(await env.DB.prepare('SELECT count(*) n FROM admin_roles').first('n')).toBe(1);
  });
  it('rejects tampered sessions and observes immediate revocation on admin checks', async () => {
    const cookie = await identity('owner');
    expect(await getCustomer(request('/api/auth/get-session',undefined,cookie),env)).toEqual({id:'owner'});
    await env.DB.prepare('INSERT INTO admin_roles(user_id,granted_by,created_at) VALUES (?,?,?)').bind('owner','owner',Date.now()).run();
    expect(await requireAdmin(request('/admin',undefined,cookie),env)).toEqual({id:'owner',role:'owner'});
    await env.DB.prepare('DELETE FROM session WHERE user_id=?').bind('owner').run();
    await expect(requireAdmin(request('/admin',undefined,cookie),env)).rejects.toMatchObject({status:401});
    expect(await getCustomer(request('/api/auth/get-session',undefined,`${cookie}tampered`),env)).toBeNull();
  });
  it('bypasses a valid compact cache and reads fresh roles for sensitive access', async () => {
    const cookie = await identity('cached');
    await env.DB.prepare('INSERT INTO admin_roles(user_id,granted_by,created_at) VALUES (?,?,?)').bind('cached','cached',Date.now()).run();
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
    expect(results.map(r=>r?.status).sort()).toEqual([200,409]);
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
    expect((await handleIntegrationRequest(request('/api/admin/roles',{userId:'unverified',role:'owner'},cookie),env))?.status).toBe(403);
    expect((await handleIntegrationRequest(request('/api/auth/sign-up/email',{email:'a@example.com',password:'password'}),env))?.status).not.toBe(200);
    expect((await handleIntegrationRequest(request('/api/setup'),env))?.headers.get('Cache-Control')).toContain('no-store');
  });
});

async function notification(status: string, original = 'ref1', time = new Date().toISOString().replace(/\.\d{3}Z$/,'Z'), extra: Record<string, unknown> = {}) {
  const raw = JSON.stringify({order:{invoice_number:'ref1',amount:10000},transaction:{status,original_request_id:original,type:'SALE'},...extra});
  const id = 'documented-notification-id';
  const digest = createHmac; // Signature fixture deliberately independent of integration implementation.
  const {createHash} = await import('node:crypto');
  const components = `Client-Id:MCH-test\nRequest-Id:${id}\nRequest-Timestamp:${time}\nRequest-Target:/api/payment/webhook\nDigest:${createHash('sha256').update(raw).digest('base64')}`;
  return new Request('https://shop.example/api/payment/webhook',{method:'POST',body:raw,headers:{'Client-Id':'MCH-test','Request-Id':id,'Request-Timestamp':time,Signature:`HMACSHA256=${digest('sha256',secret).update(components).digest('base64')}`}});
}
describe('provider boundaries', () => {
  it('validates public destination searches before contacting the provider', async () => {
    const path = '/api/shipping/destinations';
    const fetcher = vi.fn(); vi.stubGlobal('fetch',fetcher);
    const configured = {...env, RAJAONGKIR_API_KEY:'server-only-key'};
    for (const input of [null, {}, {search:12}, {search:'ab'}, {search:' '.repeat(10)}, {search:'x'.repeat(101)}, {search:'***'}, {search:'jakarta&limit=999'}, {search:'jak\n\u0000arta'}]) {
      expect((await handleIntegrationRequest(request(path,input),configured))?.status).toBe(400);
    }
    expect((await handleIntegrationRequest(request(path),configured))?.status).toBe(405);
    expect((await handleIntegrationRequest(new Request(`https://shop.example${path}`,{method:'POST',headers:{Origin:'https://evil.example'},body:'{"search":"jakarta"}'}),configured))?.status).toBe(403);
    expect((await handleIntegrationRequest(request(path,{search:'jakarta'}),env))?.status).toBe(503);
    expect((await handleIntegrationRequest(request(path,{search:'x'.repeat(17000)}),configured))?.status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('returns normalized bounded destination results with a server-only key and no-store', async () => {
    const entry = {id:68513,label:'BALERAKSA, KARANGMONCOL, PURBALINGGA, JAWA TENGAH, 53355',province_name:'JAWA TENGAH',city_name:'PURBALINGGA',district_name:'KARANGMONCOL',subdistrict_name:'BALERAKSA',zip_code:'53355',secret:'not returned'};
    const configured = {...env,RAJAONGKIR_API_KEY:'server-only-key'};
    vi.stubGlobal('fetch',vi.fn(async (url:unknown,init:any) => {
      const target = new URL(String(url));
      expect(target.origin + target.pathname).toBe('https://rajaongkir.komerce.id/api/v1/destination/domestic-destination');
      expect(Object.fromEntries(target.searchParams)).toEqual({search:'53355',limit:'20',offset:'0'});
      expect(init.headers.key).toBe('server-only-key'); expect(init.signal).toBeInstanceOf(AbortSignal);
      return Response.json({meta:{code:200,status:'success'},data:[entry]});
    }));
    const response = await handleIntegrationRequest(request('/api/shipping/destinations',{search:' 53355 ',limit:999}),configured);
    expect(response?.status).toBe(200); expect(response?.headers.get('Cache-Control')).toContain('no-store');
    expect(await response!.json()).toEqual({destinations:[{id:'68513',label:entry.label,province:entry.province_name,city:entry.city_name,district:entry.district_name,subdistrict:entry.subdistrict_name,postalCode:'53355'}]});
    for (const data of [[], null]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json(data === null ? {meta:{code:404,status:'error'},data:null} : {meta:{code:200,status:'success'},data}, {status:data === null ? 404 : 200})));
      expect(await (await handleIntegrationRequest(request('/api/shipping/destinations',{search:'53355'}),configured))!.json()).toEqual({destinations:[]});
    }
    for (const data of [null, [{}], [{...entry,id:0}], [{...entry,label:''}], [{...entry,zip_code:53355}], [entry,entry], Array(21).fill(entry)]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({meta:{code:200,status:'success'},data})));
      expect((await handleIntegrationRequest(request('/api/shipping/destinations',{search:'53355'}),configured))?.status).toBe(502);
    }
  });
  it('fails destination lookup closed on provider errors, malformed JSON and timeouts', async () => {
    for (const fetcher of [
      async()=>Response.json({meta:{code:401,status:'error'},data:null},{status:401}),
      async()=>Response.json({meta:{code:500,status:'error'},data:null}),
      async()=>new Response('invalid JSON'),
      async()=>{throw new DOMException('timeout','TimeoutError');},
    ]) {
      vi.stubGlobal('fetch',vi.fn(fetcher));
      const response = await handleIntegrationRequest(request('/api/shipping/destinations',{search:'jakarta'}),{...env,RAJAONGKIR_API_KEY:'server-only-key'});
      expect(response?.status).toBe(502);
      expect(await response!.text()).not.toContain('server-only-key');
    }
  });
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
  it('reports definite 4xx creation refusals and keeps timeouts, conflicts, rate limits and 5xx ambiguous', async () => {
    const input = {reference:'stable-attempt1',amount:10000,returnUrl:'https://shop.example/payment/return'};
    for (const status of [400,401,403,404,422]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'rejected'}},{status})));
      expect(await createPayment(input,env)).toEqual({rejected:true});
    }
    for (const status of [408,409,425,429,500,502,503]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'later'}},{status})));
      await expect(createPayment(input,env)).rejects.toMatchObject({status:502});
    }
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('timeout','TimeoutError');}));
    await expect(createPayment(input,env)).rejects.toThrow();
  });
  it('validates raw signatures, stable identity, and ignores Checkout FAILED/unknown statuses', async () => {
    expect(await verifyPaymentWebhook(await notification('SUCCESS'),env)).toEqual({eventKey:'doku:MCH-test:documented-notification-id',reference:'ref1',amount:10000,currency:'IDR',status:'succeeded'});
    expect((await verifyPaymentWebhook(await notification('FAILED'),env)).status).toBe('ignored');
    // Verified but non-sale or undocumented statuses become operator evidence instead of a 422 retry loop.
    for (const status of ['EXPIRED','AUTHORIZED','paid']) expect(await verifyPaymentWebhook(await notification(status),env)).toMatchObject({status:'provider_event',reference:'ref1',kind:`SALE:${status.toUpperCase()}`});
    expect(await verifyPaymentWebhook(await notification('SUCCESS','ref1',undefined,{transaction:{status:'SUCCESS',type:'REFUND'}}),env)).toMatchObject({status:'provider_event',kind:'REFUND:SUCCESS'});
    expect(await verifyPaymentWebhook(await notification('SUCCESS','ref1',undefined,{transaction:{status:'CHARGE BACK\n',type:'CHARGEBACK'}}),env)).toMatchObject({status:'provider_event',kind:'CHARGEBACK:UNKNOWN'});
    await expect(verifyPaymentWebhook(await notification('SUCCESS','different'),env)).rejects.toMatchObject({status:422});
    const valid = await notification('SUCCESS');
    const tampered = new Request(valid,{body:(await valid.text()).replace('10000','20000')});
    await expect(verifyPaymentWebhook(tampered,env)).rejects.toMatchObject({status:401});
    const bom = await notification('SUCCESS');
    const bomRaw = await bom.text();
    await expect(verifyPaymentWebhook(new Request(bom,{body:`\uFEFF${bomRaw}`}),env)).rejects.toMatchObject({status:401});
  });
  it('rejects notifications outside the timestamp window, configurable via WEBHOOK_MAX_SKEW_MIN', async () => {
    const at = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/,'Z');
    for (const minutes of [-16, 16]) await expect(verifyPaymentWebhook(await notification('SUCCESS','ref1',at(minutes)),env)).rejects.toMatchObject({status:401});
    for (const minutes of [-14, 14]) expect((await verifyPaymentWebhook(await notification('SUCCESS','ref1',at(minutes)),env)).status).toBe('succeeded');
    await expect(verifyPaymentWebhook(await notification('SUCCESS','ref1',at(-6)),{...env,WEBHOOK_MAX_SKEW_MIN:'5'})).rejects.toMatchObject({status:401});
    expect((await verifyPaymentWebhook(await notification('SUCCESS','ref1',at(-40)),{...env,WEBHOOK_MAX_SKEW_MIN:'60'})).status).toBe('succeeded');
    await expect(verifyPaymentWebhook(await notification('SUCCESS','ref1','2026-10-12T00:00:00Z'),{...env,WEBHOOK_MAX_SKEW_MIN:'nonsense'})).rejects.toMatchObject({status:401});
  });
  it('derives a stable provider transaction identity when DOKU supplies channel and date', async () => {
    const extra = {channel:{id:'VIRTUAL_ACCOUNT_BCA'},transaction:{status:'SUCCESS',type:'SALE',original_request_id:'ref1',date:'2026-10-14T01:02:03Z'}};
    expect(await verifyPaymentWebhook(await notification('SUCCESS','ref1',undefined,extra),env)).toMatchObject({status:'succeeded',providerTx:`VIRTUAL_ACCOUNT_BCA@${Date.parse('2026-10-14T01:02:03Z')}`});
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({order:{invoice_number:'ref1',amount:10000},...extra,transaction:{...extra.transaction,date:'2026-10-14T08:02:03+07:00'}})));
    expect(await lookupPayment('ref1',env)).toEqual({status:'succeeded',amount:10000,currency:'IDR',providerTx:`VIRTUAL_ACCOUNT_BCA@${Date.parse('2026-10-14T01:02:03Z')}`});
    expect((await verifyPaymentWebhook(await notification('SUCCESS','ref1',undefined,{channel:{id:'bad channel'}}),env)).providerTx).toBeUndefined();
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
    // Every documented non-SUCCESS state is an authoritative "not paid now"; commerce owns the expiry decision.
    for (const status of ['PENDING','FAILED','TIMEOUT','REDIRECT','EXPIRED']) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({order:{invoice_number:'ref1',amount:10000},transaction:{status}})));
      expect(await lookupPayment('ref1',env)).toEqual({status:'not_paid',amount:10000,currency:'IDR'});
    }
    for (const result of [{order:{invoice_number:'other',amount:10000},transaction:{status:'SUCCESS'}},{order:{invoice_number:'ref1',amount:10000},transaction:{status:'FAILED',type:'REFUND'}},{order:{invoice_number:'ref1',amount:10000,currency:'USD'},transaction:{status:'PENDING'}},{order:{invoice_number:'ref1'},transaction:{status:'PENDING'}},{order:{invoice_number:'ref1',amount:10000},transaction:{status:'VOIDED'}}]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json(result)));
      expect(await lookupPayment('ref1',env)).toEqual({status:'unknown'});
    }
    for (const status of [400,401,429,500,503]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json({order:{invoice_number:'ref1',amount:10000},transaction:{status:'PENDING'}},{status})));
      expect(await lookupPayment('ref1',env)).toEqual({status:'unknown'});
    }
    // Only a 404 says DOKU has no such invoice; commerce decides whether that can mean "never payable".
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({error:{message:'not found'}},{status:404})));
    expect(await lookupPayment('ref1',env)).toEqual({status:'not_found'});
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new DOMException('timeout','TimeoutError');}));
    await expect(lookupPayment('ref1',env)).rejects.toThrow();
  });
  it('fails closed for invalid, wrong-host, wrong-action and network Turnstile results', async () => {
    for (const result of [{success:false},{success:true,hostname:'evil.example',action:'checkout'},{success:true,hostname:'shop.example',action:'other'}]) {
      vi.stubGlobal('fetch',vi.fn(async()=>Response.json(result)));
      await expect(verifyTurnstile('token',env)).rejects.toMatchObject({status:403});
    }
    vi.stubGlobal('fetch',vi.fn(async()=>{throw new Error('network')}));
    await expect(verifyTurnstile('token',env)).rejects.toMatchObject({status:503});
  });
  it('skips Siteverify only in staging without both Turnstile keys; a missing key elsewhere stays 503', async () => {
    const siteverify = vi.fn(async()=>Response.json({success:true,hostname:'shop.example',action:'checkout'}));
    vi.stubGlobal('fetch',siteverify);
    for (const keys of [{TURNSTILE_SECRET_KEY:undefined, TURNSTILE_SITE_KEY:undefined}, {TURNSTILE_SITE_KEY:undefined}, {TURNSTILE_SECRET_KEY:undefined, TURNSTILE_SITE_KEY:'site'}]) {
      await expect(verifyTurnstile('', {...env, APP_ENV:'staging', ...keys})).resolves.toBeUndefined();
    }
    expect(siteverify).not.toHaveBeenCalled();
    for (const appEnv of [undefined, 'production', 'development']) {
      await expect(verifyTurnstile('token', {...env, APP_ENV:appEnv, TURNSTILE_SECRET_KEY:undefined, TURNSTILE_SITE_KEY:'site'})).rejects.toMatchObject({status:503});
    }
    // Configured staging verifies exactly like production, including empty tokens.
    const configured = {...env, APP_ENV:'staging', TURNSTILE_SITE_KEY:'site'};
    await expect(verifyTurnstile('', configured)).rejects.toMatchObject({status:400});
    await expect(verifyTurnstile('token', configured)).resolves.toBeUndefined();
    expect(siteverify).toHaveBeenCalledOnce();
  });
  it('quotes authoritative catalog grams and persists only provider tariffs', async () => {
    await env.DB.exec('CREATE TABLE product_variants (id TEXT PRIMARY KEY, weight INTEGER, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER); INSERT INTO product_variants(id,weight) VALUES (\'sku\', 350);');
    Object.assign(env,{RAJAONGKIR_API_KEY:'test',RAJAONGKIR_ORIGIN:'1',RAJAONGKIR_COURIERS:'jne'});
    const fetcher = vi.fn(async (_url:unknown,init:any) => {expect(init.body.get('weight')).toBe('700'); return Response.json({meta:{code:200,status:'success'},data:[{code:'jne',service:'REG',cost:12000}]});});
    vi.stubGlobal('fetch',fetcher);
    const response = await handleIntegrationRequest(request('/api/shipping/quote',{destination:'2',items:[{variantId:'sku',quantity:2}],amount:1}),env);
    const result = await response!.json() as any;
    expect(result.quotes[0].amount).toBe(12000);
    expect(await env.DB.prepare('SELECT weight FROM shipping_quotes WHERE id=?').bind(result.quotes[0].id).first('weight')).toBe(700);
  });
});
describe('integration runtime helpers', () => {
  it('memoizes Better Auth per env binding object', async () => {
    const { auth } = await import('../src/integrations/auth');
    expect(auth(env)).toBe(auth(env));
    expect(auth({...env})).not.toBe(auth(env));
    expect(() => auth({...env, BETTER_AUTH_SECRET:'short'})).toThrow();
  });
  it('rejects quotes containing an unknown variant with a single lookup', async () => {
    await env.DB.exec("CREATE TABLE product_variants (id TEXT PRIMARY KEY, weight INTEGER, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER); INSERT INTO product_variants(id,weight) VALUES ('a', 100), ('b', 200);");
    Object.assign(env,{RAJAONGKIR_API_KEY:'test',RAJAONGKIR_ORIGIN:'1',RAJAONGKIR_COURIERS:'jne'});
    const fetcher = vi.fn(async (_url:unknown,init:any) => {expect(init.body.get('weight')).toBe('500'); return Response.json({meta:{code:200,status:'success'},data:[{code:'jne',service:'REG',cost:12000}]});});
    vi.stubGlobal('fetch',fetcher);
    expect((await handleIntegrationRequest(request('/api/shipping/quote',{destination:'2',items:[{variantId:'a',quantity:1},{variantId:'b',quantity:1},{variantId:'a',quantity:2}]}),env))?.status).toBe(200);
    expect((await handleIntegrationRequest(request('/api/shipping/quote',{destination:'2',items:[{variantId:'a',quantity:1},{variantId:'missing',quantity:1}]}),env))?.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe('anti-abuse integration boundaries', () => {
  const tariffs = Array.from({length:14}, (_, i) => ({code:'jne', service:`S${i}`, cost:20000 - i * 1000}));
  it('reuses unexpired quotes per cart fingerprint, keeps the 10 cheapest services and refuses unknown destinations', async () => {
    await env.DB.exec("CREATE TABLE product_variants (id TEXT PRIMARY KEY, weight INTEGER, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER); INSERT INTO product_variants(id,weight) VALUES ('a', 100);");
    Object.assign(env,{RAJAONGKIR_API_KEY:'test',RAJAONGKIR_ORIGIN:'1',RAJAONGKIR_COURIERS:'jne'});
    const fetcher = vi.fn(async () => Response.json({meta:{code:200,status:'success'},data:tariffs}));
    vi.stubGlobal('fetch',fetcher);
    const quote = async (body: unknown) => (await handleIntegrationRequest(request('/api/shipping/quote',body),env))!;
    const first = await (await quote({destination:'2',items:[{variantId:'a',quantity:1}]})).json() as any;
    expect(first.quotes).toHaveLength(10);
    expect(first.quotes.map((q:any)=>q.amount)).toEqual([...first.quotes.map((q:any)=>q.amount)].sort((a:number,b:number)=>a-b));
    expect(first.quotes[0].amount).toBe(7000);
    expect(await env.DB.prepare('SELECT count(*) n FROM shipping_quotes').first('n')).toBe(10);
    const second = await (await quote({destination:'2',items:[{variantId:'a',quantity:1}]})).json() as any;
    expect(second.quotes.map((q:any)=>q.id).sort()).toEqual(first.quotes.map((q:any)=>q.id).sort());
    expect(fetcher).toHaveBeenCalledTimes(1);
    // A changed cart or nearly expired quotes go back to the provider.
    expect((await quote({destination:'2',items:[{variantId:'a',quantity:2}]})).status).toBe(200);
    await env.DB.prepare('UPDATE shipping_quotes SET expires_at=?').bind(Date.now() + 60000).run();
    expect((await quote({destination:'2',items:[{variantId:'a',quantity:1}]})).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(3);
    const unknown = await quote({destination:'999',items:[{variantId:'a',quantity:1}]});
    expect(unknown.status).toBe(400);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect((await quote({destination:'2',items:Array.from({length:31},()=>({variantId:'a',quantity:1}))})).status).toBe(400);
  });
  it('caches destination searches under a normalized internal key and remembers the destinations server-side', async () => {
    const store = new Map<string, Response>();
    vi.stubGlobal('caches', {default:{match:async (key: Request) => store.get(key.url)?.clone(), put:async (key: Request, response: Response) => { store.set(key.url, response.clone()); }}});
    const entry = {id:68513,label:'BALERAKSA, KARANGMONCOL, PURBALINGGA, JAWA TENGAH, 53355',province_name:'JAWA TENGAH',city_name:'PURBALINGGA',district_name:'KARANGMONCOL',subdistrict_name:'BALERAKSA',zip_code:'53355'};
    const fetcher = vi.fn(async (url: unknown) => { expect(new URL(String(url)).searchParams.get('search')).toBe('karang moncol'); return Response.json({meta:{code:200,status:'success'},data:[entry]}); });
    vi.stubGlobal('fetch',fetcher);
    const configured = {...env,RAJAONGKIR_API_KEY:'server-only-key'};
    const search = (term: string) => handleIntegrationRequest(request('/api/shipping/destinations',{search:term}),configured);
    const first = await search('  Karang   MONCOL ');
    expect(first?.headers.get('Cache-Control')).toBe('private, no-store');
    const result = await first!.json() as any;
    expect(await (await search('karang moncol'))!.json()).toEqual(result);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect([...store.keys()]).toEqual(['https://shop.example/__internal/shipping-destinations?q=karang%20moncol']);
    expect(store.values().next().value!.headers.get('Cache-Control')).toBe('public, max-age=86400');
    expect(await env.DB.prepare("SELECT label,city,district,postal_code FROM shipping_destinations WHERE id='68513'").first()).toEqual({label:entry.label,city:'PURBALINGGA',district:'KARANGMONCOL',postal_code:'53355'});
    // A cache hit still restores the server-side copy if D1 lost it.
    await env.DB.exec("DELETE FROM shipping_destinations WHERE id='68513'");
    await search('KARANG MONCOL');
    expect(await env.DB.prepare("SELECT count(*) n FROM shipping_destinations WHERE id='68513'").first('n')).toBe(1);
  });
  it('lets only owners manage roles and never leaves the installation without an owner', async () => {
    await env.DB.exec(readFileSync(new URL('../migrations/0001_commerce.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
    const owner = await identity('owner'), staff = await identity('staff'), other = await identity('other');
    expect((await handleIntegrationRequest(request('/api/setup',{secret},owner),env))?.status).toBe(200);
    const call = (method: string, path: string, cookie: string, body?: unknown) => handleIntegrationRequest(new Request(`https://shop.example${path}`,{method,headers:{Origin:'https://shop.example','Content-Type':'application/json',Cookie:cookie},...(body ? {body:JSON.stringify(body)} : {})}),env);
    expect(await (await call('GET','/api/admin/me',owner))!.json()).toEqual({user:{id:'owner',name:'owner',email:'owner@example.com'},role:'owner',areas:['owner','ops','catalog']});
    expect((await call('POST','/api/admin/roles',owner,{userId:'staff',role:'ops'}))?.status).toBe(200);
    expect((await call('POST','/api/admin/roles',owner,{userId:'staff',role:'superuser'}))?.status).toBe(400);
    expect(await (await call('GET','/api/admin/me',staff))!.json()).toMatchObject({role:'ops',areas:['ops']});
    expect((await call('GET','/api/admin/roles',staff))?.status).toBe(403);
    expect((await call('POST','/api/admin/roles',staff,{userId:'other',role:'owner'}))?.status).toBe(403);
    expect((await call('POST','/api/admin/roles',staff,{userId:'staff',role:'owner'}))?.status).toBe(403);
    // The only owner cannot demote themselves or be revoked.
    expect((await call('POST','/api/admin/roles',owner,{userId:'owner',role:'ops'}))?.status).toBe(409);
    expect((await call('DELETE','/api/admin/roles/owner',owner))?.status).toBe(409);
    expect((await call('POST','/api/admin/roles',owner,{userId:'other',role:'owner'}))?.status).toBe(200);
    expect((await call('POST','/api/admin/roles',other,{userId:'other',role:'catalog'}))?.status).toBe(200);
    expect((await call('POST','/api/admin/roles',other,{userId:'staff',role:'owner'}))?.status).toBe(403);
    expect((await call('DELETE','/api/admin/roles/owner',owner))?.status).toBe(409);
    expect((await call('DELETE','/api/admin/roles/other',owner))?.status).toBe(200);
    const list = await (await call('GET','/api/admin/roles',owner))!.json() as any;
    expect(list.admins.map((a:any)=>[a.userId,a.role,a.installationOwner])).toEqual([['owner','owner',true],['staff','ops',false]]);
    expect((await env.DB.prepare("SELECT action FROM audit_logs WHERE action LIKE 'role.%' ORDER BY rowid").all()).results.map(r=>r.action)).toEqual(['role.grant','role.grant','role.change','role.revoke']);
  });
  it('lists customers, revokes sessions immediately and bans customers but never administrators', async () => {
    await env.DB.exec(readFileSync(new URL('../migrations/0001_commerce.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
    const owner = await identity('owner'), shopper = await identity('shopper'), staff = await identity('staff');
    await env.DB.prepare("INSERT INTO admin_roles(user_id,granted_by,created_at,role) VALUES('owner','owner',1,'owner'),('staff','owner',1,'ops')").run();
    await env.DB.exec("INSERT INTO orders(id,reference,customer_id,total,contact_json,address_json,shipping_json,created_at) VALUES('o1','r1','shopper',1,'{}','{}','{}',1),('o2','r2','shopper',1,'{}','{}','{}',2)");
    const call = (path: string, cookie: string, body?: unknown) => handleIntegrationRequest(new Request(`https://shop.example${path}`,{method:body ? 'POST' : 'GET',headers:{Origin:'https://shop.example','Content-Type':'application/json',Cookie:cookie},...(body ? {body:JSON.stringify(body)} : {})}),env);
    const customers = await (await call('/api/admin/customers?limit=2',staff))!.json() as any;
    expect(customers.customers).toHaveLength(2); expect(customers.nextCursor).not.toBeNull();
    const all = await (await call('/api/admin/customers',staff))!.json() as any;
    expect(all.customers.find((c:any)=>c.id==='shopper')).toEqual({id:'shopper',name:'shopper',email:'shopper@example.com',createdAt:expect.any(Number),orders:2,banned:false,admin:false});
    expect(all.customers.find((c:any)=>c.id==='staff')).toMatchObject({admin:true});
    expect(await getCustomer(request('/x',undefined,shopper),env)).toEqual({id:'shopper'});
    expect(await (await call('/api/admin/users/shopper/revoke-sessions',staff,{}))!.json()).toEqual({ok:true,revoked:1});
    expect(await getCustomer(request('/x',undefined,shopper),env)).toBeNull();
    // Ops may not sign out an administrator; owners may.
    expect((await call('/api/admin/users/owner/revoke-sessions',staff,{}))?.status).toBe(403);
    expect((await call('/api/admin/users/missing/revoke-sessions',staff,{}))?.status).toBe(404);
    const again = await identity('shopper2');
    await env.DB.prepare("UPDATE session SET user_id='shopper' WHERE user_id='shopper2'").run();
    expect(await (await call('/api/admin/users/shopper/ban',staff,{banned:true}))!.json()).toEqual({ok:true,banned:true,changed:true});
    expect(await env.DB.prepare("SELECT count(*) n FROM session WHERE user_id='shopper'").first('n')).toBe(0);
    await env.DB.prepare("INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES ('fresh','token-shopper2','shopper',?,?,?)").bind(Date.now()+3600000,Date.now(),Date.now()).run();
    expect(await getCustomer(request('/x',undefined,again),env)).toBeNull();
    expect(await getCustomer(request('/x',undefined,again),env,{includeBanned:true})).toEqual({id:'shopper',banned:true});
    expect((await call('/api/admin/users/staff/ban',owner,{banned:true}))?.status).toBe(409);
    expect((await call('/api/admin/users/shopper/ban',staff,{banned:'yes'}))?.status).toBe(400);
    expect(await (await call('/api/admin/users/shopper/ban',staff,{banned:false}))!.json()).toEqual({ok:true,banned:false,changed:true});
    expect(await getCustomer(request('/x',undefined,again),env)).toEqual({id:'shopper'});
    expect((await env.DB.prepare("SELECT actor,action,target FROM audit_logs ORDER BY rowid").all()).results).toEqual([
      {actor:'staff',action:'user.revoke_sessions',target:'shopper'},{actor:'staff',action:'user.ban',target:'shopper'},{actor:'staff',action:'user.unban',target:'shopper'}]);
    await env.DB.prepare("UPDATE admin_roles SET role='catalog' WHERE user_id='staff'").run();
    expect((await call('/api/admin/customers',staff))?.status).toBe(403);
  });
  it('searches customers by name or email with escaped, bounded LIKE and keeps the cursor', async () => {
    await env.DB.exec(readFileSync(new URL('../migrations/0001_commerce.sql',import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
    const staff = await identity('staff');
    await env.DB.prepare("INSERT INTO admin_roles(user_id,granted_by,created_at,role) VALUES('staff','staff',1,'ops')").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u1','Budi Santoso','budi@toko.id',1,10,10),('u2','Sari','sari.budi@mail.id',1,20,20),('u3','Ani 100%','ani@mail.id',1,30,30),('u4','Anita','anita@mail.id',1,40,40)"),
    ]);
    const call = (query: string) => handleIntegrationRequest(new Request(`https://shop.example/api/admin/customers?${query}`,{headers:{Origin:'https://shop.example',Cookie:staff}}),env);
    const ids = async (query: string) => ((await (await call(query))!.json() as any).customers as any[]).map(c => c.id);
    expect(await ids('q=BUDI')).toEqual(['u2','u1']);
    expect(await ids('q=toko.id')).toEqual(['u1']);
    expect(await ids('q=100%25')).toEqual(['u3']);
    expect(await ids('q=%25')).toEqual(['u3']);
    expect(await ids('q=ani_')).toEqual([]);
    expect(await ids('q=%20%20')).toEqual(['staff','u4','u3','u2','u1']);
    const first = await (await call('q=an&limit=1'))!.json() as any;
    expect(first.customers.map((c: any) => c.id)).toEqual(['u4']);
    expect(await ids(`q=an&limit=1&before=${first.nextCursor.before}&beforeId=${first.nextCursor.beforeId}`)).toEqual(['u3']);
    expect((await call(`q=${'x'.repeat(61)}`))?.status).toBe(400);
    // D1 caps a LIKE pattern at 50 bytes; longer (or escape-expanded) terms are a 400, not a D1 error.
    expect((await call(`q=${'x'.repeat(48)}`))?.status).toBe(200);
    expect((await call(`q=${'x'.repeat(49)}`))?.status).toBe(400);
    expect((await call(`q=${'%'.repeat(25)}`))?.status).toBe(400);
  });
  it('refuses development login on a non-local HTTPS origin without the remote opt-in', async () => {
    const dev = {...env, APP_ENV:'development', DEV_LOGIN_ENABLED:'true', GOOGLE_CLIENT_ID:undefined, GOOGLE_CLIENT_SECRET:undefined};
    const { devLoginEnabled } = await import('../src/integrations/auth');
    expect(devLoginEnabled(dev)).toBe(false);
    expect(devLoginEnabled({...dev, DEV_LOGIN_ALLOW_REMOTE:'true'})).toBe(true);
    for (const origin of ['http://localhost:8787','https://localhost:8787','https://127.0.0.1','http://192.168.1.5:8787']) expect(devLoginEnabled({...dev, PUBLIC_ORIGIN:origin})).toBe(true);
    expect(devLoginEnabled({...dev, APP_ENV:'production', DEV_LOGIN_ALLOW_REMOTE:'true'})).toBe(false);
    expect((await handleIntegrationRequest(request('/api/auth/development-login',{}),dev))?.status).not.toBe(200);
  });
  it('fails the deploy guard for dev login on a public HTTPS origin', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
    const run = (vars: Record<string, string>) => {
      const file = join(dir, `${Object.values(vars).join('-').replace(/\W/g,'')}.json`);
      writeFileSync(file, JSON.stringify({vars}));
      try { execFileSync(process.execPath, ['scripts/deploy-guard.mjs', file], {stdio:'pipe'}); return 0; } catch (error: any) { return error.status as number; }
    };
    expect(run({PUBLIC_ORIGIN:'https://shop.example', DEV_LOGIN_ENABLED:'true'})).toBe(1);
    expect(run({PUBLIC_ORIGIN:'https://shop.example'})).toBe(0);
    expect(run({PUBLIC_ORIGIN:'http://localhost:8787', DEV_LOGIN_ENABLED:'true'})).toBe(0);
    for (const appEnv of ['production','staging','development']) expect(run({PUBLIC_ORIGIN:'https://shop.example', APP_ENV:appEnv})).toBe(0);
    expect(run({PUBLIC_ORIGIN:'https://shop.example', APP_ENV:'prod'})).toBe(1);
    expect(run({PUBLIC_ORIGIN:'https://flaremmerce-staging.example.workers.dev', APP_ENV:'staging', DEV_LOGIN_ENABLED:'true'})).toBe(1);
    expect(run({PUBLIC_ORIGIN:'https://shop.example', STAGING_LOGIN_SECRET:'x'.repeat(40)})).toBe(1);
  });
  it('refuses a placeholder origin or a non-staging build only when deploying', async () => {
    const { execFileSync } = await import('node:child_process');
    const { mkdtempSync, writeFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = mkdtempSync(join(tmpdir(), 'deploy-guard-'));
    const run = (config: unknown, ...flags: string[]) => {
      const file = join(dir, `${crypto.randomUUID()}.json`);
      writeFileSync(file, JSON.stringify(config));
      try { execFileSync(process.execPath, ['scripts/deploy-guard.mjs', file, ...flags], {stdio:'pipe'}); return 0; } catch (error: any) { return error.status as number; }
    };
    const placeholder = {targetEnvironment:'staging', vars:{APP_ENV:'staging', PUBLIC_ORIGIN:'https://flaremmerce-staging.REPLACE.workers.dev'}};
    const staging = {targetEnvironment:'staging', vars:{APP_ENV:'staging', PUBLIC_ORIGIN:'https://flaremmerce-staging.team.workers.dev'}};
    const local = {vars:{PUBLIC_ORIGIN:'http://localhost:8787'}};
    expect(run(placeholder)).toBe(0);
    expect(run(placeholder, '--deploy')).toBe(1);
    expect(run(staging, '--deploy', '--staging')).toBe(0);
    expect(run(local, '--deploy')).toBe(0);
    expect(run(local, '--deploy', '--staging')).toBe(1);
    expect(run({...staging, targetEnvironment:undefined}, '--deploy', '--staging')).toBe(1);
  });
});

describe('phase 3 integration features', () => {
  const call = (path: string, cookie: string | undefined, method = 'GET', body?: unknown, originHeader = 'https://shop.example') => handleIntegrationRequest(new Request(`https://shop.example${path}`, {method, headers:{Origin:originHeader, 'Content-Type':'application/json', ...(cookie ? {Cookie:cookie} : {})}, ...(body === undefined ? {} : {body:JSON.stringify(body)})}), env);
  const entry = (n: number) => ({label:`Alamat ${n}`, name:'Penerima', phone:'0812 3456 7890', line:`Jl. Mawar ${n}`, destination:'2'});
  it('keeps an owner-scoped address book of at most five server-validated addresses', async () => {
    const alice = await identity('alice'), bob = await identity('bob');
    expect((await call('/api/account/addresses', undefined))?.status).toBe(401);
    expect((await call('/api/account/addresses', alice, 'POST', entry(1), 'https://evil.example'))?.status).toBe(403);
    const created = await call('/api/account/addresses', alice, 'POST', entry(1));
    expect(created?.status).toBe(200);
    expect(created?.headers.get('Cache-Control')).toBe('private, no-store');
    const {address} = await created!.json() as any;
    expect(address).toMatchObject({label:'Alamat 1', phone:'+6281234567890', line:'Jl. Mawar 1', destination:'2', destinationLabel:'MENTENG, JAKARTA PUSAT, DKI JAKARTA, 10310', postalCode:'10310', city:'JAKARTA PUSAT'});
    for (const invalid of [{...entry(2), destination:'999'}, {...entry(2), phone:'12345'}, {...entry(2), label:''}, {...entry(2), extra:1}, {...entry(2), line:'x'.repeat(501)}]) expect((await call('/api/account/addresses', alice, 'POST', invalid))?.status).toBe(400);
    for (let n = 2; n <= 5; n++) expect((await call('/api/account/addresses', alice, 'POST', entry(n)))?.status).toBe(200);
    const full = await call('/api/account/addresses', alice, 'POST', entry(6));
    expect(full?.status).toBe(409);
    expect(await full!.json()).toEqual({error:'Maksimal 5 alamat tersimpan'});
    await expect(env.DB.prepare("INSERT INTO customer_addresses(id,user_id,label,name,phone,line,destination,created_at,updated_at) VALUES('x','alice','l','n','p','l','2',0,0)").run()).rejects.toThrow('address_limit');
    expect(((await (await call('/api/account/addresses', bob))!.json()) as any).addresses).toEqual([]);
    const path = `/api/account/addresses/${address.id}`;
    expect((await call(path, bob, 'PATCH', {line:'Jl. Curian'}))?.status).toBe(404);
    expect((await call(path, bob, 'DELETE'))?.status).toBe(404);
    const patched = await (await call(path, alice, 'PATCH', {line:'Jl. Melati 9'}))!.json() as any;
    expect(patched.address).toMatchObject({line:'Jl. Melati 9', label:'Alamat 1', phone:'+6281234567890'});
    expect((await call(path, alice, 'PATCH', {}))?.status).toBe(400);
    expect((await call(path, alice, 'DELETE'))?.status).toBe(200);
    expect(((await (await call('/api/account/addresses', alice))!.json()) as any).addresses).toHaveLength(4);
    expect((await call('/api/account/addresses/not-a-uuid', alice, 'DELETE'))?.status).toBe(404);
    await env.DB.prepare('DELETE FROM session WHERE user_id=?').bind('alice').run();
    expect((await call('/api/account/addresses', alice))?.status).toBe(401);
  });
  it('deletes expired quotes, sessions and verifications in bounded batches', async () => {
    const now = Date.now(), old = now - 2 * 3_600_000;
    await env.DB.exec(`INSERT INTO shipping_quotes VALUES ('old','f','2','REG',1,1,${old},'{}'),('soon','f','2','REG',1,1,${now - 60000},'{}'),('live','f','2','REG',1,1,${now + 60000},'{}')`);
    await env.DB.exec(`INSERT INTO user (id,name,email,email_verified,created_at,updated_at) VALUES ('u','u','u@example.com',1,${now},${now})`);
    const sessions = Array.from({length:205}, (_, i) => env.DB.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind(`s${i}`, `t${i}`, 'u', now - 1000, now, now));
    await env.DB.batch([...sessions, env.DB.prepare('INSERT INTO session (id,token,user_id,expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?)').bind('live', 'tl', 'u', now + 3600000, now, now)]);
    await env.DB.exec(`INSERT INTO verification (id,identifier,value,expires_at,created_at,updated_at) VALUES ('v1','i','x',${now - 1},${now},${now}),('v2','i','x',${now + 60000},${now},${now})`);
    await integrationRetention(env);
    expect((await env.DB.prepare('SELECT id FROM shipping_quotes ORDER BY id').all()).results.map((r: any) => r.id)).toEqual(['live', 'soon']);
    expect(await env.DB.prepare('SELECT count(*) n FROM session').first('n')).toBe(6);
    expect((await env.DB.prepare('SELECT id FROM verification').all()).results).toEqual([{id:'v2'}]);
    await integrationRetention(env);
    expect((await env.DB.prepare('SELECT id FROM session').all()).results).toEqual([{id:'live'}]);
  });
  it('bills volumetric weight in quotes and refuses carts over MAX_CART_WEIGHT_G', async () => {
    await env.DB.exec("CREATE TABLE product_variants (id TEXT PRIMARY KEY, weight INTEGER, length_cm INTEGER, width_cm INTEGER, height_cm INTEGER); INSERT INTO product_variants VALUES ('box', 200, 30, 30, 10), ('flat', 200, 30, 30, NULL);");
    Object.assign(env,{RAJAONGKIR_API_KEY:'test',RAJAONGKIR_ORIGIN:'1',RAJAONGKIR_COURIERS:'jne'});
    const weights: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init: any) => { weights.push(init.body.get('weight')); return Response.json({meta:{code:200,status:'success'},data:[{code:'jne',service:'REG',cost:12000}]}); }));
    expect((await handleIntegrationRequest(request('/api/shipping/quote',{destination:'2',items:[{variantId:'box',quantity:2},{variantId:'flat',quantity:1}]}),env))?.status).toBe(200);
    expect(weights).toEqual(['3200']);
    const refused = await handleIntegrationRequest(request('/api/shipping/quote',{destination:'2',items:[{variantId:'box',quantity:2}]}),{...env, MAX_CART_WEIGHT_G:'2999'});
    expect(refused?.status).toBe(400);
    expect(await refused!.json()).toEqual({error:'Berat total melebihi batas 2,999 kg per pesanan'});
  });
});
