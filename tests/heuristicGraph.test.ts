import { describe, expect, it } from "vitest";
import { buildHeuristicGraph, classifyPath, extractExports, isAnalyzableSource } from "@/lib/engines/heuristicGraph";

describe("classifyPath", () => {
  it.each([
    ["src/app/api/users/route.ts", "api"],
    ["src/db/users.ts", "data"],
    ["src/components/Button.tsx", "frontend"],
    ["src/services/billing.ts", "logic"],
  ])("%s -> %s", (path, kind) => expect(classifyPath(path)).toBe(kind));
});

describe("isAnalyzableSource", () => {
  it("skips dependencies, tests, declarations and config", () => {
    expect(isAnalyzableSource("node_modules/x/index.js")).toBe(false);
    expect(isAnalyzableSource("src/a.test.ts")).toBe(false);
    expect(isAnalyzableSource("src/types.d.ts")).toBe(false);
    expect(isAnalyzableSource("next.config.ts")).toBe(false);
    expect(isAnalyzableSource("src/service.ts")).toBe(true);
  });
});

describe("buildHeuristicGraph", () => {
  it("creates one node per file and an edge per resolvable internal import", () => {
    const graph = buildHeuristicGraph("demo", [
      { path: "src/app/api/users/route.ts", content: 'import { usersService } from "@/services/users";\nexport async function GET() {}' },
      { path: "src/services/users.ts", content: 'import { db } from "../db/client";\nimport z from "zod";\nexport const usersService = {};' },
      { path: "src/db/client.ts", content: "export const db = {};" },
    ]);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.edges.map((e) => [e.source, e.target]).sort()).toEqual([
      ["src-app-api-users-route", "src-services-users"],
      ["src-services-users", "src-db-client"],
    ]);
    expect(new Set(graph.nodes.map((n) => n.position.y)).size).toBe(3);
  });

  it("extracts JS and Python exports", () => {
    expect(extractExports({ path: "a.ts", content: "export default function Page() {}\nexport const x = 1;" })).toEqual(["default Page", "x"]);
    expect(extractExports({ path: "a.py", content: "def run():\n  pass\ndef _private():\n  pass\nclass Repo:\n  pass" })).toEqual(["run", "Repo"]);
  });
});

describe("type-only imports", () => {
  const edgesOf = (files: Array<{ path: string; content: string }>) => buildHeuristicGraph("t", files).edges;
  const target = { path: "src/types.ts", content: "export type A = 1;" };

  it("marks an import type as type-only and keeps value imports as runtime coupling", () => {
    const typedSource = ['import type { A } from "./types";', "export const x = 1;"].join("\n");
    const [typed] = edgesOf([{ path: "src/a.ts", content: typedSource }, target]);
    expect(typed).toMatchObject({ relation: "imports", typeOnly: true });

    const [valued] = edgesOf([{ path: "src/a.ts", content: 'import { A } from "./types";' }, target]);
    expect(valued!.typeOnly).toBeUndefined();
  });

  it("treats a module as runtime-coupled when it is also imported by value", () => {
    const mixedSource = ['import type { A } from "./types";', 'import { b } from "./types";'].join("\n");
    const [mixed] = edgesOf([{ path: "src/a.ts", content: mixedSource }, target]);
    expect(mixed!.typeOnly).toBeUndefined();
  });

  it("handles re-exported types", () => {
    const [reexport] = edgesOf([{ path: "src/a.ts", content: 'export type { A } from "./types";' }, target]);
    expect(reexport!.typeOnly).toBe(true);
  });
});
