import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [cloudflareTest({miniflare: {
      compatibilityDate: '2026-08-06',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
      // Real workerd rate limiters: generous ones for the suite, a tight one to observe a 429.
      ratelimits: {
        RL_CHECKOUT: {namespace_id: '1001', simple: {limit: 100000, period: 60}},
        RL_QUOTE: {namespace_id: '1002', simple: {limit: 100000, period: 60}},
        RL_LOOKUP: {namespace_id: '1003', simple: {limit: 100000, period: 60}},
        RL_AUTH: {namespace_id: '1004', simple: {limit: 100000, period: 60}},
        RL_TIGHT: {namespace_id: '1005', simple: {limit: 2, period: 60}},
      },
  }})],
  test: {include: ['tests/commerce.test.ts']},
});
