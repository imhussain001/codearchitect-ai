import { describe, expect, it } from "vitest";
import { evaluateRules, globToRegExp, matchesSelector, violationKey } from "@/lib/engines/rules";
import { EXAMPLE_RULES_JSON, parseRulesJson } from "@/lib/rulesSchema";
import { GraphSchema } from "@/lib/graphSchema";
import { workspaceReducer, type WorkspaceState } from "@/hooks/useWorkspace";
import { buildRenderGraph } from "@/lib/viewModel";
import { authMicroservice } from "@/lib/mockData";
import type { ArchRule } from "@/lib/types";

const node = (id: string) => authMicroservice.nodes.find((n) => n.id === id)!;
const labels = (ids: string[]) => ids.map((id) => node(id).data.label);

describe("globToRegExp", () => {
  it.each([
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/c.ts", true],
    ["src/*.ts", "src/a/c.ts", false],
    ["lib/server/**", "lib/server/ai/index.ts", true],
    ["a?c", "abc", true],
    ["a.c", "abc", false],
  ])("%s vs %s", (glob, path, expected) => expect(globToRegExp(glob).test(path)).toBe(expected));
});

describe("matchesSelector", () => {
  it("matches by kind, path glob, id and label, with alternatives", () => {
    const users = node("users-db");
    expect(matchesSelector(users, "kind:data")).toBe(true);
    expect(matchesSelector(users, "kind:api")).toBe(false);
    expect(matchesSelector(users, "path:src/server/db/**")).toBe(true);
    expect(matchesSelector(users, "id:users-db")).toBe(true);
    expect(matchesSelector(users, "label:Users*")).toBe(true);
    expect(matchesSelector(users, "kind:api|kind:data")).toBe(true);
    expect(matchesSelector(users, "*")).toBe(true);
  });

  it("treats a bare word as a label or a path", () => {
    expect(matchesSelector(node("jwt-service"), "JWT Service")).toBe(true);
    expect(matchesSelector(node("jwt-service"), "src/server/auth/*")).toBe(true);
  });
});

describe("evaluateRules", () => {
  it("reports forbidden dependencies with the offending edge", () => {
    const rule: ArchRule = { id: "logic-not-data", type: "forbid", from: "kind:logic", to: "kind:data", message: "Go through a repository" };
    const v = evaluateRules(authMicroservice, [rule]);
    expect(v.map((x) => x.edgeIds[0]).sort()).toEqual(["e-ctrl-db", "e-jwt-cache"]);
    expect(v[0]).toMatchObject({ ruleId: "logic-not-data", severity: "error" });
    expect(v[0]!.message).toMatch(/^Go through a repository: /);
  });

  it("is silent when the architecture complies", () => {
    expect(evaluateRules(authMicroservice, [{ id: "ui-not-data", type: "forbid", from: "kind:frontend", to: "kind:data" }])).toEqual([]);
    expect(evaluateRules(authMicroservice, [{ id: "no-cycles", type: "no-cycles" }])).toEqual([]);
  });

  it("detects cycles and reports every edge in the loop", () => {
    const looped = { ...authMicroservice, edges: [...authMicroservice.edges, { id: "back", source: "users-db", target: "auth-controller", relation: "calls" as const }] };
    const v = evaluateRules(looped, [{ id: "no-cycles", type: "no-cycles" }]);
    expect(v).toHaveLength(1);
    expect(labels(v[0]!.nodeIds).sort()).toEqual(["Auth Controller", "Users Database"]);
    expect(v[0]!.edgeIds.sort()).toEqual(["back", "e-ctrl-db"]);
  });

  it("enforces dependent and size limits, optionally scoped by selector", () => {
    const many = evaluateRules(authMicroservice, [{ id: "few", type: "max-dependents", limit: 0, severity: "warn" }]);
    expect(many.every((x) => x.severity === "warn")).toBe(true);
    expect(many.map((x) => x.nodeIds[0]).sort()).toEqual(["auth-controller", "jwt-service", "session-api", "session-cache", "users-db"]);

    const scoped = evaluateRules(authMicroservice, [{ id: "db", type: "max-dependents", limit: 0, selector: "kind:data" }]);
    expect(scoped.map((x) => x.nodeIds[0]).sort()).toEqual(["session-cache", "users-db"]);

    const big = evaluateRules(authMicroservice, [{ id: "small", type: "max-lines", limit: 15, selector: "kind:logic" }]);
    expect(big.map((x) => x.nodeIds[0])).toEqual(expect.arrayContaining(["auth-controller", "jwt-service"]));
  });

  it("ignores builder drafts and gives identical keys to identical violations", () => {
    const withDraft = {
      ...authMicroservice,
      nodes: [...authMicroservice.nodes, { ...node("dashboard"), id: "draft", data: { ...node("dashboard").data, isDraft: true } }],
      edges: [...authMicroservice.edges, { id: "d", source: "draft", target: "users-db", relation: "calls" as const, isDraft: true }],
    };
    const rule: ArchRule = { id: "ui-not-data", type: "forbid", from: "kind:frontend", to: "kind:data" };
    expect(evaluateRules(withDraft, [rule])).toEqual([]);

    const a = evaluateRules(authMicroservice, [{ id: "x", type: "forbid", from: "kind:logic", to: "kind:data" }]);
    const b = evaluateRules(authMicroservice, [{ id: "x", type: "forbid", from: "kind:logic", to: "kind:data" }]);
    expect(a.map(violationKey)).toEqual(b.map(violationKey));
    expect(new Set(a.map(violationKey)).size).toBe(a.length);
  });

  it("uses graph.rules by default", () => {
    const g = { ...authMicroservice, rules: [{ id: "x", type: "forbid" as const, from: "kind:logic", to: "kind:data" }] };
    expect(evaluateRules(g).length).toBeGreaterThan(0);
    expect(evaluateRules(authMicroservice)).toEqual([]);
  });
});

