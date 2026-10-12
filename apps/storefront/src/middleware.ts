import { defineMiddleware } from 'astro:middleware';
import { env } from 'cloudflare:workers';
import worker, { type Env } from '../../../src/worker';

export const onRequest = defineMiddleware((context, next) => {
  // Direct in-process API call: no separate service or recursive public fetch.
  (context.locals as any).catalog = (path: string) => worker.fetch(
    new Request(new URL(path, context.url.origin)), env as unknown as Env,
    context.locals.cfContext,
  );
  return next();
});
