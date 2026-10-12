import api, { type Env } from './worker';
import { handle } from '@astrojs/cloudflare/handler';

export default {
  ...api,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api.fetch(request, env, ctx);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const asset = new URL(request.url);
      if (!url.pathname.includes('.') || url.pathname.endsWith('/')) asset.pathname = '/admin/';
      return env.ASSETS.fetch(new Request(asset, request));
    }
    const publicPage = request.method === 'GET' && (url.pathname === '/' || url.pathname === '/catalog' || /^\/products\/[a-z0-9-]{1,100}$/.test(url.pathname));
    const cacheUrl = new URL(`${url.origin}${url.pathname}`);
    if (url.pathname === '/' || url.pathname === '/catalog') for (const name of ['after','limit']) {
      const value = url.searchParams.get(name); if (value !== null) cacheUrl.searchParams.set(name,value);
    }
    const key = new Request(cacheUrl);
    if (publicPage) {
      const cached = await caches.default.match(key);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
        return new Response(cached.body, {status:cached.status, headers});
      }
    }
    const response: Response = await handle(request, env, ctx);
    const headers = new Headers(response.headers);
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('X-Content-Type-Options', 'nosniff');
    if (publicPage && response.ok && !headers.has('Set-Cookie')) {
      headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
      const result = new Response(response.body, {status:response.status, headers});
      const cachedHeaders = new Headers(headers); cachedHeaders.set('Cache-Control', 'public, max-age=60');
      ctx.waitUntil(caches.default.put(key, new Response(result.clone().body, {headers:cachedHeaders})).catch(() => {}));
      return result;
    }
    headers.set('Cache-Control', 'private, no-store');
    return new Response(response.body, {status:response.status, headers});
  },
} satisfies ExportedHandler<Env, {outboxId:string}>;
