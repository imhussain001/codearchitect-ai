import { vi } from "vitest";

vi.mock("server-only", () => ({}));

import { describe, expect, it } from "vitest";
import { buildHeuristicGraph, clampMaxFiles, MAX_AI_FILES, MAX_GRAPH_FILES, MAX_MAPPABLE_FILES, MIN_MAPPED_FILES, selectGraphFiles } from "@/lib/engines/heuristicGraph";
import { GraphSchema } from "@/lib/graphSchema";
import { AnalyzeRepoRequestSchema } from "@/lib/server/schemas";
import { authMicroservice } from "@/lib/mockData";

const repo = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/m${i}.ts`, content: i === 0 ? "export const v0 = 0;\n" : `import { v${i - 1} } from "./m${i - 1}";\nexport const v${i} = v${i - 1} + 1;\n` }));

describe("how many files the local engine maps", () => {
  it("maps far more than 60 by default, and keeps AI grouping bounded by its prompt", () => {
    expect(MAX_GRAPH_FILES).toBeGreaterThan(60);
    expect(MAX_AI_FILES).toBe(60);
    expect(MAX_MAPPABLE_FILES).toBeGreaterThan(MAX_GRAPH_FILES);
  });

  it("keeps the default number of files from a bigger repository and says how many were left out", () => {
    const { selected, warnings } = selectGraphFiles(repo(500));
    expect(selected).toHaveLength(MAX_GRAPH_FILES);
    expect(warnings.join(" ")).toContain(`${MAX_GRAPH_FILES} most architecturally relevant of 500`);
  });

  it("maps everything when the repository fits, and honours an explicit limit", () => {
    expect(selectGraphFiles(repo(150)).selected).toHaveLength(150);
    expect(selectGraphFiles(repo(150)).warnings).toEqual([]);
    expect(selectGraphFiles(repo(150), 100).selected).toHaveLength(100);
    expect(selectGraphFiles(repo(150), MAX_AI_FILES).selected).toHaveLength(60);
  });

  it("builds a large graph that still validates against the shared schema", () => {
    const graph = buildHeuristicGraph("big", repo(1_200), { maxFiles: 1_200 });
    expect(graph.nodes).toHaveLength(1_200);
    expect(graph.edges.length).toBeGreaterThan(1_000); // the old schema cap was 1,000 edges and 200 nodes
    expect(GraphSchema.safeParse(graph).success).toBe(true);
  });

  it("still rejects a graph no canvas could draw", () => {
    const node = authMicroservice.nodes[0]!;
    const huge = { ...authMicroservice, nodes: Array.from({ length: 2_600 }, (_, i) => ({ ...node, id: `n${i}` })), edges: [] };
    expect(GraphSchema.safeParse(huge).success).toBe(false);
  });
});

describe("clampMaxFiles", () => {
  it("keeps a user's number inside what the engine and canvas can handle", () => {
    expect(clampMaxFiles(1)).toBe(MIN_MAPPED_FILES);
    expect(clampMaxFiles(99_999)).toBe(MAX_MAPPABLE_FILES);
    expect(clampMaxFiles(250.6)).toBe(251);
    expect(clampMaxFiles(Number.NaN)).toBe(MAX_GRAPH_FILES);
    expect(clampMaxFiles(Number.POSITIVE_INFINITY)).toBe(MAX_GRAPH_FILES);
  });
});

describe("analyze-repo request", () => {
  const files = [{ path: "a.ts", content: "export const a = 1;" }];
  it("accepts an optional limit within range, for uploads and GitHub", () => {
    expect(AnalyzeRepoRequestSchema.safeParse({ kind: "files", name: "x", files }).success).toBe(true);
    expect(AnalyzeRepoRequestSchema.safeParse({ kind: "files", name: "x", files, maxFiles: 800 }).success).toBe(true);
    expect(AnalyzeRepoRequestSchema.safeParse({ kind: "github", url: "https://github.com/o/r", maxFiles: 500 }).success).toBe(true);
  });

  it("rejects a limit that is too small, too large or not a whole number", () => {
    for (const maxFiles of [5, 2_001, 100.5, "300"]) expect(AnalyzeRepoRequestSchema.safeParse({ kind: "files", name: "x", files, maxFiles }).success, String(maxFiles)).toBe(false);
  });
});
