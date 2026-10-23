import { describe, expect, it } from "vitest";
import { buildMarkdownReport, renderSvg, toMermaid } from "@/lib/export";
import { authMicroservice, powerSystemsMatlab } from "@/lib/mockData";
import { analyzeHealth } from "@/lib/engines/health";
import { traceProvenance } from "@/lib/engines/provenance";
import { dataNodeId } from "@/lib/engines/scripts";
import { buildRenderGraph } from "@/lib/viewModel";

describe("toMermaid", () => {
  it("emits one node per component and one arrow per dependency", () => {
    const text = toMermaid(authMicroservice);
    expect(text.startsWith("flowchart TD")).toBe(true);
    const nodeLines = text.split("\n").filter((l) => /^\s+n\d+\["/.test(l));
    expect(nodeLines).toHaveLength(authMicroservice.nodes.length);
    const arrows = text.split("\n").filter((l) => /\s-(\.->|->)/.test(l) || /-->/.test(l));
    expect(arrows).toHaveLength(authMicroservice.edges.length);
  });

  it("uses the graph's own layer names and dotted arrows for writes", () => {
    const text = toMermaid(powerSystemsMatlab);
    expect(text).toContain("-.->");
    expect(text).toMatch(/subgraph L_\w+\["[^"]+"\]/);
  });

  it("escapes quotes in labels", () => {
    const graph = { ...authMicroservice, nodes: authMicroservice.nodes.map((n, i) => (i === 0 ? { ...n, data: { ...n.data, label: 'Say "hi"' } } : n)) };
    expect(toMermaid(graph)).toContain("Say &quot;hi&quot;");
  });

  it("leaves builder drafts out", () => {
    const draft = { ...authMicroservice.nodes[0]!, id: "draft-x", data: { ...authMicroservice.nodes[0]!.data, label: "Draft Thing", isDraft: true } };
    expect(toMermaid({ ...authMicroservice, nodes: [...authMicroservice.nodes, draft] })).not.toContain("Draft Thing");
  });
});

describe("buildMarkdownReport", () => {
  it("contains the diagram, components, dependencies and health sections", () => {
    const md = buildMarkdownReport(authMicroservice);
    for (const heading of ["# Architecture:", "## Diagram", "```mermaid", "## Components", "## Dependencies", "## Health"]) expect(md).toContain(heading);
    expect(md).toContain(`health **${analyzeHealth(authMicroservice).grade}**`);
  });

  it("includes a data-flow section only when a trace is supplied", () => {
    const trace = traceProvenance(powerSystemsMatlab, { nodeId: dataNodeId("nrmse_results.csv"), mode: "upstream" })!;
    expect(buildMarkdownReport(powerSystemsMatlab)).not.toContain("Data-flow trace");
    expect(buildMarkdownReport(powerSystemsMatlab, { trace })).toContain("Data-flow trace");
  });

  it("is deterministic unless a date is passed", () => {
    expect(buildMarkdownReport(authMicroservice)).toBe(buildMarkdownReport(authMicroservice));
    expect(buildMarkdownReport(authMicroservice, { generatedOn: "2026-01-01" })).toContain("generated 2026-01-01");
  });
});

describe("renderSvg", () => {
  const { nodes, edges } = buildRenderGraph({ graph: authMicroservice, impact: null, story: { enabled: false, index: 0 } });

  it("draws every node and edge into a well-formed, sized document", () => {
    const { svg, width, height } = renderSvg(nodes, edges, { title: "Auth" });
    expect(svg).toContain(`viewBox="0 0 ${width} ${height}"`);
    expect(svg.match(/<path d="M [^"]*" fill="none"/g)).toHaveLength(edges.length);
    for (const n of nodes) expect(svg).toContain(n.data.label);
    expect(svg.trim().endsWith("</svg>")).toBe(true);
  });

  it("escapes markup in labels", () => {
    const hostile = nodes.map((n, i) => (i === 0 ? { ...n, data: { ...n.data, label: "<script>&" } } : n));
    const { svg } = renderSvg(hostile, edges);
    expect(svg).not.toContain("<script>");
    expect(svg).toContain("&lt;script&gt;&amp;");
  });

  it("skips hidden nodes and the edges that touch them", () => {
    const hidden = nodes.map((n, i) => (i === 0 ? { ...n, hidden: true } : n));
    const { svg } = renderSvg(hidden, edges);
    expect(svg).not.toContain(`>${nodes[0]!.data.label}<`);
    const touching = edges.filter((e) => e.source === nodes[0]!.id || e.target === nodes[0]!.id).length;
    expect(svg.match(/<path d="M [^"]*" fill="none"/g)).toHaveLength(edges.length - touching);
  });

  it("returns a valid placeholder for an empty graph", () => {
    const { svg, width } = renderSvg([], []);
    expect(svg).toContain("Nothing to draw");
    expect(width).toBeGreaterThan(0);
  });
});

describe("report onboarding section", () => {
  it("opens with where to start, ahead of the component tables", () => {
    const md = buildMarkdownReport(authMicroservice);
    expect(md).toContain("## Where to start");
    expect(md.indexOf("## Where to start")).toBeLessThan(md.indexOf("## Components"));
    expect(md).toContain("Start here");
  });
});
