import { describe, expect, it } from "vitest";
import { workspaceReducer, type WorkspaceState } from "@/hooks/useWorkspace";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { authMicroservice } from "@/lib/mockData";

function initial(): WorkspaceState {
  return {
    graph: authMicroservice,
    selectedNodeId: null,
    activeTab: "inspector",
    impactPrompt: "",
    impact: { status: "idle", result: null },
    story: { enabled: false, index: 3, isPlaying: false, narrative: null, status: "idle" },
    scaffold: { status: "idle", result: null },
    notice: null,
  };
}

describe("workspaceReducer", () => {
  it("applies an impact result's diffs to node code and clears the result", () => {
    const result = analyzeImpactLocally(authMicroservice, "uuid", null);
    let state = workspaceReducer(initial(), { type: "impactSucceeded", result });
    state = workspaceReducer(state, { type: "applyImpact" });
    expect(state.impact.result).toBeNull();
    expect(state.graph.nodes.find((n) => n.id === "users-db")!.data.code).toContain("gen_random_uuid()");
  });

  it("does not let the canvas delete real components", () => {
    const state = workspaceReducer(initial(), { type: "nodesChanged", changes: [{ type: "remove", id: "users-db" }] });
    expect(state.graph.nodes).toHaveLength(6);
  });

  it("enabling story mode clears any active impact overlay", () => {
    const result = analyzeImpactLocally(authMicroservice, "uuid", null);
    const state = workspaceReducer(workspaceReducer(initial(), { type: "impactSucceeded", result }), { type: "toggleStory" });
    expect(state.story.enabled).toBe(true);
    expect(state.impact.result).toBeNull();
  });
});
