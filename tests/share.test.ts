import { describe, expect, it } from "vitest";
import { buildShareData, renderShareHtml, TRACE_JS } from "@/lib/share";
import { traceProvenance } from "@/lib/engines/provenance";
import { authMicroservice, powerSystemsMatlab } from "@/lib/mockData";
import type { ArchitectureGraph } from "@/lib/types";

const withCode = (g: ArchitectureGraph, code: string): ArchitectureGraph => ({ ...g, nodes: g.nodes.map((n, i) => (i === 0 ? { ...n, data: { ...n.data, code } } : n)) });

/** The embedded JSON, read back the way the page does. */
function embedded(html: string) {
  const m = /<script id="data" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  return JSON.parse(m![1]!);
}

describe("renderShareHtml", () => {
  const html = renderShareHtml(authMicroservice);

  it("is one self-contained document: no external scripts, styles, images or fetches", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).not.toMatch(/<script[^>]+\ssrc=/i);
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
    expect(html).not.toMatch(/\bfetch\(|XMLHttpRequest|import\(/);
  });

  it("draws every component with its id so the page can select it", () => {
    for (const n of authMicroservice.nodes) expect(html).toContain(`data-id="${n.id}"`);
  });

  it("embeds the data the page needs and round-trips through JSON", () => {
    const data = embedded(html);
    expect(data.nodes).toHaveLength(authMicroservice.nodes.length);
    expect(data.edges).toHaveLength(authMicroservice.edges.length);
    expect(data.guide.path[0].role).toBe("entry");
    expect(data.grade).toMatch(/^[A-F]$/);
  });

  it("cannot be broken out of by hostile source code", () => {
    const hostile = renderShareHtml(withCode(authMicroservice, `</script><img src=x onerror=alert(1)>\n<!-- x -->  `));
    expect(hostile.match(/<\/script>/g)).toHaveLength(2); // the data block and the client script, nothing from the code
    expect(hostile).not.toContain("<img src=x");
    expect(embedded(hostile).nodes[0].code).toContain("</script><img src=x onerror=alert(1)>");
  });

  it("escapes the title", () => {
    const named = renderShareHtml({ ...authMicroservice, name: `<b>"x"</b>` });
    expect(named).toContain("<title>&lt;b&gt;&quot;x&quot;&lt;/b&gt;: architecture</title>");
  });

  it("works for script projects with their own layer names", () => {
    const data = buildShareData(powerSystemsMatlab);
    expect(Object.values(data.kinds).some((k) => k.label !== "")).toBe(true);
    expect(data.nodes.some((n) => n.kind === "data")).toBe(true);
  });

  it("leaves builder drafts out", () => {
    const draft = { ...authMicroservice.nodes[0]!, id: "draft-x", data: { ...authMicroservice.nodes[0]!.data, label: "Draft Thing", isDraft: true } };
    expect(renderShareHtml({ ...authMicroservice, nodes: [...authMicroservice.nodes, draft] })).not.toContain("Draft Thing");
  });

  it("survives an empty graph", () => {
    expect(renderShareHtml({ ...authMicroservice, nodes: [], edges: [] })).toContain("Nothing to draw");
  });
});

describe("client script", () => {
  it("has the blast-radius highlight and the VS Code bridge, and the bridge is inert without VS Code", () => {
    const html = renderShareHtml(authMicroservice);
    expect(html).toContain("imp-direct");
    expect(html).toContain("Open in editor");
    // acquireVsCodeApi is only called behind a typeof check, so a plain browser never throws.
    expect(html).toContain("typeof acquireVsCodeApi === 'function'");
  });

  it("is valid JavaScript", () => {
    const html = renderShareHtml(authMicroservice);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
  });
});

describe("data-flow trace in the page", () => {
  const data = buildShareData(powerSystemsMatlab);
  // The page's own trace code, evaluated without a DOM.
  const { buildFlow, traceFrom } = new Function(`${TRACE_JS}; return { buildFlow, traceFrom };`)() as {
    buildFlow: (d: unknown) => unknown;
    traceFrom: (d: unknown, flow: unknown, id: string, mode: string) => Array<{ id: string; depth: number; role: string }>;
  };
  const flow = buildFlow(data);

  it("flags script projects as having data flow, and web projects as not", () => {
    expect(data.hasData).toBe(true);
    expect(buildShareData(authMicroservice).hasData).toBe(false);
  });

  it("gives exactly the same steps, order and roles as the engine, for every component and both directions", () => {
    for (const node of powerSystemsMatlab.nodes) {
      for (const mode of ["upstream", "downstream"] as const) {
        const engine = traceProvenance(powerSystemsMatlab, { nodeId: node.id, mode })!;
        const page = traceFrom(data, flow, node.id, mode);
        expect(page.map((s) => [s.id, s.role]), `${mode} ${node.id}`).toEqual(engine.steps.map((s) => [s.nodeId, s.role]));
      }
    }
  });

  it("is what the sample says: a figure traces back through the intermediate file to the raw inputs", () => {
    const fig = powerSystemsMatlab.nodes.find((n) => n.data.filePath === "nrmse_bar.png")!;
    const steps = traceFrom(data, flow, fig.id, "upstream");
    expect(steps[0]!.role).toBe("input");
    expect(steps.at(-1)!.id).toBe(fig.id);
    expect(steps.some((s) => s.role === "produced")).toBe(true);
  });

  it("ships the trace controls and numbered badges in the page", () => {
    const html = renderShareHtml(powerSystemsMatlab);
    expect(html).toContain("Where it comes from");
    expect(html).toContain("What it affects");
    expect(html).toContain("tbadge");
    expect(html).toContain("Written by");
  });
});
