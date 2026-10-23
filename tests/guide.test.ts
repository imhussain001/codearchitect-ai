import { describe, expect, it } from "vitest";
import { buildGuide, MAX_PATH_STEPS } from "@/lib/engines/guide";
import { authMicroservice, ecommerceApi, powerSystemsMatlab } from "@/lib/mockData";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";

const labelOf = (g: typeof authMicroservice, id: string) => g.nodes.find((n) => n.id === id)!.data.label;

describe("buildGuide: web sample", () => {
  const guide = buildGuide(authMicroservice);

  it("starts at the component nothing else uses", () => {
    expect(guide.entryPoints.map((id) => labelOf(authMicroservice, id))).toEqual(["User Dashboard"]);
    expect(guide.path[0]!.role).toBe("entry");
    expect(guide.path[0]!.why).toMatch(/^Start here/);
  });

  it("reads each flow top to bottom: a component comes after something that uses it", () => {
    const index = new Map(guide.path.map((s, i) => [s.nodeId, i]));
    for (const e of authMicroservice.edges) {
      const from = index.get(e.source);
      const to = index.get(e.target);
      if (from !== undefined && to !== undefined && e.relation !== "writes") expect(from, `${e.source} -> ${e.target}`).toBeLessThan(to);
    }
  });

  it("lists every component exactly once when the map is small", () => {
    expect(new Set(guide.path.map((s) => s.nodeId)).size).toBe(authMicroservice.nodes.length);
    expect(guide.omitted).toBe(0);
  });

  it("names the layers and the entry point in the headline", () => {
    expect(guide.headline).toContain("Auth Microservice has 6 components");
    expect(guide.headline).toContain("Execution starts at User Dashboard");
  });

  it("ranks widely used components as key", () => {
    expect(guide.keyComponents.every((k) => k.usedBy >= 2)).toBe(true);
    const counts = guide.keyComponents.map((k) => k.usedBy);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
  });
});

describe("buildGuide: other shapes", () => {
  it("handles the MATLAB sample: the entry scripts come first and outputs are not entry points", () => {
    const guide = buildGuide(powerSystemsMatlab);
    const entries = guide.entryPoints.map((id) => labelOf(powerSystemsMatlab, id));
    expect(entries).toContain("Run Study");
    expect(guide.entryPoints.every((id) => powerSystemsMatlab.nodes.find((n) => n.id === id)!.data.kind !== "data")).toBe(true);
    expect(guide.layers.some((l) => l.label !== "")).toBe(true);
  });

  it("works on the e-commerce sample without repeating or dropping nodes", () => {
    const guide = buildGuide(ecommerceApi);
    expect(new Set(guide.path.map((s) => s.nodeId)).size).toBe(guide.path.length);
    expect(guide.path.length + guide.omitted).toBe(ecommerceApi.nodes.length);
  });

  it("caps the path on a large map and says how many were left out", () => {
    const files = Array.from({ length: 30 }, (_, i) => ({ path: `src/m${i}.ts`, content: i === 0 ? "" : `import { x } from "./m${i - 1}";\nexport const y${i} = x;\n` }));
    const guide = buildGuide(buildHeuristicGraph("chain", files, { maxFiles: 60 }));
    expect(guide.path).toHaveLength(MAX_PATH_STEPS);
    expect(guide.omitted).toBe(30 - MAX_PATH_STEPS);
  });

  it("still gives a path when everything is in a cycle (no entry point)", () => {
    const files = [
      { path: "src/a.ts", content: `import { b } from "./b";\nexport const a = b;\n` },
      { path: "src/b.ts", content: `import { a } from "./a";\nexport const b = a;\n` },
    ];
    const guide = buildGuide(buildHeuristicGraph("loop", files));
    expect(guide.entryPoints).toEqual([]);
    expect(guide.path).toHaveLength(2);
    expect(guide.headline).toContain("No clear entry point");
  });

  it("handles an empty graph", () => {
    const guide = buildGuide({ ...authMicroservice, nodes: [], edges: [] });
    expect(guide.path).toEqual([]);
    expect(guide.headline).toContain("0 components");
  });
});
