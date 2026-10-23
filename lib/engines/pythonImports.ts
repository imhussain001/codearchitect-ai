import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * Python support for import analysis. The mapper used to say "this file imports that module";
 * this says *which names* it uses: `from cosim_app.state import AppState` links to the file that
 * defines `AppState` with `symbols: ["AppState"]`, `import utils; utils.helper()` records `helper`,
 * and `from cosim_app import state` follows `state` to `cosim_app/state.py` when that is a module.
 *
 * Lexical, like the other languages: no interpreter, no `sys.path`, no installed packages. The
 * project root is not known, so a dotted module is matched against the end of each file's path and
 * the closest one wins.
 */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Replace comments and string/docstring contents with spaces (offsets and newlines kept). */
function blankPython(source: string, { strings }: { strings: boolean }): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const fill = (t: string) => t.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = source[i]!;
    if (c === "#") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      out += fill(source.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < n && !source.startsWith(quote, j)) {
        if (source[j] === "\\") j++;
        else if (!triple && source[j] === "\n") break;
        j++;
      }
      const stop = Math.min(j + (source.startsWith(quote, j) ? quote.length : 0), n);
      out += strings ? fill(source.slice(i, stop)) : source.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/* ---------- Parsing ---------- */

export type PyName = { name: string; alias?: string };

export type PyImport = {
  /** `from <module> import …` or `import <module>`; empty for `from . import x`. */
  module: string;
  /** Leading dots of a relative import (`from ..pkg import x` is 2). */
  level: number;
  /** Names after `from … import`; empty for a plain `import`. */
  names: PyName[];
  star: boolean;
  /** Plain `import a.b.c [as x]`: the local name it binds. */
  alias?: string;
  isFrom: boolean;
  /** Inside a function, the usual way to break an import cycle. */
  deferred: boolean;
  /** Under `if TYPE_CHECKING:`; never runs. */
  typeOnly: boolean;
  /** Offsets of the whole statement in the source, to blank it when looking for uses. */
  range: [number, number];
};

type Block = { indent: number; kind: "def" | "class" | "typecheck" | "other" };

/** All imports of a file with where they sit (module level, in a function, under TYPE_CHECKING). */
export function parseImports(source: string): PyImport[] {
  const code = blankPython(source, { strings: true });
  const lines = code.split("\n");
  const out: PyImport[] = [];
  const stack: Block[] = [];
  let offset = 0;

  for (let i = 0; i < lines.length; i++) {
    const start = offset;
    let line = lines[i]!;
    let consumed = line.length + 1;

    // Join continuation lines: parentheses (`from a import (\n b,\n c)`) and trailing backslashes.
    const opensImport = /^\s*(?:from\s+\S+\s+)?import\b/.test(line) || /^\s*from\s/.test(line);
    if (opensImport) {
      while ((line.split("(").length > line.split(")").length || /\\\s*$/.test(line)) && i + 1 < lines.length) {
        i++;
        consumed += lines[i]!.length + 1;
        line = `${line.replace(/\\\s*$/, " ")} ${lines[i]!}`;
      }
    }
    offset += consumed;
    if (line.trim() === "") continue;

    const indent = line.length - line.trimStart().length;
    while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
    const text = line.trim();

    const head = /^(?:async\s+)?def\b/.test(text) ? "def" : /^class\b/.test(text) ? "class" : /^if\s+(?:typing\.)?TYPE_CHECKING\s*:/.test(text) ? "typecheck" : null;
    if (head) stack.push({ indent, kind: head });
    const deferred = stack.some((b) => b.kind === "def");
    const typeOnly = stack.some((b) => b.kind === "typecheck");
    const range: [number, number] = [start, start + consumed];

    const plain = new RegExp(String.raw`^import\s+(.+)$`).exec(text);
    const from = new RegExp(String.raw`^from\s+(\.*)\s*([\w.]*)\s+import\s+(.+)$`).exec(text);
    if (plain && !head) {
      for (const part of plain[1]!.split(",")) {
        const m = new RegExp(String.raw`^\s*([\w.]+)(?:\s+as\s+(${IDENT}))?\s*$`).exec(part);
        if (m) out.push({ module: m[1]!, level: 0, names: [], star: false, isFrom: false, deferred, typeOnly, range, ...(m[2] ? { alias: m[2] } : {}) });
      }
    } else if (from && !head) {
      const list = from[3]!.replace(/[()]/g, " ").trim();
      const star = list === "*";
      const names = star
        ? []
        : list
            .split(",")
            .map((p) => new RegExp(String.raw`^\s*(${IDENT})(?:\s+as\s+(${IDENT}))?\s*$`).exec(p))
            .flatMap((m) => (m ? [{ name: m[1]!, ...(m[2] ? { alias: m[2] } : {}) }] : []));
      out.push({ module: from[2]!, level: from[1]!.length, names, star, isFrom: true, deferred, typeOnly, range });
    }
  }
  return out;
}

/** Public module-level names: `__all__` if the file defines one, else top-level `def`, `class` and assignments not starting with `_`. */
export function pythonExports(source: string): string[] {
  const noComments = blankPython(source, { strings: false });
  const all = new RegExp(String.raw`^__all__\s*=\s*[\[(]([^\])]*)[\])]`, "m").exec(noComments);
  if (all) return [...all[1]!.matchAll(new RegExp(String.raw`["'](${IDENT})["']`, "g"))].map((m) => m[1]!);

  const code = blankPython(source, { strings: true });
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(String.raw`^(?:async\s+)?(?:def|class)\s+(${IDENT})`, "gm"))) names.add(m[1]!);
  for (const m of code.matchAll(new RegExp(String.raw`^(${IDENT})\s*(?::[^=\n]+)?=[^=]`, "gm"))) names.add(m[1]!);
  return [...names].filter((n) => !n.startsWith("_"));
}

