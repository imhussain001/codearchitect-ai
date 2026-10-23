import { describe, expect, it } from "vitest";
import { buildShareData, renderShareHtml } from "@/lib/share";
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
  it("is valid JavaScript", () => {
    const html = renderShareHtml(authMicroservice);
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
    expect(scripts).toHaveLength(1);
    expect(() => new Function(scripts[0]!)).not.toThrow();
  });
});
