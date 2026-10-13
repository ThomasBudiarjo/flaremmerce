import { defineConfig } from 'vitest/config';
export default defineConfig({
  resolve: { alias: { '@': new URL('./apps/admin/src', import.meta.url).pathname } },
  oxc: { jsx: { runtime: 'automatic' } },
  test:{include:['tests/integrations.test.ts','tests/storage.test.ts','tests/checkout.test.ts','tests/ui.test.tsx'], testTimeout:30000, hookTimeout:30000},
});
