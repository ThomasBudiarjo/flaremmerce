declare module 'cloudflare:workers' {
  export const env: import('../../../src/worker').Env;
}
interface ImportMetaEnv {
  readonly FLAREMMERCE_STAGING: boolean;
}
