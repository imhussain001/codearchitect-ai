import { describe, expect, it } from "vitest";
import { analyzeHealth, findCycles, isLikelyEntryPoint, riskiestNodes } from "@/lib/engines/health";
import { authMicroservice, ecommerceApi } from "@/lib/mockData";
import { buildRenderGraph } from "@/lib/viewModel";
import type { ArchitectureGraph, ArchNode, DependencyEdge, NodeKind } from "@/lib/types";

function node(id: string, kind: NodeKind = "logic", lineCount = 20, isDraft = false): ArchNode {
  return {
    id,
    type: "component",
    position: { x: 0, y: 0 },
    data: { label: id.toUpperCase(), kind, filePath: `${id}.ts`, description: "", language: "ts", code: "", exports: [], imports: [], params: [], keywords: [], lineCount, isDraft },
  };
}
const edge = (source: string, target: string, isDraft = false): DependencyEdge => ({ id: `${source}-${target}`, source, target, relation: "calls", isDraft });
const graph = (nodes: ArchNode[], edges: DependencyEdge[]): ArchitectureGraph => ({ id: "g", name: "g", description: "", nodes, edges, commits: [], scenarios: [] });

describe("findCycles", () => {
  it("finds a loop and ignores acyclic chains", () => {
    const cycles = findCycles(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("c", "d")]);
    expect(cycles).toHaveLength(1);
    expect([...cycles[0]!].sort()).toEqual(["a", "b", "c"]);
  });

  it("detects a self-loop", () => {
    expect(findCycles(["a"], [edge("a", "a")])).toEqual([["a"]]);
  });

  it("returns nothing for a DAG", () => {
    expect(findCycles(["a", "b", "c"], [edge("a", "b"), edge("a", "c"), edge("b", "c")])).toEqual([]);
  });
});

describe("analyzeHealth", () => {
  it("rates a small clean graph as healthy with no issues", () => {
    const report = analyzeHealth(authMicroservice);
    expect(report.issues).toEqual([]);
    expect(report.grade).toBe("A");
    expect(report.overall).toBe(100);
    expect(report.nodes["users-db"]!.fanIn).toBe(1);
    expect(report.nodes["dashboard"]!.level).toBe("healthy");
  });

  it("flags a circular dependency as high severity and marks its edges", () => {
    const report = analyzeHealth(graph([node("a"), node("b"), node("c")], [edge("a", "b"), edge("b", "a"), edge("b", "c")]));
    expect(report.counts.cycles).toBe(1);
    expect(report.issues[0]).toMatchObject({ kind: "cycle", severity: "high" });
    expect(report.cycleEdgeIds.sort()).toEqual(["a-b", "b-a"]);
    expect(report.nodes["a"]!.inCycle).toBe(true);
    expect(report.nodes["c"]!.inCycle).toBe(false);
    expect(report.overall).toBeLessThan(100);
  });

  it("flags a hub only when enough components depend on it", () => {
    const dependents = ["a", "b", "c", "d"].map((id) => node(id));
    const hub = analyzeHealth(graph([node("core"), ...dependents], dependents.map((d) => edge(d.id, "core"))));
    expect(hub.counts.hubs).toBe(1);
    expect(hub.nodes["core"]!.fanIn).toBe(4);

    const notHub = analyzeHealth(graph([node("core"), ...dependents.slice(0, 3)], dependents.slice(0, 3).map((d) => edge(d.id, "core"))));
    expect(notHub.counts.hubs).toBe(0);
  });

  it("flags UI calling the data layer directly, and data calling upward", () => {
    const direct = analyzeHealth(graph([node("page", "frontend"), node("db", "data")], [edge("page", "db")]));
    expect(direct.counts.layering).toBe(1);
    expect(direct.issues[0]!.detail).toMatch(/directly to the data layer/);

    const upward = analyzeHealth(graph([node("db", "data"), node("api", "api")], [edge("db", "api")]));
    expect(upward.counts.layering).toBe(1);
  });

  it("flags unconnected and oversized components", () => {
    const report = analyzeHealth(graph([node("a"), node("b"), node("big", "logic", 900), node("lonely")], [edge("a", "b"), edge("a", "big")]));
    expect(report.counts.orphans).toBe(1);
    expect(report.counts.large).toBe(1);
    expect(report.issues.find((i) => i.kind === "large")!.severity).toBe("medium");
  });

  it("ignores builder drafts", () => {
    const report = analyzeHealth(graph([node("a"), node("draft", "logic", 20, true)], [edge("a", "draft", true)]));
    expect(report.nodes["draft"]).toBeUndefined();
    expect(report.counts.orphans).toBe(0);
  });

  it("scores more-depended-on components as riskier and never exceeds 100", () => {
    const report = analyzeHealth(ecommerceApi);
    const sorted = riskiestNodes(report, 3);
    expect(sorted[0]!.score).toBeGreaterThanOrEqual(sorted[1]!.score);
    for (const n of Object.values(report.nodes)) expect(n.score).toBeLessThanOrEqual(100);
    expect(report.nodes["orders-db"]!.score).toBeGreaterThan(report.nodes["storefront"]!.score);
  });
});

