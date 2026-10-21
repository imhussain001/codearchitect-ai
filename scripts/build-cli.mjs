// Bundles the CLI (TypeScript + the shared engines) into one dependency-free file.
// esbuild reads tsconfig `paths`, so the `@/` imports in lib/ resolve without extra config.
import { build } from "esbuild";

await build({
  entryPoints: ["scripts/cli/main.ts"],
  outfile: "dist/cli/codearchitect.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  logLevel: "warning",
});
