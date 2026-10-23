import { describe, expect, it } from "vitest";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { detectModule, goExports, goImports, goPackageName } from "@/lib/engines/goImports";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { analyzeHealth } from "@/lib/engines/health";

const MOD = "github.com/acme/shop";

const files = [
  {
    path: "cmd/server/main.go",
    content: `package main

import (
	"fmt"
	"net/http"

	"${MOD}/internal/auth"
	store "${MOD}/internal/store"
)

func main() {
	fmt.Println("up")
	user := store.NewUserRepo()
	http.ListenAndServe(":8080", auth.Handler(user))
}
`,
  },
  {
    path: "internal/auth/jwt.go",
    content: `package auth

import "${MOD}/internal/store"

// VerifyToken checks a token. store.Ignored in a comment must not count.
func VerifyToken(tok string) bool { _ = store.Lookup; return tok != "" }

func helper() {}
`,
  },
  { path: "internal/auth/handler.go", content: `package auth\n\nimport "net/http"\n\nfunc Handler(u any) http.Handler { return nil }\n\ntype Session struct{}\n` },
  { path: "internal/store/users.go", content: `package store\n\nfunc NewUserRepo() int { return 1 }\n\nfunc Lookup() {}\n\nconst (\n\tMaxUsers = 10\n\tminUsers = 1\n)\n` },
  { path: "internal/store/unused.go", content: `package store\n\nfunc Orphaned() {}\n` },
  { path: "internal/auth/jwt_test.go", content: `package auth\n\nimport "testing"\n\nfunc TestX(t *testing.T) {}\n` },
];

const graph = buildHeuristicGraph("shop", files);
const id = (path: string) => graph.nodes.find((n) => n.data.filePath === path)!.id;
const edge = (from: string, to: string) => graph.edges.find((e) => e.source === id(from) && e.target === id(to));

describe("Go parsing", () => {
  it("reads single, grouped and aliased imports", () => {
    expect(goImports(files[0]!.content)).toEqual([
      { path: "fmt" },
      { path: "net/http" },
      { path: `${MOD}/internal/auth` },
      { path: `${MOD}/internal/store`, alias: "store" },
    ]);
    expect(goImports(files[1]!.content)).toEqual([{ path: `${MOD}/internal/store` }]);
  });

  it("lists only exported top-level names, including grouped consts, and ignores comments", () => {
    expect(goExports(files[1]!.content)).toEqual(["VerifyToken"]);
    expect(goExports(files[3]!.content).sort()).toEqual(["Lookup", "MaxUsers", "NewUserRepo"]);
    expect(goExports(files[2]!.content).sort()).toEqual(["Handler", "Session"]);
  });

  it("reads the package name", () => {
    expect(goPackageName(files[1]!.content)).toBe("auth");
  });
});

describe("module detection", () => {
  it("infers the module path from how imports end in known directories", () => {
    const imports = [`${MOD}/internal/auth`, `${MOD}/internal/store`, "net/http", "github.com/other/lib"];
    expect(detectModule(imports, ["cmd/server", "internal/auth", "internal/store"])).toBe(MOD);
  });

  it("does not link a third-party import that merely ends in a local directory name", () => {
    expect(detectModule(["github.com/other/store"], ["internal/store", "internal/auth"])).toBeUndefined();
    const g = buildHeuristicGraph("x", [
      { path: "internal/store/s.go", content: `package store\nfunc Open() {}\n` },
      { path: "main.go", content: `package main\nimport "net/http"\nfunc main() { http.Get("") }\n` },
    ]);
    expect(g.edges).toEqual([]);
  });

  it("is unknown (and links nothing) when there is nothing to vote with", () => {
    expect(detectModule([], ["a"])).toBeUndefined();
  });
});