describe("rules schema", () => {
  it("accepts the example rules, a {rules: []} wrapper, and graphs carrying rules", () => {
    expect(parseRulesJson(EXAMPLE_RULES_JSON).ok).toBe(true);
    expect(parseRulesJson(JSON.stringify({ rules: [{ id: "a", type: "no-cycles" }] })).ok).toBe(true);
    const g = { ...authMicroservice, rules: [{ id: "a", type: "no-cycles" as const }] };
    expect(GraphSchema.safeParse(g).success).toBe(true);
  });

  it("explains mistakes in terms of the rule number and field", () => {
    expect(parseRulesJson("{oops")).toMatchObject({ ok: false, error: expect.stringMatching(/Not valid JSON/) });
    expect(parseRulesJson('[{"id":"a","type":"forbid","from":"kind:ui"}]')).toMatchObject({ ok: false, error: expect.stringMatching(/rule 1 → to/) });
    expect(parseRulesJson('[{"id":"a","type":"nope"}]').ok).toBe(false);
    expect(parseRulesJson('[{"id":"a","type":"no-cycles"},{"id":"a","type":"no-cycles"}]')).toMatchObject({ ok: false, error: expect.stringMatching(/unique/) });
    expect(parseRulesJson('[{"id":"bad id!","type":"no-cycles"}]').ok).toBe(false);
  });
});

describe("rules on the canvas and in state", () => {
  const rule: ArchRule = { id: "logic-not-data", type: "forbid", from: "kind:logic", to: "kind:data" };
  const violations = evaluateRules(authMicroservice, [rule]);

  it("marks violating edges and counts violations per node", () => {
    const { nodes, edges } = buildRenderGraph({ graph: authMicroservice, impact: null, story: { enabled: false, index: 0 }, violations });
    expect(edges.filter((e) => e.data!.isViolation).map((e) => e.id).sort()).toEqual(["e-ctrl-db", "e-jwt-cache"]);
    expect(edges.find((e) => e.id === "e-ctrl-db")!.label).toMatch(/✕ rule/);
    expect(Object.fromEntries(nodes.filter((n) => n.data.violations).map((n) => [n.id, n.data.violations]))).toEqual({ "auth-controller": 1, "users-db": 1, "jwt-service": 1, "session-cache": 1 });
  });

  it("draws nothing when no violations are passed", () => {
    const { nodes, edges } = buildRenderGraph({ graph: authMicroservice, impact: null, story: { enabled: false, index: 0 } });
    expect(edges.some((e) => e.data!.isViolation)).toBe(false);
    expect(nodes.some((n) => n.data.violations)).toBe(false);
  });

  it("stores rules on the graph through the reducer", () => {
    const state = { graph: authMicroservice, selectedNodeId: null, activeTab: "health", impactPrompt: "", impact: { status: "idle", result: null }, story: { enabled: false, index: 0, isPlaying: false, narrative: null, status: "idle" }, scaffold: { status: "idle", result: null }, focusEnabled: false, notice: null } as WorkspaceState;
    const next = workspaceReducer(state, { type: "setRules", rules: [rule] });
    expect(next.graph.rules).toEqual([rule]);
    expect(evaluateRules(next.graph)).toHaveLength(2);
  });
});
