import { describe, expect, it } from "vitest";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { parseImports, pythonExports } from "@/lib/engines/pythonImports";
import { analyzeHealth } from "@/lib/engines/health";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { exportUsage } from "@/lib/engines/symbols";

describe("parseImports", () => {
  it("reads plain, aliased, from, relative, star and multi-line forms", () => {
    const src = `import os, sys as system
import a.b.c as abc
from pkg.mod import One, Two as Deux
from . import sibling
from ..up import thing
from lib import *
from big import (
    first,
    second as s2,
)
`;
    const imports = parseImports(src);
    expect(imports.map((i) => [i.module, i.level, i.isFrom, i.alias ?? null, i.star])).toEqual([
      ["os", 0, false, null, false],
      ["sys", 0, false, "system", false],
      ["a.b.c", 0, false, "abc", false],
      ["pkg.mod", 0, true, null, false],
      ["", 1, true, null, false],
      ["up", 2, true, null, false],
      ["lib", 0, true, null, true],
      ["big", 0, true, null, false],
    ]);
    expect(imports[3]!.names).toEqual([{ name: "One" }, { name: "Two", alias: "Deux" }]);
    expect(imports[7]!.names).toEqual([{ name: "first" }, { name: "second", alias: "s2" }]);
  });

  it("ignores imports in comments and strings", () => {
    const src = `# import fake\n"""import docstring_fake"""\ns = "from x import y"\nimport real\n`;
    expect(parseImports(src).map((i) => i.module)).toEqual(["real"]);
  });

  it("marks imports inside functions as deferred and under TYPE_CHECKING as type-only", () => {
    const src = `import top\n\ndef f():\n    import lazy\n\nclass C:\n    def m(self):\n        from also_lazy import x\n\nif TYPE_CHECKING:\n    from typed import T\n\nif __name__ == "__main__":\n    import main_only\n`;
    const byModule = Object.fromEntries(parseImports(src).map((i) => [i.module, i]));
    expect(byModule["top"]).toMatchObject({ deferred: false, typeOnly: false });
    expect(byModule["lazy"]).toMatchObject({ deferred: true, typeOnly: false });
    expect(byModule["also_lazy"]).toMatchObject({ deferred: true });
    expect(byModule["typed"]).toMatchObject({ deferred: false, typeOnly: true });
    expect(byModule["main_only"]).toMatchObject({ deferred: false, typeOnly: false });
  });
});

describe("pythonExports", () => {
  it("lists public top-level functions, classes and constants, not private or nested ones", () => {
    const src = `import os\nVERSIONS = ["a"]\nMAP: dict = {}\n_hidden = 1\ndef run():\n    inner = 1\n    def nested(): pass\nclass Repo:\n    attr = 2\nasync def go(): pass\nx == 3\n`;
    expect(pythonExports(src).sort()).toEqual(["MAP", "Repo", "VERSIONS", "go", "run"]);
  });

  it("uses __all__ when the file defines one", () => {
    expect(pythonExports(`__all__ = ["a", 'b']\ndef a(): pass\ndef b(): pass\ndef c(): pass\n`)).toEqual(["a", "b"]);
  });
});

/** Shaped like a real project: scripts at the top, a package below, `from pkg import module`, relative imports. */
const files = [
  { path: "BAT1/main.py", content: `from cosim_app import state\nfrom cosim_app.state import AppState, PSSE_VERSIONS\nfrom cosim_app.screens import home\nimport cosim_app.util as util\nimport os, time\n\ndef run():\n    s = AppState()\n    util.helper(state.DEFAULT)\n    home.show(PSSE_VERSIONS)\n` },
  { path: "BAT1/cosim_app/__init__.py", content: `from .state import AppState\n` },
  { path: "BAT1/cosim_app/state.py", content: `from dataclasses import dataclass\nPSSE_VERSIONS = ["35.6"]\nDEFAULT = 1\nUNUSED_CONSTANT = 2\n\n@dataclass\nclass AppState:\n    mode: str = "AREA"\n` },
  { path: "BAT1/cosim_app/util.py", content: `def helper(x):\n    return x\n\ndef never_used():\n    return 0\n` },
  { path: "BAT1/cosim_app/screens/__init__.py", content: `` },
  { path: "BAT1/cosim_app/screens/home.py", content: `from ..state import AppState\nfrom .. import util\nfrom . import widgets\n\ndef show(versions):\n    widgets.draw(AppState(), util.helper(1))\n` },
  { path: "BAT1/cosim_app/screens/widgets.py", content: `def draw(a, b):\n    from ..state import DEFAULT\n    return DEFAULT\n` },
];
const graph = buildHeuristicGraph("cosim", files);
const idOf = (suffix: string) => graph.nodes.find((n) => n.data.filePath.endsWith(suffix))!.id;
const edge = (from: string, to: string) => graph.edges.find((e) => e.source === idOf(from) && e.target === idOf(to));

