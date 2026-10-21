import { describe, expect, it } from "vitest";
import { compareSnapshots, evaluateCheck, renderMarkdown, REPORT_MARKER, takeSnapshot } from "@/lib/report";
import { authMicroservice } from "@/lib/mockData";
import type { ArchitectureGraph, ArchRule } from "@/lib/types";

const rules: ArchRule[] = [
  { id: "ui-not-logic", type: "forbid", from: "kind:frontend", to: "kind:logic", message: "UI must call the API" },
  { id: "no-cycles", type: "no-cycles" },
];

/** The base architecture plus a cycle (db → controller) and a UI → logic shortcut. */
const worse: ArchitectureGraph = {
  ...authMicroservice,
  edges: [
    ...authMicroservice.edges,
    { id: "e-back", source: "users-db", target: "auth-controller", relation: "calls" },
    { id: "e-shortcut", source: "dashboard", target: "auth-controller", relation: "calls" },
  ],
};

const base = takeSnapshot(authMicroservice, rules);
const head = takeSnapshot(worse, rules);
const changed = ["src/server/db/users.ts", "src/server/auth/jwt.ts", "docs/notes.md"];

describe("compareSnapshots", () => {
  const c = compareSnapshots(base, head, changed);

  it("finds the problems this change introduces", () => {
    expect(base.violations).toEqual([]);
    expect(c.newViolations.map((v) => v.ruleId).sort()).toEqual(["no-cycles", "ui-not-logic"]);
    expect(c.newIssues.map((i) => i.kind)).toContain("cycle");
    expect(c.resolvedIssues).toEqual([]);
    expect(c.scoreDelta).toBeLessThan(0);
  });

  it("maps changed files to components and the blast radius around them", () => {
    expect(c.changedNodeIds.sort()).toEqual(["jwt-service", "users-db"]);
    expect(c.unmappedFiles).toEqual(["docs/notes.md"]);
    expect(c.directDependents).toContain("auth-controller");
    expect([...c.directDependents, ...c.indirectDependents].sort()).toEqual(["auth-controller", "dashboard", "session-api"]);
    expect(c.riskiestTouched!.nodeId).toBe("users-db");
  });

  it("reports what a fix resolves, in the other direction", () => {
    const fixed = compareSnapshots(head, base, []);
    expect(fixed.newViolations).toEqual([]);
    expect(fixed.resolvedViolations.map((v) => v.ruleId).sort()).toEqual(["no-cycles", "ui-not-logic"]);
    expect(fixed.scoreDelta).toBeGreaterThan(0);
  });

  it("warns when a deleted component is still used by survivors", () => {
    const withoutCache: ArchitectureGraph = {
      ...authMicroservice,
      nodes: authMicroservice.nodes.filter((n) => n.id !== "session-cache"),
      edges: authMicroservice.edges.filter((e) => e.target !== "session-cache"),
    };
    const removal = compareSnapshots(base, takeSnapshot(withoutCache, rules), ["src/server/cache/sessions.ts"]);
    expect(removal.removedStillUsedBy).toEqual([{ removed: "Session Cache (Redis)", usedBy: expect.arrayContaining(["JWT Service", "Auth Controller"]) }]);
  });

  it("works without a base (analyze mode)", () => {
    const only = compareSnapshots(null, head, []);
    expect(only.scoreDelta).toBe(0);
    expect(only.newViolations).toHaveLength(2);
  });
});

describe("evaluateCheck", () => {
  const c = compareSnapshots(base, head, changed);

  it("fails on new cycles and new error-severity violations by default", () => {
    const result = evaluateCheck(c);
    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(["1 new circular dependency", "2 new architecture rule violations"]);
  });

  it("can be relaxed, and enforces an optional health-drop limit", () => {
    expect(evaluateCheck(c, { failOnNewCycles: false, failOnNewViolations: false }).passed).toBe(true);
    expect(evaluateCheck(c, { failOnNewCycles: false, failOnNewViolations: false, maxHealthDrop: 1 }).failures[0]).toMatch(/health score dropped by/);
  });

  it("does not fail on warn-severity rules", () => {
    const warn = takeSnapshot(worse, [{ id: "advice", type: "forbid", from: "kind:frontend", to: "kind:logic", severity: "warn" }]);
    expect(evaluateCheck(compareSnapshots(base, warn, []), { failOnNewCycles: false }).passed).toBe(true);
  });

  it("passes a change that adds nothing", () => {
    expect(evaluateCheck(compareSnapshots(base, base, changed)).passed).toBe(true);
  });
});

describe("renderMarkdown", () => {
  it("renders a failing report with the marker, table, problems and blast radius", () => {
    const c = compareSnapshots(base, head, changed);
    const md = renderMarkdown(c, evaluateCheck(c));
    expect(md.startsWith(REPORT_MARKER)).toBe(true);
    expect(md).toContain("❌ Architecture check: 1 new circular dependency, 2 new architecture rule violations");
    expect(md).toMatch(/\| Circular dependencies \| 0 \| 1 \(\+1\) \|/);
    expect(md).toMatch(/\| Health grade \| A · 100 \|/);
    expect(md).toContain("### New problems (3)");
    expect(md).toContain("Rule `ui-not-logic`");
    expect(md).toMatch(/touches \*\*2\*\* components/);
    expect(md).toMatch(/\*\*3\*\* other components depend on them \(1 directly, 2 indirectly\)/);
    expect(md).toContain("<details>");
  });

  it("renders a passing report and the 'nothing mapped' case", () => {
    const same = compareSnapshots(base, base, ["README.md"]);
    const md = renderMarkdown(same, evaluateCheck(same));
    expect(md).toContain("✅ Architecture check");
    expect(md).not.toContain("New problems");
    expect(md).toContain("The one changed file does not belong to a mapped component.");
    const many = compareSnapshots(base, base, ["a.md", "b.md"]);
    expect(renderMarkdown(many, evaluateCheck(many))).toContain("None of the 2 changed files belong to a mapped component.");
  });

  it("escapes table-breaking characters and caps long lists", () => {
    const labelled = { ...authMicroservice, nodes: authMicroservice.nodes.map((n) => (n.id === "users-db" ? { ...n, data: { ...n.data, label: "Users | DB" } } : n)) };
    const snap = takeSnapshot(labelled, [{ id: "x", type: "forbid", from: "kind:logic", to: "kind:data" }]);
    const c = compareSnapshots(base, snap, []);
    expect(renderMarkdown(c, evaluateCheck(c))).toContain("Users \\| DB");
  });
});

describe("type-only edges in the blast radius", () => {
  it("still counts components that only import a changed type", () => {
    const g: ArchitectureGraph = {
      ...authMicroservice,
      edges: [...authMicroservice.edges, { id: "e-type", source: "dashboard", target: "users-db", relation: "imports", typeOnly: true }],
    };
    const c = compareSnapshots(null, takeSnapshot(g, []), ["src/server/db/users.ts"]);
    expect(c.directDependents).toContain("dashboard");
  });
});
