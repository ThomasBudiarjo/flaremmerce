import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
export default defineConfig({
  plugins: [cloudflareTest({miniflare: {
      compatibilityDate: '2026-08-06',
      compatibilityFlags: ['nodejs_compat'],
      d1Databases: ['DB'],
  }})],
  test: {include: ['tests/commerce.test.ts']},
});
