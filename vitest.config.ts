import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  resolve: { alias: { "@": fileURLToPath(new URL("./", import.meta.url)) } },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Live provider tests hit real APIs and need their own config: `npm run test:live`.
    exclude: ["tests/live/**", "node_modules/**"],
  },
});
