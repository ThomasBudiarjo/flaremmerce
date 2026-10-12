import { defineConfig } from "astro/config";
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
export default defineConfig({
  output: "server",
  adapter: cloudflare({ configPath: "../../wrangler.jsonc", imageService: "passthrough" }),
  integrations: [react()],
  // Astro sessions are never used. Better Auth owns durable D1 sessions.
  // Avoid the adapter's automatic, unused SESSION KV dependency.
  session: false,
});
