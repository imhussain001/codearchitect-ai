import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

/**
 * Live provider tests: real network calls to real models (opt-in, `npm run test:live`).
 * `server-only` is provided by Next.js at build time; outside Next it is stubbed.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./", import.meta.url)),
      "server-only": fileURLToPath(new URL("./tests/live/serverOnlyStub.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/live/**/*.live.test.ts"],
    // Free tiers rate-limit hard; run strictly one request at a time.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 300_000,
  },
});
