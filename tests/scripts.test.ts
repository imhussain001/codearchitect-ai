import { describe, expect, it } from "vitest";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { analyzeScriptFiles, dataNodeId, headerComment, lexSource, matlabStructure, MAX_DATA_NODES, scanDataRefs } from "@/lib/engines/scripts";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { analyzeHealth } from "@/lib/engines/health";
import { powerSystemsMatlab } from "@/lib/mock/powerSystems";
import { GraphSchema } from "@/lib/graphSchema";

const matlab = (code: string) => lexSource(code, "matlab");
const python = (code: string) => lexSource(code, "python");

describe("lexSource (MATLAB)", () => {
  it("removes comments but keeps strings that contain comment characters", () => {
    const [line] = matlab("x = 'a % not a comment'; % real comment");
    expect(line!.literals).toEqual(["a % not a comment"]);
    expect(line!.text).not.toContain("real comment");
  });

  it("tells the transpose operator from a string", () => {
    const [transpose, str, spaced] = matlab("y = x';\nname = 'data.csv';\ndisp 'hello'");
    expect(transpose!.literals).toEqual([]);
    expect(str!.literals).toEqual(["data.csv"]);
    expect(spaced!.literals).toEqual(["hello"]);
  });

  it("handles doubled quotes, double-quoted strings and block comments", () => {
    const lines = matlab("a = 'it''s.csv';\nb = \"x.mat\";\n%{\nc = 'hidden.csv';\n%}\nd = 'seen.csv';");
    expect(lines[0]!.literals).toEqual(["it's.csv"]);
    expect(lines[1]!.literals).toEqual(["x.mat"]);
    expect(lines[3]!.literals).toEqual([]);
    expect(lines[5]!.literals).toEqual(["seen.csv"]);
  });

  it("treats ... as the start of a comment", () => {
    expect(matlab("x = [1, 2, ... 'ignored.csv'\n 3];")[0]!.literals).toEqual([]);
  });
});

describe("lexSource (Python)", () => {
  it("skips comments and docstrings but keeps ordinary literals", () => {
    const lines = python('"""doc with old.csv"""\nx = "a.csv"  # b.csv\n');
    expect(lines[0]!.literals).toEqual([]);
    expect(lines[1]!.literals).toEqual(["a.csv"]);
  });

  it("handles escapes and multi-line triple quotes", () => {
    const lines = python("s = 'it\\'s.txt'\n'''\nstill.csv\n'''\nt = 'real.json'");
    expect(lines[0]!.literals).toEqual(["it's.txt"]);
    expect(lines[2]!.literals).toEqual([]);
    expect(lines[4]!.literals).toEqual(["real.json"]);
  });
});

describe("scanDataRefs", () => {
  const scan = (code: string, lang: "matlab" | "python" = "matlab") => scanDataRefs(lexSource(code, lang), lang);

  it("classifies reads, writes and image outputs", () => {
    const refs = scan("T = readtable('in.csv');\nwritetable(T, 'out.csv');\nexportgraphics(gcf, 'fig.png');\nload('state.mat');");
    const byPath = Object.fromEntries(refs.map((r) => [r.path, r.mode]));
    expect(byPath).toEqual({ "in.csv": "reads", "out.csv": "writes", "fig.png": "writes", "state.mat": "reads" });
  });

  it("finds file names listed in cell arrays, as real scripts do", () => {
    const refs = scan("files = {'a.csv', 'b.csv'};\nfor f = files, T = readmatrix(f{1}); end");
    expect(refs.map((r) => r.path)).toEqual(["a.csv", "b.csv"]);
    expect(refs.every((r) => r.mode === "reads")).toBe(true);
  });

  it("recognises fopen modes and reports read+write as write", () => {
    const refs = scan("fid = fopen('log.txt', 'w');\nx = readtable('both.csv');\nwritetable(x, 'both.csv');");
    expect(refs.find((r) => r.path === "log.txt")!.mode).toBe("writes");
    expect(refs.find((r) => r.path === "both.csv")!.mode).toBe("writes");
  });

  it("flags names built at run time as patterns and ignores URLs and unknown extensions", () => {
    const refs = scan("a = '_base.csv'; b = '%s_run.csv'; c = 'https://x.org/d.csv'; d = 'notes.docx'; e = 'ok.csv';");
    expect(Object.fromEntries(refs.map((r) => [r.path, r.isPattern]))).toEqual({ "_base.csv": true, "%s_run.csv": true, "ok.csv": false });
  });

  it("works for Python", () => {
    const refs = scan("df = pd.read_csv('in.csv')\ndf.to_csv('out.csv')\nplt.savefig('plot.png')\nwith open('log.txt', 'w') as f: pass", "python");
    expect(Object.fromEntries(refs.map((r) => [r.path, r.mode]))).toEqual({ "in.csv": "reads", "out.csv": "writes", "plot.png": "writes", "log.txt": "writes" });
  });
});