describe("buildRenderGraph: health and focus", () => {
  const base = { graph: authMicroservice, impact: null, story: { enabled: false, index: 0 } };

  it("adds heat and cycle edges only in health mode, and suppresses impact glow there", () => {
    const g = graph([node("a"), node("b")], [edge("a", "b"), edge("b", "a")]);
    const health = analyzeHealth(g);
    const on = buildRenderGraph({ graph: g, impact: null, story: { enabled: false, index: 0 }, health });
    expect(on.nodes[0]!.data.heat).toMatchObject({ level: expect.any(String), score: expect.any(Number) });
    expect(on.edges.every((e) => e.data!.isCycle)).toBe(true);

    const off = buildRenderGraph({ graph: g, impact: null, story: { enabled: false, index: 0 } });
    expect(off.nodes[0]!.data.heat).toBeUndefined();
    expect(off.edges.some((e) => e.data!.isCycle)).toBe(false);
  });

  it("dims everything outside the focused node's direct neighbours", () => {
    const { nodes, edges } = buildRenderGraph({ ...base, focusNodeId: "auth-controller" });
    const dimmed = nodes.filter((n) => n.data.dimmed).map((n) => n.id).sort();
    expect(dimmed).toEqual(["dashboard", "session-cache"]);
    expect(edges.find((e) => e.id === "e-dash-api")!.style!.opacity).toBeLessThan(0.5);
    expect(edges.find((e) => e.id === "e-api-ctrl")!.style!.opacity).toBe(1);
  });

  it("does not dim anything when no node is focused or the id is unknown", () => {
    expect(buildRenderGraph(base).nodes.every((n) => n.data.dimmed === undefined)).toBe(true);
    expect(buildRenderGraph({ ...base, focusNodeId: "nope" }).nodes.every((n) => n.data.dimmed === undefined)).toBe(true);
  });

  it("uses a graph's custom layer names", () => {
    const g = { ...authMicroservice, kindLabels: { data: "Data files" } };
    const labels = Object.fromEntries(buildRenderGraph({ ...base, graph: g }).nodes.map((n) => [n.id, n.data.kindLabel]));
    expect(labels["users-db"]).toBe("Data files");
    expect(labels["dashboard"]).toBe("Frontend / UI");
  });
});

describe("type-only edges and entry points", () => {
  const typeEdge = (source: string, target: string): DependencyEdge => ({ id: `${source}-${target}`, source, target, relation: "imports", typeOnly: true });

  it("does not make a hub, a cycle or a crossed layer out of type-only imports", () => {
    const users = ["a", "b", "c", "d", "e"].map((id) => node(id));
    const hub = analyzeHealth(graph([node("types"), ...users], users.map((u) => typeEdge(u.id, "types"))));
    expect(hub.counts.hubs).toBe(0);
    expect(hub.nodes["types"]!.fanIn).toBe(0);
    expect(hub.counts.orphans).toBe(0); // still connected, just not by runtime coupling

    const loop = analyzeHealth(graph([node("a"), node("b")], [edge("a", "b"), typeEdge("b", "a")]));
    expect(loop.counts.cycles).toBe(0);

    const ui = analyzeHealth(graph([node("page", "frontend"), node("db", "data")], [typeEdge("page", "db")]));
    expect(ui.counts.layering).toBe(0);
  });

  it("recognises framework and script entry points, but still flags real orphans", () => {
    for (const path of ["app/layout.tsx", "src/app/api/x/route.ts", "scripts/build.mjs", "scripts/cli/main.ts", "next.config.ts", "src/main.ts"]) {
      expect(isLikelyEntryPoint(path), path).toBe(true);
    }
    for (const path of ["lib/util.ts", "components/Button.tsx", "src/server/auth/jwt.ts"]) expect(isLikelyEntryPoint(path), path).toBe(false);

    const entry = { ...node("layout"), data: { ...node("layout").data, filePath: "app/layout.tsx" } };
    const report = analyzeHealth(graph([node("a"), node("b"), entry, node("lonely")], [edge("a", "b")]));
    expect(report.counts.orphans).toBe(1);
    expect(report.issues.find((i) => i.kind === "orphan")!.nodeIds).toEqual(["lonely"]);
  });
});
