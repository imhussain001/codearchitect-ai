import { describe, expect, it } from "vitest";
import { analyzeChangedSymbols } from "@/lib/engines/changedSymbols";
import { declarationSpans, spanAt } from "@/lib/engines/declarations";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { compareSnapshots, comparisonToJson, evaluateCheck, renderMarkdown, takeSnapshot } from "@/lib/report";

const file = (path: string, content: string) => ({ path, content });

describe("declaration spans", () => {
  it("runs each span to the next declaration and leaves the preamble unowned", () => {
    const src = `import x from "x";\nconst K = 1;\nexport function a() {\n  return 1;\n}\n\nexport function b() {\n  return 2;\n}\n`;
    const spans = declarationSpans(src, ["a", "b"]);
    expect(spans.map((s) => [s.name, s.start, s.end])).toEqual([["a", 2, 6], ["b", 6, 10]]);
    expect(spanAt(spans, 0)).toBeUndefined();
    expect(spanAt(spans, 3)).toBe("a");
    expect(spanAt(spans, 7)).toBe("b");
  });
});

const BASE = `import { dep } from "./dep";

export function verifyToken(t: string) {
  return !!t;
}

export function issueToken() {
  return "x";
}

export const MAX = 3;
`;

describe("analyzeChangedSymbols", () => {
  const change = (after: string) => analyzeChangedSymbols([file("src/auth.ts", BASE)], [file("src/auth.ts", after)], ["src/auth.ts"]);

  it("names the export whose body changed and no other", () => {
    const [c] = change(BASE.replace("return !!t;", "return t.length > 3;"));
    expect(c).toEqual({ path: "src/auth.ts", modified: ["verifyToken"], added: [], removed: [], precise: true });
  });

  it("reports added and removed exports", () => {
    const [c] = change(BASE.replace("export const MAX = 3;", "export const LIMIT = 3;"));
    expect(c!.added).toEqual(["LIMIT"]);
    expect(c!.removed).toEqual(["MAX"]);
  });

  it("treats an import-only edit as neutral: nothing is reported", () => {
    expect(change(BASE.replace('import { dep } from "./dep";', 'import { dep, other } from "./dep";'))).toEqual([]);
  });

  it("ignores blank-line changes", () => {
    expect(change(BASE.replace("\n\nexport function issueToken", "\n\n\n\nexport function issueToken"))).toEqual([]);
  });

  it("marks a change outside every export (module-level code) as imprecise", () => {
    const [c] = change(BASE.replace('import { dep } from "./dep";', 'import { dep } from "./dep";\nconst CONFIG = load();'));
    expect(c!.precise).toBe(false);
  });

  it("attributes a signature change to the right export", () => {
    const [c] = change(BASE.replace("export function issueToken() {", "export function issueToken(ttl: number) {"));
    expect(c!.modified).toEqual(["issueToken"]);
  });

  it("handles a new file and a deleted file", () => {
    expect(analyzeChangedSymbols([], [file("src/new.ts", "export function a() {}\n")], ["src/new.ts"])).toEqual([{ path: "src/new.ts", modified: [], added: ["a"], removed: [], precise: true }]);
    expect(analyzeChangedSymbols([file("src/old.ts", "export function a() {}\nexport const b = 1;\n")], [], ["src/old.ts"])).toEqual([{ path: "src/old.ts", modified: [], added: [], removed: ["a", "b"], precise: true }]);
  });

  it("works for Python, Go and Rust", () => {
    const py = analyzeChangedSymbols([file("a.py", "import os\n\ndef one():\n    return 1\n\ndef two():\n    return 2\n")], [file("a.py", "import os\n\ndef one():\n    return 1\n\ndef two():\n    return 3\n")], ["a.py"]);
    expect(py[0]!.modified).toEqual(["two"]);
    const go = analyzeChangedSymbols([file("a.go", "package a\n\nfunc One() int {\n\treturn 1\n}\n\nfunc Two() int {\n\treturn 2\n}\n")], [file("a.go", "package a\n\nfunc One() int {\n\treturn 9\n}\n\nfunc Two() int {\n\treturn 2\n}\n")], ["a.go"]);
    expect(go[0]!.modified).toEqual(["One"]);
    const rs = analyzeChangedSymbols([file("src/a.rs", "pub fn one() -> u8 {\n    1\n}\n\npub fn two() -> u8 {\n    2\n}\n")], [file("src/a.rs", "pub fn one() -> u8 {\n    1\n}\n\npub fn two() -> u8 {\n    5\n}\n")], ["src/a.rs"]);
    expect(rs[0]!.modified).toEqual(["two"]);
  });

  it("skips files with no supported language", () => {
    expect(analyzeChangedSymbols([file("README.md", "a")], [file("README.md", "b")], ["README.md"])).toEqual([]);
  });
});

