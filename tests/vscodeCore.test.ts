import { describe, expect, it } from "vitest";
import { ArchIndex, findDeclarationLine } from "../extensions/vscode/src/core";

const files = [
  { path: "src/auth.ts", content: `export function verifyToken(t: string) { return !!t; }\nexport function issueToken() { return "x"; }\nexport const MAX = 3;\n` },
  { path: "src/session.ts", content: `import { verifyToken } from "./auth";\nexport const session = () => verifyToken("a");\n` },
  { path: "src/login.ts", content: `import { issueToken } from "./auth";\nexport const login = () => issueToken();\n` },
  { path: "src/page.ts", content: `import { session } from "./session";\nexport const page = () => session();\n` },
  { path: "README.md", content: "# not code" },
  { path: "node_modules/x/index.js", content: "module.exports = 1" },
];
const index = ArchIndex.build("demo", files, 100);

describe("ArchIndex", () => {
  it("maps only analysable workspace files and accepts Windows-style paths", () => {
    expect(index.graph.nodes.map((n) => n.data.filePath).sort()).toEqual(["src/auth.ts", "src/login.ts", "src/page.ts", "src/session.ts"]);
    expect(index.nodeFor("src\\auth.ts")?.data.filePath).toBe("src/auth.ts");
    expect(index.nodeFor("src/missing.ts")).toBeUndefined();
  });

  it("summarises a file: who depends on it directly and indirectly", () => {
    const s = index.summary("src/auth.ts")!;
    expect(s.dependents).toBe(2);
    expect(s.indirectDependents).toBe(1); // page.ts, through session.ts
    expect(s.dependencies).toBe(0);
    expect(s.layer).toBeTruthy();
    expect(s.risk).toBeGreaterThanOrEqual(0);
  });

  it("returns null for files that are not mapped", () => {
    expect(index.summary("README.md")).toBeNull();
    expect(index.blastRadius("README.md")).toBeNull();
  });

  it("computes the blast radius of a whole file", () => {
    const r = index.blastRadius("src/auth.ts")!;
    expect(r.direct.map((x) => x.path).sort()).toEqual(["src/login.ts", "src/session.ts"]);
    expect(r.indirect.map((x) => x.path)).toEqual(["src/page.ts"]);
    expect(r.spared).toEqual([]);
  });

  it("narrows to one symbol and reports who was spared", () => {
    const r = index.blastRadius("src/auth.ts", "verifyToken")!;
    expect(r.direct.map((x) => x.path)).toEqual(["src/session.ts"]);
    expect(r.indirect.map((x) => x.path)).toEqual(["src/page.ts"]);
    expect(r.spared.map((x) => x.path)).toEqual(["src/login.ts"]);
    expect(r.direct[0]!.symbols).toEqual(["verifyToken"]);
  });

  it("lists each export's users and declaration line", () => {
    const usage = Object.fromEntries(index.symbolUsage("src/auth.ts").map((u) => [u.name, u]));
    expect(usage["verifyToken"]!.users.map((u) => u.path)).toEqual(["src/session.ts"]);
    expect(usage["verifyToken"]!.line).toBe(0);
    expect(usage["issueToken"]!.line).toBe(1);
    expect(usage["MAX"]!.users).toEqual([]);
    expect(usage["MAX"]!.line).toBe(2);
  });

  it("answers who uses a given symbol", () => {
    expect(index.usersOf("src/auth.ts", "issueToken").map((u) => u.path)).toEqual(["src/login.ts"]);
    expect(index.usersOf("src/auth.ts", "nope")).toEqual([]);
  });

  it("counts files beyond the cap instead of dropping them silently", () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ path: `src/m${i}.ts`, content: `export const v${i} = ${i};\n` }));
    const capped = ArchIndex.build("big", many, 5);
    expect(capped.graph.nodes).toHaveLength(5);
    expect(capped.skipped).toBe(7);
  });
});

describe("findDeclarationLine", () => {
  it("finds declarations across languages and falls back to any use", () => {
    expect(findDeclarationLine("a\nfunc Run() {}\n", "Run")).toBe(1);
    expect(findDeclarationLine("a\npub fn run() {}\n", "run")).toBe(1);
    expect(findDeclarationLine("a\npublic class Foo {}\n", "Foo")).toBe(1);
    expect(findDeclarationLine("a\nexport const x = (1) => 2;\n", "x")).toBe(1);
    expect(findDeclarationLine("a\nexports.go = 1;\n", "go")).toBe(1);
    expect(findDeclarationLine("nothing here", "zzz")).toBeNull();
  });
});
