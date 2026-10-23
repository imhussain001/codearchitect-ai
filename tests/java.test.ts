import { describe, expect, it } from "vitest";
import { buildHeuristicGraph, isAnalyzableSource } from "@/lib/engines/heuristicGraph";
import { javaExports, javaImports, javaPackage, javaTypes } from "@/lib/engines/javaImports";
import { analyzeHealth } from "@/lib/engines/health";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";

const files = [
  {
    path: "src/main/java/com/acme/App.java",
    content: `package com.acme;

import com.acme.web.UserController;
import com.acme.store.*;
import static com.acme.util.Strings.slug;
import java.util.List;

public class App {
  public static void main(String[] a) {
    new UserController(new UserRepository());
    slug("x");
  }
}
`,
  },
  {
    path: "src/main/java/com/acme/web/UserController.java",
    content: `package com.acme.web;

import com.acme.store.UserRepository;
import com.acme.store.User;
import com.acme.util.Strings;

/** Uses Strings in a comment only: Strings. */
public class UserController {
  private final UserRepository repo;
  public UserController(UserRepository repo) { this.repo = repo; }
  User find(String id) { return repo.byId(id); }
}
`,
  },
  {
    path: "src/main/java/com/acme/store/UserRepository.java",
    content: `package com.acme.store;

public class UserRepository {
  public User byId(String id) { return new User(id); }
  static class Nested {}
}
`,
  },
  { path: "src/main/java/com/acme/store/User.java", content: `package com.acme.store;\n\npublic record User(String id) {}\n` },
  { path: "src/main/java/com/acme/store/Audit.java", content: `package com.acme.store;\n\nclass Audit {\n  User who;\n}\n` },
  { path: "src/main/java/com/acme/util/Strings.java", content: `package com.acme.util;\n\npublic final class Strings {\n  public static String slug(String s) { return s; }\n}\n` },
  { path: "src/test/java/com/acme/AppTest.java", content: `package com.acme;\nclass AppTest {}\n` },
  { path: "src/main/java/com/acme/store/UserRepositoryIT.java", content: `package com.acme.store;\nclass UserRepositoryIT {}\n` },
];

const graph = buildHeuristicGraph("acme", files);
const idOf = (suffix: string) => graph.nodes.find((n) => n.data.filePath.endsWith(suffix))!.id;
const edge = (from: string, to: string) => graph.edges.find((e) => e.source === idOf(from) && e.target === idOf(to));

describe("Java parsing", () => {
  it("reads the package and the import forms", () => {
    expect(javaPackage(files[0]!.content)).toBe("com.acme");
    expect(javaImports(files[0]!.content)).toEqual([
      { name: "com.acme.web.UserController", isStatic: false, wildcard: false },
      { name: "com.acme.store", isStatic: false, wildcard: true },
      { name: "com.acme.util.Strings.slug", isStatic: true, wildcard: false },
      { name: "java.util.List", isStatic: false, wildcard: false },
    ]);
  });

  it("finds top-level types only, with their visibility", () => {
    expect(javaTypes(files[2]!.content)).toEqual([{ name: "UserRepository", isPublic: true }]);
    expect(javaTypes(files[3]!.content)).toEqual([{ name: "User", isPublic: true }]);
    expect(javaTypes(files[4]!.content)).toEqual([{ name: "Audit", isPublic: false }]);
    expect(javaExports(files[4]!.content)).toEqual([]);
  });

  it("ignores types named in comments and strings", () => {
    expect(javaTypes(`// class Fake {}\n/* interface Nope {} */\nclass Real { String s = "class X {}"; }`).map((t) => t.name)).toEqual(["Real"]);
  });
});

describe("test files", () => {
  it("skips test classes but not names that merely end in 'it'", () => {
    expect(isAnalyzableSource("src/main/java/a/FooTest.java")).toBe(false);
    expect(isAnalyzableSource("src/main/java/a/FooIT.java")).toBe(false);
    expect(isAnalyzableSource("src/main/java/a/Audit.java")).toBe(true);
    expect(isAnalyzableSource("src/main/java/a/Limit.java")).toBe(true);
    expect(graph.nodes.some((n) => /Test|IT\.java/.test(n.data.filePath))).toBe(false);
  });
});