/* ---------- Resolution ---------- */

const stripPy = (path: string) => path.replace(/\.py$/i, "").replace(/\/__init__$/, "");
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/** How many leading directories two paths share: the closer file wins when a module name matches several. */
function sharedPrefix(a: string, b: string): number {
  const pa = a.split("/");
  const pb = b.split("/");
  let n = 0;
  while (n < pa.length - 1 && n < pb.length - 1 && pa[n] === pb[n]) n++;
  return n;
}

class ModuleIndex {
  /** module path ("a/b/c") → files that define it (a `.py` file or a package's `__init__.py`). */
  private readonly byModule = new Map<string, string[]>();

  constructor(paths: readonly string[]) {
    for (const path of paths) {
      const key = stripPy(path);
      (this.byModule.get(key) ?? this.byModule.set(key, []).get(key)!).push(path);
    }
  }

  /** The file for an absolute dotted module, matched on the end of the path; the closest to `from` wins. */
  absolute(module: string, from: string): string | undefined {
    const wanted = module.split(".").join("/");
    let best: { path: string; score: number } | undefined;
    for (const [key, paths] of this.byModule) {
      if (key !== wanted && !key.endsWith(`/${wanted}`)) continue;
      for (const path of paths) {
        const score = sharedPrefix(path, from) * 1000 - path.length;
        if (!best || score > best.score) best = { path, score };
      }
    }
    return best?.path;
  }

  /** A relative import: `level` dots start at the importer's own package. */
  relative(level: number, module: string, from: string): string | undefined {
    let dir = dirOf(from);
    for (let i = 1; i < level; i++) dir = dirOf(dir);
    const wanted = [dir, ...module.split(".").filter(Boolean)].filter(Boolean).join("/");
    const hits = this.byModule.get(wanted);
    return hits?.find((p) => p.endsWith("__init__.py")) ?? hits?.[0];
  }
}

const countUses = (code: string, name: string) => [...code.matchAll(new RegExp(String.raw`(?<![\w$.])${name}(?![\w$])`, "g"))].length;
const attributesOf = (code: string, local: string) => [...code.matchAll(new RegExp(String.raw`(?<![\w$.])${local.replace(/\./g, String.raw`\.`)}\s*\.\s*(${IDENT})`, "g"))].map((m) => m[1]!);

/**
 * Edges for the Python files in `files`.
 * - `from a.b import C` → the file defining module `a.b`, symbol `C` (only if `C` is used)
 * - `from a import b` where `a/b.py` exists → that module, with the attributes used through it
 * - `import a.b as x` → the module, with the attributes used as `x.attr`
 * - `from a import *` → the module, symbol `*`
 * Deferred imports (inside a function) and `TYPE_CHECKING` imports are marked `typeOnly`, so health does
 * not call a deliberate cycle-breaker a cycle; blast radius and rules still see them.
 * Imports in `__init__.py` count as used: they are how a package exposes its names.
 */
export function pythonEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>): DependencyEdge[] {
  const py = files.filter((f) => /\.py$/i.test(f.path) && idForPath.has(f.path));
  if (py.length === 0) return [];
  const index = new ModuleIndex(py.map((f) => f.path));

  const merged = new Map<string, DependencyEdge>();
  const add = (from: string, to: string, symbols: string[], flagged: boolean) => {
    if (from === to) return;
    const source = idForPath.get(from)!;
    const target = idForPath.get(to)!;
    const id = `e-${source}--${target}`;
    const clean = [...new Set(symbols)].sort();
    const existing = merged.get(id);
    if (!existing) return void merged.set(id, { id, source, target, relation: "imports", ...(flagged ? { typeOnly: true } : {}), symbols: clean });
    existing.symbols = [...new Set([...(existing.symbols ?? []), ...clean])].sort();
    if (!flagged) delete existing.typeOnly; // a real module-level import makes it a real dependency
  };

  for (const file of py) {
    const isPackageInit = file.path.endsWith("__init__.py");
    const imports = parseImports(file.content);
    // Code with every import statement removed, so a name is "used" only by real code.
    const body = blankPython(file.content, { strings: true }).split("");
    for (const imp of imports) for (let i = imp.range[0]; i < imp.range[1] && i < body.length; i++) if (body[i] !== "\n") body[i] = " ";
    const code = body.join("");

    for (const imp of imports) {
      const flagged = imp.deferred || imp.typeOnly;
      const resolve = (module: string) => (imp.level > 0 ? index.relative(imp.level, module, file.path) : module ? index.absolute(module, file.path) : undefined);

      if (!imp.isFrom) {
        const target = resolve(imp.module);
        if (!target) continue;
        const local = imp.alias ?? imp.module;
        add(file.path, target, attributesOf(code, local), flagged);
        continue;
      }

      const moduleFile = resolve(imp.module);
      if (imp.star) {
        if (moduleFile) add(file.path, moduleFile, ["*"], flagged);
        continue;
      }
      for (const { name, alias } of imp.names) {
        const local = alias ?? name;
        const used = isPackageInit || countUses(code, local) > 0;
        const dotted = imp.module ? `${imp.module}.${name}` : name;
        const submodule = imp.level > 0 ? index.relative(imp.level, dotted, file.path) : index.absolute(dotted, file.path);
        if (submodule && submodule !== moduleFile) {
          // `from pkg import mod`: the name is a module, and its attributes are what is used.
          add(file.path, submodule, attributesOf(code, local), flagged);
        } else if (moduleFile && used) {
          add(file.path, moduleFile, [name], flagged);
        }
      }
    }
  }
  return [...merged.values()];
}
