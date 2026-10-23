// Writes THIRD_PARTY_NOTICES.md (this repository) and extensions/vscode/THIRD_PARTY_NOTICES.md
// (what the packaged extension bundles). Run with `npm run notices` after changing dependencies.
//
// Licenses are read from each installed package's own package.json, so the lists cannot drift from
// what is actually installed or bundled.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(".");

function readPackage(dir) {
  const file = join(dir, "package.json");
  if (!existsSync(file)) return null;
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const license = typeof pkg.license === "string" ? pkg.license : (pkg.license?.type ?? (pkg.licenses ? pkg.licenses.map((l) => l.type).join(" OR ") : "UNKNOWN"));
  const repository = typeof pkg.repository === "string" ? pkg.repository : (pkg.repository?.url ?? pkg.homepage ?? "");
  return { name: pkg.name, version: pkg.version, license, repository: repository.replace(/^git\+/, "").replace(/\.git$/, "") };
}

const row = (p) => `| ${p.name} | ${p.version} | ${p.license} | ${p.repository || "-"} |`;
const table = (list) => ["| Package | Version | License | Source |", "|---|---|---|---|", ...list.sort((a, b) => a.name.localeCompare(b.name)).map(row)].join("\n");

/** Notes about specific packages; the generic closing line is always included. */
const PACKAGE_NOTES = [
  ["jszip", "**jszip** is offered under `MIT OR GPL-3.0-or-later`; this project uses it under the **MIT** license."],
  ["caniuse-lite", "**caniuse-lite** (a data package used at build time by the CSS tooling) is licensed CC-BY-4.0: data derived from caniuse.com, copyright Alexis Deveria and contributors."],
  ["sharp", "**sharp** (installed as an optional dependency of Next.js, for image optimization) ships prebuilt libvips binaries under LGPL-3.0-or-later. They are installed by `npm install` and are not part of this repository or of the VS Code extension."],
];
const CLOSING = "Each package listed is the property of its authors and is used under its own license. This file lists them to meet their attribution requirements; it is not a substitute for their license texts, which ship inside each package.";
const notesFor = (names) => ["## Notes", "", ...PACKAGE_NOTES.filter(([pkg]) => names.has(pkg)).map(([, text]) => "- " + text), "- " + CLOSING, ""].join("\n");

// ---------- Repository ----------
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const direct = Object.keys(pkg.dependencies ?? {}).map((name) => readPackage(join(root, "node_modules", name))).filter(Boolean);

const all = execSync("npm ls --omit=dev --all --parseable", { encoding: "utf8", maxBuffer: 1 << 28 })
  .split("\n")
  .filter(Boolean)
  .map((p) => readPackage(p))
  .filter((p) => p && p.name !== pkg.name);
const unique = new Map(all.map((p) => [`${p.name}@${p.version}`, p]));
const counts = {};
for (const p of unique.values()) counts[p.license] = (counts[p.license] ?? 0) + 1;
const summary = Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([license, n]) => `| ${license} | ${n} |`);

writeFileSync(
  "THIRD_PARTY_NOTICES.md",
  `# Third-party notices

CodeArchitect AI is Copyright 2026 Hussain Tak and licensed under the Apache License 2.0 (see LICENSE and NOTICE). It depends on the open-source packages below, each under its own license.

## Direct production dependencies

${table(direct)}

## All production dependencies, by license

${unique.size} packages in total (direct and transitive).

| License | Packages |
|---|---|
${summary.join("\n")}

${notesFor(new Set([...unique.values()].map((p) => p.name)))}`,
);

// ---------- VS Code extension: what the bundle contains ----------
const result = await build({
  entryPoints: ["extensions/vscode/src/extension.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["vscode"],
  write: false,
  metafile: true,
  logLevel: "silent",
});
const bundled = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  const m = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split("\\").join("/"));
  if (!m) continue;
  const p = readPackage(join(root, "node_modules", m[1]));
  if (p) bundled.set(p.name, p);
}

writeFileSync(
  "extensions/vscode/THIRD_PARTY_NOTICES.md",
  `# Third-party notices

CodeArchitect: Blast Radius is Copyright 2026 Hussain Tak and licensed under the Apache License 2.0 (see LICENSE and NOTICE). Its bundled file \`dist/extension.js\` includes the following open-source packages, each under its own license.

${bundled.size === 0 ? "The bundle contains no third-party packages: it is built only from this project's own source." : table([...bundled.values()])}

${notesFor(new Set(bundled.keys()))}`,
);

console.log(`THIRD_PARTY_NOTICES.md: ${direct.length} direct, ${unique.size} total packages; extension bundle: ${bundled.size} packages.`);