describe("Java edges", () => {
  it("links an explicit import to the file declaring that type", () => {
    expect(edge("App.java", "UserController.java")?.symbols).toEqual(["UserController"]);
    expect(edge("UserController.java", "UserRepository.java")?.symbols).toEqual(["UserRepository"]);
    expect(edge("UserController.java", "store/User.java")?.symbols).toEqual(["User"]);
  });

  it("resolves a static import to the class's file, naming the member", () => {
    expect(edge("App.java", "Strings.java")?.symbols).toEqual(["slug"]);
  });

  it("links a wildcard import only to files whose types are mentioned", () => {
    expect(edge("App.java", "UserRepository.java")?.symbols).toEqual(["UserRepository"]);
    expect(edge("App.java", "store/User.java")).toBeUndefined();
  });

  it("does not count a type that appears only in a comment", () => {
    // UserController's doc comment mentions Strings, but the import is explicit so it links; check a pure-comment case instead
    const g = buildHeuristicGraph("x", [
      { path: "a/A.java", content: `package a;\nimport b.*;\n// uses B\npublic class A {}\n` },
      { path: "b/B.java", content: `package b;\npublic class B {}\n` },
    ]);
    expect(g.edges).toEqual([]);
  });

  it("links same-package use without an import, marked samePackage", () => {
    const e = edge("Audit.java", "store/User.java");
    expect(e?.symbols).toEqual(["User"]);
    expect(e?.samePackage).toBe(true);
    expect(edge("App.java", "UserController.java")?.samePackage).toBeUndefined();
  });

  it("ignores the JDK and external libraries", () => {
    expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.target))).toBe(true);
    expect(graph.edges.some((e) => graph.nodes.find((n) => n.id === e.target)!.data.filePath.includes("java/util"))).toBe(false);
  });

  it("does not report same-package loops as cycles, and Application classes are entry points", () => {
    const loop = buildHeuristicGraph("l", [
      { path: "p/A.java", content: `package p;\nclass A { B b; }\n` },
      { path: "p/B.java", content: `package p;\nclass B { A a; }\n` },
    ]);
    expect(loop.edges).toHaveLength(2);
    expect(analyzeHealth(loop).issues.filter((i) => i.kind === "cycle")).toEqual([]);
    const orphans = analyzeHealth(graph).issues.filter((i) => i.kind === "orphan").flatMap((i) => i.nodeIds);
    expect(orphans).not.toContain(idOf("App.java"));
  });

  it("narrows blast radius when the prompt names the type", () => {
    const result = analyzeImpactLocally(graph, "change UserRepository", idOf("UserRepository.java"));
    const touched = result.impacts.map((i) => graph.nodes.find((n) => n.id === i.nodeId)!.data.filePath.split("/").pop());
    expect(touched).toEqual(expect.arrayContaining(["UserRepository.java", "UserController.java", "App.java"]));
  });

  it("classifies by Java naming conventions", () => {
    expect(graph.nodes.find((n) => n.data.filePath.endsWith("UserController.java"))!.data.kind).toBe("api");
    expect(graph.nodes.find((n) => n.data.filePath.endsWith("UserRepository.java"))!.data.kind).toBe("data");
  });
});

describe("Java housekeeping", () => {
  it("skips package-info and module-info", () => {
    expect(isAnalyzableSource("src/main/java/a/package-info.java")).toBe(false);
    expect(isAnalyzableSource("src/main/java/module-info.java")).toBe(false);
  });

  it("treats framework-wired classes as entry points, not orphans", () => {
    const g = buildHeuristicGraph("w", [
      { path: "a/WelcomeController.java", content: `package a;\npublic class WelcomeController { public String welcome() { return "x"; } }\n` },
      { path: "a/Other.java", content: `package a;\npublic class Other {}\n` },
    ]);
    const orphans = analyzeHealth(g).issues.filter((i) => i.kind === "orphan").flatMap((i) => i.nodeIds);
    expect(orphans).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === orphans[0])!.data.filePath).toBe("a/Other.java");
  });

  it("still counts same-package links for fan-in", () => {
    const g = buildHeuristicGraph("f", [
      { path: "a/Repo.java", content: `package a;\npublic class Repo {}\n` },
      ...["X", "Y", "Z", "W"].map((n) => ({ path: `a/${n}Svc.java`, content: `package a;\npublic class ${n}Svc { Repo r; }\n` })),
    ]);
    const repo = g.nodes.find((n) => n.data.filePath === "a/Repo.java")!;
    expect(analyzeHealth(g).nodes[repo.id]!.fanIn).toBe(4);
  });
});
