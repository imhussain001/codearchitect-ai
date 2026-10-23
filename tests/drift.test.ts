import { describe, expect, it } from "vitest";
import { analyzeDrift, measure, REGRESSION_MIN_DROP, renderDriftMarkdown, sampleIndices, sparkline, type DriftPoint } from "@/lib/engines/drift";
import { takeSnapshot } from "@/lib/report";
import { authMicroservice } from "@/lib/mockData";

const point = (n: number, score: number, extra: Partial<DriftPoint> = {}): DriftPoint => ({
  hash: `c${n}`.padEnd(40, "0"),
  message: `commit ${n}`,
  author: "dev",
  date: `2026-01-${String(n).padStart(2, "0")}T00:00:00Z`,
  components: 10,
  dependencies: 12,
  score,
  grade: score >= 90 ? "A" : "B",
  cycles: 0,
  violations: 0,
  ...extra,
});

describe("analyzeDrift", () => {
  it("computes per-commit deltas, with zero for the first point", () => {
    const { steps } = analyzeDrift([point(1, 90), point(2, 84), point(3, 88)]);
    expect(steps.map((s) => s.scoreDelta)).toEqual([0, -6, 4]);
  });

  it("flags a score drop, a new cycle or a new violation as a regression, worst first", () => {
    const report = analyzeDrift([point(1, 90), point(2, 85), point(3, 85, { cycles: 1 }), point(4, 85, { cycles: 1, violations: 2 })]);
    expect(report.regressions.map((s) => s.message)).toContain("commit 3");
    expect(report.regressions.map((s) => s.message)).toContain("commit 2");
    const ordered = analyzeDrift([point(1, 90), point(2, 85), point(3, 80, { cycles: 1 })]).regressions.map((s) => s.message);
    expect(ordered).toEqual(["commit 3", "commit 2"]); // 5 + 10 beats 5
  });

  it("does not call a small wobble a regression, and never flags the first point", () => {
    const report = analyzeDrift([point(1, 50, { cycles: 3 }), point(2, 50 - (REGRESSION_MIN_DROP - 1))]);
    expect(report.regressions).toEqual([]);
  });

  it("lists improvements: fewer cycles or a clear score gain", () => {
    const report = analyzeDrift([point(1, 70, { cycles: 2 }), point(2, 70, { cycles: 1 }), point(3, 92, { cycles: 1 })]);
    expect(report.improvements.map((s) => s.message)).toEqual(["commit 3", "commit 2"]);
  });

  it("reports the overall trend with a tolerance", () => {
    expect(analyzeDrift([point(1, 80), point(2, 90)]).trend).toBe("improving");
    expect(analyzeDrift([point(1, 90), point(2, 80)]).trend).toBe("declining");
    expect(analyzeDrift([point(1, 90), point(2, 89)]).trend).toBe("steady");
  });

  it("handles no points and one point", () => {
    expect(analyzeDrift([]).first).toBeNull();
    const one = analyzeDrift([point(1, 90)]);
    expect(one.regressions).toEqual([]);
    expect(one.trend).toBe("steady");
  });
});

describe("sampleIndices", () => {
  it("keeps everything when the history is short", () => {
    expect(sampleIndices(4, 10)).toEqual([0, 1, 2, 3]);
  });

  it("samples evenly and always keeps the first and last commit", () => {
    const idx = sampleIndices(100, 5);
    expect(idx).toHaveLength(5);
    expect(idx[0]).toBe(0);
    expect(idx.at(-1)).toBe(99);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
  });

  it("copes with empty and tiny limits", () => {
    expect(sampleIndices(0, 5)).toEqual([]);
    expect(sampleIndices(10, 1)).toEqual([9]);
  });
});

describe("sparkline", () => {
  it("rises and falls with the scores", () => {
    const s = sparkline([10, 50, 90]);
    expect(s[0]).toBe("▁");
    expect(s.at(-1)).toBe("█");
  });

  it("is flat for a constant series and empty for none", () => {
    expect(new Set(sparkline([5, 5, 5])).size).toBe(1);
    expect(sparkline([])).toBe("");
  });
});

describe("measure + markdown", () => {
  it("summarises a real snapshot", () => {
    const p = measure({ hash: "a".repeat(40), message: "x", author: "me", date: "2026-02-01T00:00:00Z" }, takeSnapshot(authMicroservice));
    expect(p.components).toBe(authMicroservice.nodes.length);
    expect(p.grade).toMatch(/^[A-F]$/);
  });

  it("renders the verdict, culprits and a timeline row per commit", () => {
    const report = analyzeDrift([point(1, 92), point(2, 80, { cycles: 1 }), point(3, 85)]);
    const md = renderDriftMarkdown(report, "demo");
    expect(md).toContain("**Declining.**");
    expect(md).toContain("Commits that made it worse");
    expect(md).toContain("commit 2");
    expect(md.match(/^\| `c\d/gm)).toHaveLength(3);
  });

  it("says so when there is nothing to chart", () => {
    expect(renderDriftMarkdown(analyzeDrift([]), "demo")).toContain("No commits");
  });
});

describe("graph schema", () => {
  it("accepts a graph carrying drift and rejects an out-of-range score", async () => {
    const { GraphSchema } = await import("@/lib/graphSchema");
    const good = { ...authMicroservice, drift: [point(1, 90), point(2, 85)] };
    expect(GraphSchema.safeParse(good).success).toBe(true);
    expect(GraphSchema.safeParse({ ...authMicroservice, drift: [point(1, 140)] }).success).toBe(false);
  });
});