/** A small project: auth.ts exports three names; session uses verifyToken, login uses issueToken, page uses both. */
const project = (auth: string, extra: Array<{ path: string; content: string }> = []) => [
  file("src/auth.ts", auth),
  file("src/session.ts", `import { verifyToken } from "./auth";\nexport const session = () => verifyToken("a");\n`),
  file("src/login.ts", `import { issueToken } from "./auth";\nexport const login = () => issueToken();\n`),
  file("src/page.ts", `import { verifyToken, issueToken } from "./auth";\nexport const page = () => [verifyToken("a"), issueToken()];\n`),
  file("src/other.ts", `import { MAX } from "./auth";\nexport const other = () => MAX;\n`),
  ...extra,
];

describe("pull-request report with symbol impact", () => {
  const run = (afterAuth: string, extra: Array<{ path: string; content: string }> = [], changed = ["src/auth.ts"]) => {
    const baseFiles = project(BASE);
    const headFiles = project(afterAuth, extra);
    const base = takeSnapshot(buildHeuristicGraph("p", baseFiles));
    const head = takeSnapshot(buildHeuristicGraph("p", headFiles));
    const comparison = compareSnapshots(base, head, changed, analyzeChangedSymbols(baseFiles, headFiles, changed));
    return { comparison, markdown: renderMarkdown(comparison, evaluateCheck(comparison)) };
  };

  it("splits the direct importers into those that use the changed export and those that do not", () => {
    const { comparison, markdown } = run(BASE.replace("return !!t;", "return t.length > 3;"));
    const [impact] = comparison.symbolImpact;
    expect(impact!.modified).toEqual(["verifyToken"]);
    expect(impact!.affected.map((a) => a.label).sort()).toEqual(["Session", "Src/Page"]);
    expect(impact!.spared.sort()).toEqual(["Login", "Other"]);
    expect(markdown).toContain("**Changed exports**");
    expect(markdown).toContain("modified `verifyToken`");
    expect(markdown).toContain("**2** files use the changed names");
    expect(markdown).toContain("**2** other files import it but none of those names");
  });

  it("does not narrow when part of the change is outside any export", () => {
    const { comparison, markdown } = run(BASE.replace('import { dep } from "./dep";', 'import { dep } from "./dep";\nconst CONFIG = load();'));
    const [impact] = comparison.symbolImpact;
    expect(impact!.precise).toBe(false);
    expect(impact!.affected).toHaveLength(4);
    expect(impact!.spared).toEqual([]);
    expect(markdown).toContain("outside every export");
  });

  it("warns when a removed export is still imported by a file the change does not touch", () => {
    // MAX is removed; other.ts still imports it and is not part of the change.
    const after = BASE.replace("export const MAX = 3;", "export const LIMIT = 3;");
    const baseFiles = project(BASE);
    const headFiles = project(after);
    const base = takeSnapshot(buildHeuristicGraph("p", baseFiles));
    const head = takeSnapshot(buildHeuristicGraph("p", headFiles));
    const comparison = compareSnapshots(base, head, ["src/auth.ts"], analyzeChangedSymbols(baseFiles, headFiles, ["src/auth.ts"]));
    const [impact] = comparison.symbolImpact;
    expect(impact!.stillImporting).toEqual([{ label: "Other", symbols: ["MAX"] }]);
    const md = renderMarkdown(comparison, evaluateCheck(comparison));
    expect(md).toContain("⚠ Removed `MAX` is still imported by Other");
    // Advisory by default; only fails when asked to.
    expect(evaluateCheck(comparison).passed).toBe(true);
    const strict = evaluateCheck(comparison, { failOnRemovedExports: true });
    expect(strict.passed).toBe(false);
    expect(strict.failures[0]).toContain("removed export");
  });

  it("does not warn when the importer is updated in the same change", () => {
    const after = BASE.replace("export const MAX = 3;", "export const LIMIT = 3;");
    const baseFiles = project(BASE);
    const headFiles = project(after).map((f) => (f.path === "src/other.ts" ? file(f.path, `import { LIMIT } from "./auth";\nexport const other = () => LIMIT;\n`) : f));
    const changed = ["src/auth.ts", "src/other.ts"];
    const comparison = compareSnapshots(takeSnapshot(buildHeuristicGraph("p", baseFiles)), takeSnapshot(buildHeuristicGraph("p", headFiles)), changed, analyzeChangedSymbols(baseFiles, headFiles, changed));
    expect(comparison.symbolImpact[0]!.stillImporting).toEqual([]);
  });

  it("is in the JSON output and absent when no symbol changes are given", () => {
    const { comparison } = run(BASE.replace("return !!t;", "return t.length > 3;"));
    expect(comparisonToJson(comparison, evaluateCheck(comparison)).blastRadius.changedSymbols).toHaveLength(1);
    const plain = compareSnapshots(takeSnapshot(buildHeuristicGraph("p", project(BASE))), takeSnapshot(buildHeuristicGraph("p", project(BASE))), ["src/auth.ts"]);
    expect(plain.symbolImpact).toEqual([]);
    expect(renderMarkdown(plain, evaluateCheck(plain))).not.toContain("Changed exports");
  });
});