describe("Go graph", () => {
  it("makes one node per source file and skips tests", () => {
    expect(graph.nodes.map((n) => n.data.filePath).sort()).toEqual(["cmd/server/main.go", "internal/auth/handler.go", "internal/auth/jwt.go", "internal/store/unused.go", "internal/store/users.go"]);
  });

  it("links an importer to the files that define the names it uses, with those names", () => {
    expect(edge("cmd/server/main.go", "internal/auth/handler.go")?.symbols).toEqual(["Handler"]);
    expect(edge("cmd/server/main.go", "internal/store/users.go")?.symbols).toEqual(["NewUserRepo"]);
    expect(edge("internal/auth/jwt.go", "internal/store/users.go")?.symbols).toEqual(["Lookup"]);
  });

  it("does not link files that define nothing the importer uses", () => {
    expect(edge("cmd/server/main.go", "internal/auth/jwt.go")).toBeUndefined();
    expect(edge("cmd/server/main.go", "internal/store/unused.go")).toBeUndefined();
  });

  it("ignores the standard library and external modules", () => {
    expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.target))).toBe(true);
    expect(graph.edges).toHaveLength(3);
  });

  it("treats cmd/ and main.go as entry points, not orphans", () => {
    const orphans = analyzeHealth(graph).issues.filter((i) => i.kind === "orphan").flatMap((i) => i.nodeIds);
    expect(orphans).not.toContain(id("cmd/server/main.go"));
  });

  it("narrows blast radius to the files that use the named export", () => {
    const result = analyzeImpactLocally(graph, "rename NewUserRepo", id("internal/store/users.go"));
    expect(result.impacts.map((i) => graph.nodes.find((n) => n.id === i.nodeId)!.data.filePath).sort()).toEqual(["cmd/server/main.go", "internal/store/users.go"]);
  });

  it("falls back to the package when the import is for side effects", () => {
    const g = buildHeuristicGraph(MOD, [
      { path: "drivers/pg/pg.go", content: `package pg\nfunc Init() {}\n` },
      { path: "drivers/pg/pool.go", content: `package pg\nfunc Pool() {}\n` },
      { path: "main.go", content: `package main\nimport _ "${MOD}/drivers/pg"\nfunc main() {}\n` },
    ]);
    const targets = g.edges.map((e) => g.nodes.find((n) => n.id === e.target)!.data.filePath).sort();
    expect(targets).toEqual(["drivers/pg/pg.go", "drivers/pg/pool.go"]);
    expect(g.edges.every((e) => e.symbols === undefined)).toBe(true);
  });
});

describe("same-package coupling", () => {
  const pkg = [
    { path: "binding/binding.go", content: `package binding\n\ntype Binding interface{ Name() string }\n\nvar Default = defaultFor\n` },
    { path: "binding/form.go", content: `package binding\n\nfunc defaultFor() Binding { return nil }\n\nfunc parseForm() {}\n` },
    { path: "binding/json.go", content: `package binding\n\n// uses parseForm only in a comment: parseForm\nfunc decode() { var b Binding; _ = b }\n` },
    { path: "binding/alone.go", content: `package binding\n\nfunc unrelated() {}\n` },
  ];
  const g = buildHeuristicGraph("m", pkg);
  const e = (from: string, to: string) => g.edges.find((x) => g.nodes.find((n) => n.id === x.source)!.data.filePath === from && g.nodes.find((n) => n.id === x.target)!.data.filePath === to);

  it("links files that use each other's top-level names without any import", () => {
    expect(e("binding/binding.go", "binding/form.go")?.symbols).toEqual(["defaultFor"]);
    expect(e("binding/form.go", "binding/binding.go")?.symbols).toEqual(["Binding"]);
    expect(e("binding/json.go", "binding/binding.go")?.symbols).toEqual(["Binding"]);
  });

  it("ignores names that only appear in comments and files that use nothing", () => {
    expect(e("binding/json.go", "binding/form.go")).toBeUndefined();
    expect(g.edges.filter((x) => g.nodes.find((n) => n.id === x.source)!.data.filePath === "binding/alone.go")).toEqual([]);
  });

  it("lists top-level declarations including unexported ones, never methods", async () => {
    const { goDeclared } = await import("@/lib/engines/goImports");
    expect(goDeclared(`package p\nfunc Run() {}\nfunc (s *S) Method() {}\nfunc helper() {}\nfunc init() {}\ntype S struct{}\nvar (\n\tcache = 1\n\tX = 2\n)\n`).sort()).toEqual(["Run", "cache", "helper"]);
  });
});

describe("same-package edges and health", () => {
  const cyclic = buildHeuristicGraph("m", [
    { path: "p/a.go", content: `package p\n\nfunc Alpha() { Bravo() }\n` },
    { path: "p/b.go", content: `package p\n\nfunc Bravo() { Alpha() }\n` },
  ]);

  it("marks them, so file-level loops inside one package are not reported as cycles", () => {
    expect(cyclic.edges).toHaveLength(2);
    expect(cyclic.edges.every((e) => e.samePackage === true)).toBe(true);
    expect(analyzeHealth(cyclic).issues.filter((i) => i.kind === "cycle")).toEqual([]);
  });

  it("still counts them for blast radius", () => {
    const a = cyclic.nodes.find((n) => n.data.filePath === "p/a.go")!.id;
    const result = analyzeImpactLocally(cyclic, "change Alpha", a);
    expect(result.impacts.length).toBeGreaterThan(1);
  });

  it("does not mark cross-package imports", () => {
    expect(graph.edges.some((e) => e.samePackage)).toBe(false);
  });
});
