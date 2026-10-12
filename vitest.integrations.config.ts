import { defineConfig } from 'vitest/config';
export default defineConfig({test:{include:['tests/integrations.test.ts','tests/storage.test.ts','tests/checkout.test.ts'], testTimeout:30000, hookTimeout:30000}});
