import { describe, expect, it } from "vitest";
import { describeTrace, traceProvenance, type Trace } from "@/lib/engines/provenance";
import { authMicroservice, ecommerceApi, powerSystemsMatlab } from "@/lib/mockData";
import { dataNodeId } from "@/lib/engines/scripts";
import { analyzeHealth } from "@/lib/engines/health";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { workspaceReducer, type WorkspaceState } from "@/hooks/useWorkspace";
import { buildRenderGraph } from "@/lib/viewModel";
import type { ArchitectureGraph } from "@/lib/types";

const g = powerSystemsMatlab;
const id = (path: string) => g.nodes.find((n) => n.data.filePath === path)!.id;
const label = (nodeId: string, graph: ArchitectureGraph = g) => graph.nodes.find((n) => n.id === nodeId)!.data.label;
const labels = (t: Trace, graph: ArchitectureGraph = g) => t.nodeIds.map((n) => label(n, graph)).sort();

describe("traceProvenance: upstream (where does it come from?)", () => {
  it("follows a result back through the script that wrote it to its raw inputs", () => {
    const t = traceProvenance(g, { nodeId: dataNodeId("nrmse_results.csv"), mode: "upstream" })!;
    expect(labels(t)).toEqual(
      ["Align Signals", "Load Trace", "Nrmse Percent", "Plot Overlay", "Run Study", "nrmse_results.csv", "pscad_base.csv", "pscad_lvl1.csv", "pscad_lvl2.csv", "psse_boundary.csv"].sort(),
    );
    expect(t.rawInputs.map((n) => label(n)).sort()).toEqual(["pscad_base.csv", "pscad_lvl1.csv", "pscad_lvl2.csv", "psse_boundary.csv"]);
  });

  it("crosses pipeline stages: a figure depends on the first script's inputs through an intermediate file", () => {
    const t = traceProvenance(g, { nodeId: dataNodeId("nrmse_bar.png"), mode: "upstream" })!;
    expect(labels(t)).toEqual(expect.arrayContaining(["Make Report", "nrmse_results.csv", "Run Study", "pscad_base.csv"]));
    const byRole = (role: string) => t.steps.filter((s) => s.role === role).map((s) => label(s.nodeId));
    expect(byRole("produced")).toEqual(["nrmse_results.csv"]);
    expect(byRole("target")).toEqual(["nrmse_bar.png"]);
    // Raw inputs come first, the target last.
    expect(label(t.steps.at(-1)!.nodeId)).toBe("nrmse_bar.png");
    expect(t.steps[0]!.role).toBe("input");
  });

  it("does not drag in sibling outputs of the producing script", () => {
    const t = traceProvenance(g, { nodeId: dataNodeId("nrmse_results.csv"), mode: "upstream" })!;
    expect(labels(t)).not.toContain("overlay_boundary.png");
  });

  it("traces a function back to what it relies on, and a raw input to nothing", () => {
    const fn = traceProvenance(g, { nodeId: id("run_study.m"), mode: "upstream" })!;
    expect(labels(fn)).toEqual(expect.arrayContaining(["Load Trace", "pscad_base.csv"]));
    expect(labels(fn)).not.toContain("nrmse_results.csv"); // an output, not an input

    const raw = traceProvenance(g, { nodeId: dataNodeId("pscad_base.csv"), mode: "upstream" })!;
    expect(raw.nodeIds).toEqual([raw.nodeId]);
  });
});

describe("traceProvenance: downstream (what does it affect?)", () => {
  it("finds every result a raw input can change, across both stages", () => {
    const t = traceProvenance(g, { nodeId: dataNodeId("pscad_base.csv"), mode: "downstream" })!;
    expect(t.results.map((n) => label(n)).sort()).toEqual(["nrmse_bar.png", "nrmse_results.csv", "overlay_boundary.png"]);
    expect(labels(t)).toEqual(expect.arrayContaining(["Run Study", "Make Report"]));
    expect(t.steps[0]!.nodeId).toBe(t.nodeId); // the source comes first
  });

  it("only reaches what really depends on it", () => {
    const t = traceProvenance(g, { nodeId: dataNodeId("psse_boundary.csv"), mode: "downstream" })!;
    expect(t.results.map((n) => label(n)).sort()).toEqual(["nrmse_bar.png", "nrmse_results.csv", "overlay_boundary.png"]);

    const leaf = traceProvenance(g, { nodeId: dataNodeId("nrmse_bar.png"), mode: "downstream" })!;
    expect(leaf.nodeIds).toEqual([leaf.nodeId]);
  });

  it("includes callers of a helper function and the outputs they write", () => {
    const t = traceProvenance(g, { nodeId: id("load_trace.m"), mode: "downstream" })!;
    expect(labels(t)).toEqual(expect.arrayContaining(["Run Study", "nrmse_results.csv", "Make Report", "nrmse_bar.png"]));
  });
});

