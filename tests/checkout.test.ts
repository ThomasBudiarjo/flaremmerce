import { it, expect, vi } from 'vitest';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { readFileSync } from 'node:fs';
import { createHmac, createHash } from 'node:crypto';
import worker, { type Env } from '../src/worker';

it('guest checkout crosses real shipping, Turnstile, DOKU, D1 and private order boundaries', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response("ok")}}',compatibilityDate:'2026-08-06',d1Databases:['DB']}));
  try {
    const DB = await mf.getD1Database('DB');
    for (const migration of ['0001_commerce','0002_integrations']) await DB.exec(readFileSync(new URL(`../migrations/${migration}.sql`,import.meta.url),'utf8').replace(/--[^\n]*/g,'').replace(/\s+/g,' '));
    await DB.exec("INSERT INTO products(id,slug,name) VALUES('p','test-product','Product'); INSERT INTO product_variants(id,product_id,sku,name,price,weight) VALUES('v','p','TEST','Default',189000,350); INSERT INTO inventory(variant_id,on_hand) VALUES('v',2);");
    const env = {DB,PUBLIC_ORIGIN:'https://shop.example',TURNSTILE_SECRET_KEY:'fixture-key',DOKU_CLIENT_ID:'MCH-fixture',DOKU_SECRET_KEY:'test-merchant-secret',RAJAONGKIR_API_KEY:'fixture-key',RAJAONGKIR_ORIGIN:'1',RAJAONGKIR_COURIERS:'jne'} as unknown as Env;
    let paymentCreates = 0;
    vi.spyOn(globalThis,'fetch').mockImplementation(async (input, init) => {
      const request = new Request(input,init);
      if (request.url.includes('/domestic-cost')) return Response.json({meta:{code:200,status:'success'},data:[{code:'jne',service:'REG',cost:12000}]});
      if (request.url.includes('/siteverify')) return Response.json({success:true,hostname:'shop.example',action:'checkout'});
      if (request.url.endsWith('/checkout/v1/payment')) {
        paymentCreates++;
        const body = await request.json() as any;
        expect(body.order.amount).toBe(201000);
        expect(body.order.invoice_number.length).toBeLessThanOrEqual(30);
        expect(body.order.callback_url).toMatch(/^https:\/\/shop.example\/order\?reference=/);
        return Response.json({response:{order:body.order,payment:{url:'https://sandbox.doku.com/payment'}}});
      }
      throw new Error('Unexpected provider request');
    });
    const call = (path:string,input?:unknown,cookie?:string,headers:Record<string,string>={}) => worker.fetch(new Request(`https://shop.example${path}`,{method:input ? 'POST':'GET',headers:{Origin:env.PUBLIC_ORIGIN,'Content-Type':'application/json',...(cookie ? {Cookie:cookie}:{}),...headers},...(input ? {body:JSON.stringify(input)}:{})}),env);
    const quotes = await (await call('/api/shipping/quote',{destination:'2',items:[{variantId:'v',quantity:1}]})).json() as any;
    const payload = {items:[{variantId:'v',quantity:1}],shippingQuoteId:quotes.quotes[0].id,contact:{name:'Fixture',email:'fixture@example.com',phone:'08123456'},address:{line:'Synthetic address',city:'Jakarta',postalCode:'12345',destination:'2'},expectedTotal:201000,idempotencyKey:'same-checkout-key',turnstileToken:'fixture-token'};
    const scope = await call('/api/checkout',payload);
    expect(scope.status).toBe(428);
    const cookie = scope.headers.get('Set-Cookie')!.split(';')[0];
    await DB.exec("INSERT INTO product_variants(id,product_id,sku,name,price,weight) VALUES('other','p','OTHER','Other',189000,350); INSERT INTO inventory(variant_id,on_hand) VALUES('other',2);");
    expect((await call('/api/checkout',{...payload,items:[{variantId:'other',quantity:1}],idempotencyKey:'changed-cart-key'},cookie)).status).toBe(409);
    const response = await call('/api/checkout',payload,cookie);
    expect(response.status).toBe(200);
    const result = await response.json() as any;
    expect(result.paymentUrl).toBe('https://sandbox.doku.com/payment');
    expect(result.order.status).toBe('pending_payment');
    const retry = await (await call('/api/checkout',{...payload,turnstileToken:'new-fixture-token'},cookie)).json() as any;
    expect(retry.order).toEqual(result.order); expect(paymentCreates).toBe(1);
    expect((await call(`/api/orders/${result.order.reference}`)).status).toBe(404);
    const raw = JSON.stringify({order:{invoice_number:result.order.reference,amount:201000,currency:'IDR'},transaction:{status:'SUCCESS',type:'SALE',original_request_id:result.order.reference}});
    const timestamp = '2026-10-12T01:02:03Z', id = 'notification-fixture';
    const components = `Client-Id:MCH-fixture\nRequest-Id:${id}\nRequest-Timestamp:${timestamp}\nRequest-Target:/api/payments/webhook\nDigest:${createHash('sha256').update(raw).digest('base64')}`;
    const signature = `HMACSHA256=${createHmac('sha256',env.DOKU_SECRET_KEY!).update(components).digest('base64')}`;
    const notify = () => worker.fetch(new Request('https://shop.example/api/payments/webhook',{method:'POST',body:raw,headers:{'Client-Id':'MCH-fixture','Request-Id':id,'Request-Timestamp':timestamp,Signature:signature}}),env);
    expect((await notify()).status).toBe(200); expect((await notify()).status).toBe(200);
    const read = await call(`/api/orders/${result.order.reference}`,undefined,undefined,{'X-Order-Token':result.order.guestToken});
    expect(read.headers.get('Cache-Control')).toContain('no-store');
    expect((await read.json() as any).order.status).toBe('paid');
    expect(await DB.prepare("SELECT on_hand,reserved FROM inventory WHERE variant_id='v'").first()).toEqual({on_hand:1,reserved:0});
    expect(await DB.prepare('SELECT count(*) n FROM outbox_events').first('n')).toBe(1);
  } finally {vi.restoreAllMocks();vi.unstubAllGlobals();await mf.dispose();}
});
