import { describe, expect, it } from "vitest";
import { explainImpact, explainNode, GLOSSARY } from "@/lib/explain";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { authMicroservice } from "@/lib/mockData";
import type { ImpactAnalysisResult } from "@/lib/types";

describe("explainNode", () => {
  it("describes dependents, dependencies and reach in plain words", () => {
    const e = explainNode(authMicroservice, "auth-controller")!;
    expect(e.headline).toBe("Auth Controller is business logic that does the actual work.");
    expect(e.bullets[0]).toBe("1 component uses it directly: GET /api/session.");
    expect(e.bullets[1]).toMatch(/relies on JWT Service, Users Database/);
    expect(e.bullets[2]).toMatch(/ripple to 2 other components, some of them indirectly/);
  });

  it("says a leaf with no dependents is safe to change on its own", () => {
    const e = explainNode(authMicroservice, "dashboard")!;
    expect(e.bullets[0]).toBe("Nothing else in this map uses it.");
    expect(e.bullets[2]).toMatch(/safe to change on its own/);
  });

  it("warns about a wide blast radius", () => {
    const e = explainNode(authMicroservice, "users-db")!;
    expect(e.bullets[2]).toMatch(/3 of the other 5 components: a wide blast radius/);
  });

  it("uses a graph's custom layer name and returns null for unknown ids", () => {
    const g = { ...authMicroservice, kindLabels: { data: "Data files" } };
    expect(explainNode(g, "users-db")!.headline).toBe("Users Database is part of “Data files”.");
    expect(explainNode(authMicroservice, "nope")).toBeNull();
  });
});

describe("explainImpact", () => {
  const uuid = analyzeImpactLocally(authMicroservice, "Change `userId` from integer to UUID v4", null);

  it("summarises the work, estimates effort and gives an order starting at the origin", () => {
    const e = explainImpact(uuid, authMicroservice);
    expect(e.headline).toBe("Changing Users Database would need edits in 4 files.");
    expect(e.order[0]).toBe("1. Make the change in Users Database.");
    expect(e.order).toHaveLength(5);
    expect(["Small", "Medium", "Large"]).toContain(e.effort);
    expect(e.effortWhy).toBe("4 files must change; the proposed edits touch about 19 lines.");
  });

  it("rates a tiny change as Small and a sprawling one as Large", () => {
    const tiny: ImpactAnalysisResult = { ...uuid, impacts: [uuid.impacts[0]!], diffs: [] };
    expect(explainImpact(tiny, authMicroservice).effort).toBe("Small");

    const many = Array.from({ length: 8 }, (_, i) => ({ nodeId: "dashboard", severity: "broken" as const, depth: 1, reason: `r${i}` }));
    expect(explainImpact({ ...uuid, impacts: [uuid.impacts[0]!, ...many], diffs: [] }, authMicroservice).effort).toBe("Large");
  });

  it("mentions review-only components last", () => {
    const mongo = analyzeImpactLocally(authMicroservice, "Refactor Users Database from SQL to MongoDB", null);
    const e = explainImpact(mongo, authMicroservice);
    expect(e.headline).toMatch(/review of 1 more component/);
    expect(e.order.at(-1)).toBe("5. Skim User Dashboard; it may need no edit.");
    expect(e.effortWhy).toMatch(/1 other component should be reviewed/);
  });
});

describe("GLOSSARY", () => {
  it("has unique terms with non-empty meanings", () => {
    expect(new Set(GLOSSARY.map((g) => g.term)).size).toBe(GLOSSARY.length);
    expect(GLOSSARY.every((g) => g.meaning.length > 20)).toBe(true);
  });
});
