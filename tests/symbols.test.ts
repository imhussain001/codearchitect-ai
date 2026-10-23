import { describe, expect, it } from "vitest";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { ALL_SYMBOLS, edgeUses, exportUsage, importedSymbols, unusedExports } from "@/lib/engines/symbols";

const symbolsOf = (source: string, spec: string) => importedSymbols(source).get(spec);

describe("importedSymbols", () => {
  it("reads named, aliased, default and type-qualified imports", () => {
    const src = `import Def, { a, b as c, type T } from "./m";\nconsole.log(Def, a, c);\nlet x: T;`;
    expect(symbolsOf(src, "./m")).toEqual(["T", "a", "b", "default"]);
  });

  it("drops names that are imported but never used", () => {
    expect(symbolsOf(`import { used, unused } from "./m";\nused();`, "./m")).toEqual(["used"]);
  });

  it("ignores uses that live only in comments and strings", () => {
    const src = `import { a, b } from "./m";\n// b()\nconst s = "a(b)";\n/* a */`;
    expect(symbolsOf(src, "./m")).toEqual([]);
  });

  it("does not mistake a property of the same name for a use", () => {
    expect(symbolsOf(`import { name } from "./m";\nconst o = { x: 1 }; o.name;`, "./m")).toEqual([]);
  });

  it("tracks the members of a namespace import and notices when the whole object is used", () => {
    expect(symbolsOf(`import * as m from "./m";\nm.foo(); m.bar;`, "./m")).toEqual(["bar", "foo"]);
    expect(symbolsOf(`import * as m from "./m";\nm.foo(); use(m);`, "./m")).toEqual(["*", "foo"]);
  });

  it("counts re-exports as use, and export-star as the whole module", () => {
    expect(symbolsOf(`export { a, b as c } from "./m";`, "./m")).toEqual(["a", "b"]);
    expect(symbolsOf(`export * from "./m";`, "./m")).toEqual([ALL_SYMBOLS]);
  });

  it("says unknown (null) for dynamic imports, require and side-effect imports", () => {
    expect(symbolsOf(`const m = await import("./m");`, "./m")).toBeNull();
    expect(symbolsOf(`const m = require("./m");`, "./m")).toBeNull();
    expect(symbolsOf(`import "./m";`, "./m")).toBeNull();
  });

  it("merges several statements for the same module", () => {
    expect(symbolsOf(`import { a } from "./m";\nimport type { T } from "./m";\na(); let t: T;`, "./m")).toEqual(["T", "a"]);
  });

  it("handles multi-line import lists", () => {
    expect(symbolsOf(`import {\n  one,\n  two as dos,\n} from "./m";\none(); dos();`, "./m")).toEqual(["one", "two"]);
  });
});

describe("symbol edges in the built graph", () => {
  const files = [
    { path: "src/lib.ts", content: `export function used() {}\nexport function spare() {}\nexport const K = 1;\n` },
    { path: "src/a.ts", content: `import { used } from "./lib";\nused();\n` },
    { path: "src/b.ts", content: `import { K, used } from "./lib";\nconsole.log(K, used);\n` },
    { path: "src/dyn.ts", content: `export const load = () => import("./lib");\n` },
  ];
  const graph = buildHeuristicGraph("fx", files);
  const id = (path: string) => graph.nodes.find((n) => n.data.filePath === path)!.id;
  const edge = (from: string) => graph.edges.find((e) => e.source === id(from) && e.target === id("src/lib.ts"))!;

  it("records which names each importer uses", () => {
    expect(edge("src/a.ts").symbols).toEqual(["used"]);
    expect(edge("src/b.ts").symbols).toEqual(["K", "used"]);
    expect(edge("src/dyn.ts").symbols).toBeUndefined();
  });

  it("lists users per export, flagging unknown ones as uncertain", () => {
    const usage = Object.fromEntries(exportUsage(graph, id("src/lib.ts")).map((u) => [u.name, u]));
    expect(usage["used"]!.users.sort()).toEqual([id("src/a.ts"), id("src/b.ts"), id("src/dyn.ts")].sort());
    expect(usage["K"]!.users).toContain(id("src/b.ts"));
    expect(usage["K"]!.users).toContain(id("src/dyn.ts")); // dynamic import might use it
    expect(usage["spare"]!.users).toEqual([id("src/dyn.ts")]);
  });

  it("only reports an export as unused when every importer's usage is known", () => {
    expect(unusedExports(graph)).toEqual([]); // dyn.ts is unknown, so nothing is provably unused
    const known = buildHeuristicGraph("fx", files.slice(0, 3));
    const unused = unusedExports(known);
    expect(unused).toHaveLength(1);
    expect(unused[0]!.names).toEqual(["spare"]);
  });
});

describe("edgeUses", () => {
  it("treats missing data and the whole-module marker as 'uses everything'", () => {
    expect(edgeUses(undefined, "x")).toBe(true);
    expect(edgeUses(["*"], "x")).toBe(true);
    expect(edgeUses(["a"], "x")).toBe(false);
    expect(edgeUses(["a"], "a")).toBe(true);
  });
});

describe("symbol-aware blast radius", () => {
  const files = [
    { path: "src/lib/auth.ts", content: `export function verifyToken() {}\nexport function issueToken() {}\n` },
    { path: "src/api/session.ts", content: `import { verifyToken } from "../lib/auth";\nverifyToken();\n` },
    { path: "src/api/login.ts", content: `import { issueToken } from "../lib/auth";\nissueToken();\n` },
    { path: "src/ui/page.ts", content: `import { verifyToken } from "../api/session";\n` },
  ];
  const graph = buildHeuristicGraph("fx", files);
  const authId = graph.nodes.find((n) => n.data.filePath === "src/lib/auth.ts")!.id;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)!.data.filePath;

  it("lists only the importers of the named export, plus what depends on them", async () => {
    const { analyzeImpactLocally } = await import("@/lib/engines/localImpact");
    const result = analyzeImpactLocally(graph, "rename verifyToken to checkToken", authId);
    expect(result.impacts.map((i) => label(i.nodeId)).sort()).toEqual(["src/api/session.ts", "src/lib/auth.ts", "src/ui/page.ts"]);
    expect(result.summary).toContain("spares 1 importer that does not use it");
    expect(result.impacts.find((i) => label(i.nodeId) === "src/api/session.ts")!.reason).toContain("`verifyToken`");
  });

  it("falls back to every importer when the prompt names no export", async () => {
    const { analyzeImpactLocally } = await import("@/lib/engines/localImpact");
    const result = analyzeImpactLocally(graph, "change the auth module", authId);
    expect(result.impacts.map((i) => label(i.nodeId))).toContain("src/api/login.ts");
  });
});