describe("Python edges", () => {
  it("links `from pkg import module` to the module file, with the attributes used through it", () => {
    expect(edge("BAT1/main.py", "cosim_app/state.py")?.symbols).toEqual(["AppState", "DEFAULT", "PSSE_VERSIONS"]);
    expect(edge("BAT1/main.py", "cosim_app/screens/home.py")?.symbols).toEqual(["show"]);
  });

  it("follows `import a.b as x` and names what is used as x.attr", () => {
    expect(edge("BAT1/main.py", "cosim_app/util.py")?.symbols).toEqual(["helper"]);
  });

  it("resolves relative imports of both kinds", () => {
    expect(edge("screens/home.py", "cosim_app/state.py")?.symbols).toEqual(["AppState"]);
    expect(edge("screens/home.py", "cosim_app/util.py")?.symbols).toEqual(["helper"]);
    expect(edge("screens/home.py", "screens/widgets.py")?.symbols).toEqual(["draw"]);
  });

  it("treats a package's __init__ imports as used (they re-export)", () => {
    expect(edge("cosim_app/__init__.py", "cosim_app/state.py")?.symbols).toEqual(["AppState"]);
  });

  it("ignores the standard library and third-party packages", () => {
    expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.target))).toBe(true);
    expect(graph.edges.some((e) => graph.nodes.find((n) => n.id === e.target)!.data.filePath.includes("dataclasses"))).toBe(false);
  });

  it("marks a deferred import (inside a function) so health does not report a cycle it breaks", () => {
    expect(edge("screens/widgets.py", "cosim_app/state.py")?.typeOnly).toBe(true);
    const loop = buildHeuristicGraph("l", [
      { path: "a.py", content: `import b\ndef f():\n    return b.g()\n` },
      { path: "b.py", content: `def g():\n    import a\n    return a.f\n` },
    ]);
    expect(loop.edges).toHaveLength(2);
    expect(analyzeHealth(loop).issues.filter((i) => i.kind === "cycle")).toEqual([]);
  });

  it("still reports a real module-level cycle", () => {
    const loop = buildHeuristicGraph("l", [
      { path: "a.py", content: `import b\nx = b.y\n` },
      { path: "b.py", content: `import a\ny = a.x\n` },
    ]);
    expect(analyzeHealth(loop).issues.filter((i) => i.kind === "cycle")).toHaveLength(1);
  });

  it("does not match a local file to a stdlib-looking name by accident", () => {
    const g = buildHeuristicGraph("t", [
      { path: "app/time_utils.py", content: `def now(): pass\n` },
      { path: "app/main.py", content: `import time\nprint(time.time())\n` },
    ]);
    expect(g.edges).toEqual([]);
  });

  it("links a star import to the module", () => {
    const g = buildHeuristicGraph("t", [
      { path: "m.py", content: `from consts import *\nprint(A)\n` },
      { path: "consts.py", content: `A = 1\n` },
    ]);
    expect(g.edges[0]!.symbols).toEqual(["*"]);
  });
});

describe("symbol-level answers for Python", () => {
  it("lists who uses each export, and which exports nothing uses", () => {
    const usage = Object.fromEntries(exportUsage(graph, idOf("cosim_app/util.py")).map((u) => [u.name, u]));
    expect(usage["helper"]!.users).toHaveLength(2); // main.py and home.py
    expect(usage["never_used"]!.users).toEqual([]);
  });

  it("narrows blast radius to the files that use the named export", () => {
    const result = analyzeImpactLocally(graph, "change never_used", idOf("cosim_app/util.py"));
    expect(result.impacts.map((i) => i.nodeId)).toEqual([idOf("cosim_app/util.py")]);
    const wide = analyzeImpactLocally(graph, "change helper", idOf("cosim_app/util.py"));
    expect(wide.impacts.length).toBeGreaterThan(2);
  });
});