describe("accuracy fixes found by running the report on its own change", () => {
  it("counts `export { a }` lists and `export { a } from` re-exports as exports", async () => {
    const { extractExports } = await import("@/lib/engines/heuristicGraph");
    expect(extractExports({ path: "x.ts", content: `const a = 1;\nconst b = 2;\nexport { a, b as bee };\nexport { c } from "./c";\nexport type { T } from "./t";\n` }).sort()).toEqual(["T", "a", "bee", "c"]);
  });

  it("does not call a name removed when it moved to a re-export", () => {
    const before = `export function helper() {\n  return 1;\n}\n\nexport const KEEP = 1;\n`;
    const after = `export { helper } from "./helper";\n\nexport const KEEP = 1;\n`;
    const result = analyzeChangedSymbols([file("src/a.ts", before)], [file("src/a.ts", after)], ["src/a.ts"]);
    expect(result.flatMap((c) => c.removed)).toEqual([]);
  });

  it("does not report removals in a file that does `export * from`", () => {
    const result = analyzeChangedSymbols([file("src/a.ts", `export function gone() {}\nexport const KEEP = 1;\n`)], [file("src/a.ts", `export * from "./other";\nexport const KEEP = 1;\n`)], ["src/a.ts"]);
    expect(result.flatMap((c) => c.removed)).toEqual([]);
  });

  it("attributes the doc comment above an export to that export, not the one above it", () => {
    const before = `export function one() {\n  return 1;\n}\n\n/** Does the second thing. */\nexport function two() {\n  return 2;\n}\n`;
    const after = before.replace("/** Does the second thing. */", "/** Does the second thing.\n * Now documented better. */");
    const [c] = analyzeChangedSymbols([file("src/a.ts", before)], [file("src/a.ts", after)], ["src/a.ts"]);
    expect(c!.modified).toEqual(["two"]);
  });

  it("says nothing for a file with no exports and no importers, such as a script", () => {
    const base = takeSnapshot(buildHeuristicGraph("p", [file("scripts/run.ts", "console.log(1);\n")]));
    const head = takeSnapshot(buildHeuristicGraph("p", [file("scripts/run.ts", "console.log(2);\n")]));
    const changes = analyzeChangedSymbols([file("scripts/run.ts", "console.log(1);\n")], [file("scripts/run.ts", "console.log(2);\n")], ["scripts/run.ts"]);
    expect(compareSnapshots(base, head, ["scripts/run.ts"], changes).symbolImpact).toEqual([]);
  });

  it("says plainly when no other file uses the changed names", () => {
    const baseFiles = [file("src/a.ts", `export function used() {\n  return 1;\n}\n\nexport function lonely() {\n  return 1;\n}\n`), file("src/b.ts", `import { used } from "./a";\nexport const b = used();\n`)];
    const headFiles = [file("src/a.ts", `export function used() {\n  return 1;\n}\n\nexport function lonely() {\n  return 2;\n}\n`), baseFiles[1]!];
    const changes = analyzeChangedSymbols(baseFiles, headFiles, ["src/a.ts"]);
    const comparison = compareSnapshots(takeSnapshot(buildHeuristicGraph("p", baseFiles)), takeSnapshot(buildHeuristicGraph("p", headFiles)), ["src/a.ts"], changes);
    const md = renderMarkdown(comparison, evaluateCheck(comparison));
    expect(md).toContain("modified `lonely`");
    expect(md).toContain("No other file uses the changed names.");
    expect(md).toContain("other file imports it but none of those names: B");
  });
});

describe("export lists in comments", () => {
  it("are not exports", async () => {
    const { extractExports } = await import("@/lib/engines/heuristicGraph");
    const src = `/**\n * Use it like \`export { a, b as c }\`.\n */\n// export { d }\nexport function real() {}\n`;
    expect(extractExports({ path: "x.ts", content: src })).toEqual(["real"]);
  });
});
