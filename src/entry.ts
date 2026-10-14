import api, { type Env } from './worker';
import { handle } from '@astrojs/cloudflare/handler';
import { catalogParams, publicCacheKey } from './shared';
import { withAdminHeaders, withStorefrontHeaders } from './headers';

export default {
  ...api,
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return api.fetch(request, env, ctx);
    if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
      const asset = new URL(request.url);
      if (!url.pathname.includes('.') || url.pathname.endsWith('/')) asset.pathname = '/admin/';
      return withAdminHeaders(await env.ASSETS.fetch(new Request(asset, request)), env.MEDIA_ORIGIN);
    }
    const publicPage = request.method === 'GET' && (url.pathname === '/' || url.pathname === '/catalog' || /^\/products\/[a-z0-9-]{1,100}$/.test(url.pathname));
    const key = publicPage ? publicCacheKey(url, url.pathname === '/' || url.pathname === '/catalog' ? catalogParams : {}) : null;
    if (key) {
      const cached = await caches.default.match(key);
      if (cached) {
        const headers = new Headers(cached.headers);
        headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
        return new Response(cached.body, {status:cached.status, headers});
      }
    }
    const response: Response = await handle(request, env, ctx);
    const { body, headers } = await withStorefrontHeaders(response, env.MEDIA_ORIGIN);
    if (key && response.ok && !headers.has('Set-Cookie')) {
      headers.set('Cache-Control', 'public, max-age=0, s-maxage=60');
      const result = new Response(body, {status:response.status, headers});
      const cachedHeaders = new Headers(headers); cachedHeaders.set('Cache-Control', 'public, max-age=60');
      ctx.waitUntil(caches.default.put(key, new Response(result.clone().body, {headers:cachedHeaders})).catch(() => {}));
      return result;
    }
    headers.set('Cache-Control', 'private, no-store');
    return new Response(body, {status:response.status, headers});
  },
} satisfies ExportedHandler<Env, {outboxId:string}>;
