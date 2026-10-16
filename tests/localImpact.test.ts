import { describe, expect, it } from "vitest";
import { collectDependents } from "@/lib/graph";
import { analyzeImpactLocally, computeRiskScore, ImpactRootNotFoundError, resolveRootNode } from "@/lib/engines/localImpact";
import { authMicroservice, ecommerceApi } from "@/lib/mockData";

describe("collectDependents", () => {
  it("walks reverse edges breadth-first with hop depth", () => {
    const depths = collectDependents("users-db", authMicroservice.edges);
    expect(Object.fromEntries(depths)).toEqual({ "users-db": 0, "auth-controller": 1, "session-api": 2, dashboard: 3 });
  });

  it("terminates on cycles", () => {
    const edges = [
      { id: "1", source: "a", target: "b", relation: "calls" as const },
      { id: "2", source: "b", target: "a", relation: "calls" as const },
    ];
    expect(collectDependents("a", edges).size).toBe(2);
  });
});

describe("analyzeImpactLocally", () => {
  it("matches the authored UUID scenario and marks the expected nodes", () => {
    const result = analyzeImpactLocally(authMicroservice, "Change `userId` from integer to UUID v4", null);
    expect(result.scenarioId).toBe("auth-userid-uuid");
    expect(result.rootNodeId).toBe("users-db");
    const severity = Object.fromEntries(result.impacts.map((i) => [i.nodeId, i.severity]));
    expect(severity).toMatchObject({
      "users-db": "modified",
      "auth-controller": "broken",
      "session-api": "impacted",
      dashboard: "impacted",
      "jwt-service": "impacted",
    });
    expect(result.diffs.every((d) => d.before !== d.after)).toBe(true);
  });

  it("maps a free-form schema prompt to the users table and flags Auth Controller and Dashboard", () => {
    const result = analyzeImpactLocally(authMicroservice, "Change database schema for Users", null);
    expect(result.rootNodeId).toBe("users-db");
    expect(result.impacts.map((i) => i.nodeId)).toEqual(expect.arrayContaining(["auth-controller", "dashboard"]));
    expect(result.engine).toBe("local");
  });

  it("uses the selected node when the prompt does not name a component", () => {
    expect(resolveRootNode("make it async", ecommerceApi, "payment-adapter")).toBe("payment-adapter");
  });

  it("throws a descriptive error when nothing can be matched", () => {
    expect(() => analyzeImpactLocally(ecommerceApi, "zzz qqq", null)).toThrow(ImpactRootNotFoundError);
  });

  it("caps the risk score at 100", () => {
    const impacts = Array.from({ length: 10 }, (_, depth) => ({ nodeId: `n${depth}`, depth, severity: "impacted" as const, reason: "" }));
    expect(computeRiskScore(impacts, 10)).toBe(100);
  });
});
