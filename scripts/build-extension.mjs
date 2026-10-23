// Bundles the VS Code extension (adapter + the shared engines) into one CommonJS file.
// `vscode` is provided by the editor at run time, so it stays external.
import { build } from "esbuild";

await build({
  entryPoints: ["extensions/vscode/src/extension.ts"],
  outfile: "extensions/vscode/dist/extension.js",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode"],
  sourcemap: true,
  logLevel: "warning",
});