describe("traceProvenance: general behaviour", () => {
  it("returns null for an unknown node and ignores builder drafts", () => {
    expect(traceProvenance(g, { nodeId: "nope", mode: "upstream" })).toBeNull();
    const withDraft: ArchitectureGraph = {
      ...g,
      nodes: [...g.nodes, { ...g.nodes[0]!, id: "draft", data: { ...g.nodes[0]!.data, isDraft: true } }],
      edges: [...g.edges, { id: "d", source: "draft", target: dataNodeId("pscad_base.csv"), relation: "reads", isDraft: true }],
    };
    expect(traceProvenance(withDraft, { nodeId: dataNodeId("pscad_base.csv"), mode: "downstream" })!.nodeIds).not.toContain("draft");
  });

  it("terminates on cycles", () => {
    const loop: ArchitectureGraph = { ...authMicroservice, edges: [...authMicroservice.edges, { id: "back", source: "users-db", target: "auth-controller", relation: "calls" }] };
    const t = traceProvenance(loop, { nodeId: "auth-controller", mode: "upstream" })!;
    expect(new Set(t.nodeIds).size).toBe(t.nodeIds.length);
  });

  it("works on ordinary code graphs: upstream is dependencies, downstream is dependents", () => {
    expect(labels(traceProvenance(authMicroservice, { nodeId: "auth-controller", mode: "upstream" })!, authMicroservice)).toEqual(
      ["Auth Controller", "JWT Service", "Session Cache (Redis)", "Users Database"].sort(),
    );
    expect(labels(traceProvenance(authMicroservice, { nodeId: "users-db", mode: "downstream" })!, authMicroservice)).toEqual(
      ["Auth Controller", "GET /api/session", "User Dashboard", "Users Database"].sort(),
    );
  });

  it("treats a write as a product, not a dependency (web example)", () => {
    const up = traceProvenance(ecommerceApi, { nodeId: "order-service", mode: "upstream" })!;
    expect(labels(up, ecommerceApi)).toContain("Payment Gateway Adapter");
    expect(labels(up, ecommerceApi)).not.toContain("Orders & Products DB"); // it writes there; that is an output
    const downstream = traceProvenance(ecommerceApi, { nodeId: "order-service", mode: "downstream" })!;
    expect(labels(downstream, ecommerceApi)).toContain("Orders & Products DB");
  });
});

describe("describeTrace", () => {
  it("explains where a figure comes from in plain words", () => {
    const t = traceProvenance(g, { nodeId: dataNodeId("nrmse_bar.png"), mode: "upstream" })!;
    const d = describeTrace(g, t);
    expect(d.headline).toBe("nrmse_bar.png is produced by Make Report.");
    expect(d.lines.join(" ")).toMatch(/passes through 1 intermediate file: nrmse_results.csv/);
    expect(d.lines.join(" ")).toMatch(/starts from 4 input files: /);
  });

  it("explains what an input affects, and the empty cases", () => {
    const d = describeTrace(g, traceProvenance(g, { nodeId: dataNodeId("pscad_base.csv"), mode: "downstream" })!);
    expect(d.headline).toMatch(/^Changing pscad_base.csv can affect \d+ other components\.$/);
    expect(d.lines.join(" ")).toMatch(/Results that would be out of date: .*nrmse_bar.png/);

    expect(describeTrace(g, traceProvenance(g, { nodeId: dataNodeId("nrmse_bar.png"), mode: "downstream" })!).headline).toMatch(/^Nothing else in this map uses nrmse_bar.png/);
    expect(describeTrace(g, traceProvenance(g, { nodeId: dataNodeId("pscad_base.csv"), mode: "upstream" })!).headline).toMatch(/does not come from anything else/);
  });
});

describe("trace on the canvas and in state", () => {
  const base = { graph: g, impact: null, story: { enabled: false, index: 0 } };
  const trace = traceProvenance(g, { nodeId: dataNodeId("nrmse_bar.png"), mode: "upstream" })!;

  it("numbers the steps, highlights the path and dims everything else", () => {
    const { nodes, edges } = buildRenderGraph({ ...base, trace });
    const step = Object.fromEntries(nodes.filter((n) => n.data.traceStep).map((n) => [n.data.label, n.data.traceStep]));
    expect(step["nrmse_bar.png"]).toBe(trace.nodeIds.length); // the target is the last step
    expect(Object.keys(step).sort()).toEqual(labels(trace));
    expect(nodes.filter((n) => n.data.dimmed).map((n) => n.data.label)).toEqual(expect.arrayContaining(["overlay_boundary.png"]));
    expect(nodes.every((n) => n.data.traced === !n.data.dimmed)).toBe(true);
    expect(edges.filter((e) => e.data!.isTrace).map((e) => e.id).sort()).toEqual([...trace.edgeIds].sort());
    expect(edges.find((e) => !e.data!.isTrace)!.style!.opacity).toBeLessThan(0.5);
  });

  it("suppresses impact and story visuals while tracing, and yields to the health view", () => {
    const impact = analyzeImpactLocally(g, "Change the CSV column layout of the PSCAD files", null);
    expect(buildRenderGraph({ ...base, impact, trace }).nodes.every((n) => n.data.status === "normal")).toBe(true);

    const withHealth = buildRenderGraph({ ...base, trace, health: analyzeHealth(g) });
    expect(withHealth.nodes.some((n) => n.data.traced)).toBe(false);
    expect(withHealth.nodes.every((n) => n.data.heat)).toBe(true);
  });

  it("takes over from focus mode", () => {
    const { nodes } = buildRenderGraph({ ...base, trace, focusNodeId: "load-trace" });
    expect(nodes.filter((n) => !n.data.dimmed).map((n) => n.data.label).sort()).toEqual(labels(trace));
  });

  it("is stored in and cleared from workspace state, and reset when a graph loads", () => {
    const state = workspaceReducer(
      { graph: g, selectedNodeId: null, activeTab: "inspector", impactPrompt: "", impact: { status: "idle", result: null }, story: { enabled: false, index: 0, isPlaying: false, narrative: null, status: "idle" }, scaffold: { status: "idle", result: null }, focusEnabled: false, trace: null, notice: null } as WorkspaceState,
      { type: "setTrace", trace: { nodeId: trace.nodeId, mode: "upstream" } },
    );
    expect(state.trace).toEqual({ nodeId: trace.nodeId, mode: "upstream" });
    expect(workspaceReducer(state, { type: "setTrace", trace: null }).trace).toBeNull();
    expect(workspaceReducer(state, { type: "loadGraph", graph: authMicroservice }).trace).toBeNull();
  });
});