describe("matlabStructure and headerComment", () => {
  it("reads function names, parameters and file kind", () => {
    const s = matlabStructure(matlab("function [a, b] = compute(x, y, varargin)\n  a = x;\nend\nfunction helper()\nend"));
    expect(s.functions).toEqual(["compute", "helper"]);
    expect(s.isFunctionFile).toBe(true);
    expect(s.params.map((p) => p.name)).toEqual(["x", "y"]);
    expect(matlabStructure(matlab("x = 1;\nfunction f()\nend")).isFunctionFile).toBe(false);
  });

  it("uses the leading comment as a description, and the one after a function line", () => {
    expect(headerComment("%% title.m\n% Does the thing.\n% And more.\n\nx = 1;", "matlab")).toBe("title.m Does the thing. And more.");
    expect(headerComment("function f()\n% F  Adds one.\nend", "matlab")).toBe("F Adds one.");
    expect(headerComment("x = 1;", "matlab")).toBeUndefined();
  });
});

describe("buildHeuristicGraph with scripts", () => {
  const graph = powerSystemsMatlab;
  const byLabel = (label: string) => graph.nodes.find((n) => n.data.label === label)!;

  it("maps the sample pipeline: entry script, helpers, data files", () => {
    expect(graph.nodes.filter((n) => n.data.filePath.endsWith(".m"))).toHaveLength(6);
    expect(byLabel("Run Study").data.kind).toBe("api");
    expect(byLabel("Make Report").data.kind).toBe("api");
    expect(byLabel("Plot Overlay").data.kind).toBe("frontend");
    expect(byLabel("Load Trace").data.kind).toBe("logic");
    expect(graph.nodes.filter((n) => n.data.kind === "data").map((n) => n.data.label).sort()).toEqual(
      ["nrmse_bar.png", "nrmse_results.csv", "overlay_boundary.png", "pscad_base.csv", "pscad_lvl1.csv", "pscad_lvl2.csv", "psse_boundary.csv"].sort(),
    );
    expect(graph.kindLabels).toMatchObject({ data: "Data files", api: "Entry scripts" });
  });

  it("lays script graphs out entry scripts first, data files last", () => {
    const y = (label: string) => byLabel(label).position.y;
    expect(y("Run Study")).toBeLessThan(y("Load Trace"));
    expect(y("Load Trace")).toBeLessThan(y("Plot Overlay"));
    expect(y("Plot Overlay")).toBeLessThan(y("pscad_base.csv"));
  });

  it("links the entry script to the functions it calls and to its data", () => {
    const run = byLabel("Run Study").id;
    const targets = graph.edges.filter((e) => e.source === run).map((e) => `${e.relation}:${graph.nodes.find((n) => n.id === e.target)!.data.label}`);
    expect(targets).toEqual(
      expect.arrayContaining(["calls:Load Trace", "calls:Align Signals", "calls:Nrmse Percent", "calls:Plot Overlay", "reads:pscad_base.csv", "reads:psse_boundary.csv", "writes:nrmse_results.csv", "writes:overlay_boundary.png"]),
    );
    expect(graph.edges.every((e) => e.source !== e.target)).toBe(true);
  });

  it("takes descriptions, exports and parameters from the code", () => {
    expect(byLabel("Load Trace").data).toMatchObject({ description: expect.stringContaining("Read a simulation CSV"), exports: ["load_trace"], language: "matlab" });
    expect(byLabel("Align Signals").data.params.map((p) => p.name)).toEqual(["ref", "sig", "trimSeconds"]);
  });

  it("passes the shared graph schema and has no dangling edges", () => {
    expect(GraphSchema.safeParse(graph).success).toBe(true);
    const ids = new Set(graph.nodes.map((n) => n.id));
    expect(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
  });

  it("is healthy: no cycles or crossed layers", () => {
    const report = analyzeHealth(graph);
    expect(report.counts.cycles).toBe(0);
    expect(report.counts.layering).toBe(0);
  });

  it("answers the authored CSV-layout scenario, including the coupling the scan cannot see", () => {
    const result = analyzeImpactLocally(graph, "Change the CSV column layout of the PSCAD files", null);
    expect(result.scenarioId).toBe("csv-column-layout");
    expect(result.rootNodeId).toBe(dataNodeId("pscad_base.csv"));
    const severity = Object.fromEntries(result.impacts.map((i) => [graph.nodes.find((n) => n.id === i.nodeId)!.data.label, i.severity]));
    expect(severity["Load Trace"]).toBe("broken");
    expect(severity["Run Study"]).toBe("impacted");
    expect(result.diffs[0]!.after).toContain("readtable");
  });

  it("falls back to graph heuristics for a free-form prompt about a function", () => {
    const result = analyzeImpactLocally(graph, "Rename nrmse_percent to compute_nrmse", null);
    expect(graph.nodes.find((n) => n.id === result.rootNodeId)!.data.label).toBe("Nrmse Percent");
    expect(result.impacts.map((i) => graph.nodes.find((n) => n.id === i.nodeId)!.data.label)).toContain("Run Study");
  });
});

describe("analyzeScriptFiles edge cases", () => {
  const idFor = (files: Array<{ path: string }>) => new Map(files.map((f) => [f.path, f.path.replace(/\W+/g, "-")]));

  it("lets a local function shadow another file's name, and ignores struct fields and comments", () => {
    const files = [
      { path: "main.m", content: "function main()\n  helper(1);\n  s.other = 2; % other(3)\nend\nfunction helper(x)\nend" },
      { path: "helper.m", content: "function helper(x)\nend" },
      { path: "other.m", content: "function other()\nend" },
    ];
    const layer = analyzeScriptFiles(files, idFor(files));
    expect(layer.edges).toEqual([]);
  });

  it("groups data files beyond the cap into one node", () => {
    const refs = Array.from({ length: MAX_DATA_NODES + 6 }, (_, i) => `'f${i}.csv'`).join(", ");
    const files = [{ path: "many.m", content: `files = {${refs}};` }];
    const layer = analyzeScriptFiles(files, idFor(files));
    expect(layer.dataNodes).toHaveLength(MAX_DATA_NODES + 1);
    expect(layer.dataNodes.at(-1)!.data.label).toBe("+6 more data files");
    expect(layer.warnings.join(" ")).toMatch(/6 more are grouped/);
  });

  it("does nothing for non-script repositories", () => {
    const graph = buildHeuristicGraph("web", [
      { path: "src/a.ts", content: 'import { b } from "./b";\nexport const a = b;' },
      { path: "src/b.ts", content: "export const b = 1;" },
    ]);
    expect(graph.kindLabels).toBeUndefined();
    expect(graph.nodes.some((n) => n.data.kind === "data")).toBe(false);
  });

  it("adds data nodes for Python scripts alongside their imports", () => {
    const graph = buildHeuristicGraph("py", [
      { path: "analyze.py", content: 'import utils\nimport pandas as pd\ndf = pd.read_csv("runs.csv")\ndf.to_csv("summary.csv")\nif __name__ == "__main__":\n    pass\n' },
      { path: "utils.py", content: "def helper():\n    return 1\n" },
    ]);
    const labels = graph.nodes.map((n) => n.data.label).sort();
    expect(labels).toEqual(expect.arrayContaining(["runs.csv", "summary.csv", "Utils", "Analyze"]));
    const analyze = graph.nodes.find((n) => n.data.label === "Analyze")!;
    expect(analyze.data.kind).toBe("api");
    expect(graph.edges.map((e) => e.relation).sort()).toEqual(["imports", "reads", "writes"]);
  });
});
