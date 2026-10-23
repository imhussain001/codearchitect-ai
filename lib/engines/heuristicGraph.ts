import { layoutByKind, SCRIPT_LAYER_ORDER } from "@/lib/graph";
import { analyzeScriptFiles, matlabFunctions } from "@/lib/engines/scripts";
import { goEdges, goExports, goImports } from "@/lib/engines/goImports";
import { javaEdges, javaExports, javaImports } from "@/lib/engines/javaImports";
import { rustEdges, rustExports, rustTestOnlyPaths, rustUses } from "@/lib/engines/rustImports";
import { parseImports as parsePythonImports, pythonEdges, pythonExports } from "@/lib/engines/pythonImports";
import { importedSymbols } from "@/lib/engines/symbols";
import type { ArchitectureGraph, ArchNode, CodeParam, DependencyEdge, NodeKind, SourceFile } from "@/lib/types";

const SOURCE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|rb|cs|php|vue|svelte|m)$/i;
const IGNORED_PATHS =
  /(^|\/)(node_modules|dist|build|out|\.next|\.git|vendor|testdata|venv|\.venv|__pycache__|coverage|target)(\/|$)|\.d\.ts$|(\.|_)(test|spec|stories)\.|(^|\/)(__tests__|tests?)\//i;
/** Maven site resources (generated diagrams, vendored scripts) and minified bundles are not source. */
const NON_SOURCE_ASSETS = /(^|\/)src\/site\/|\.min\.(js|mjs)$/i;
/** Java test classes (`FooTest.java`, `FooIT.java`). Case-sensitive on purpose: `Audit.java` is not a test. */
const JAVA_TESTS = /[a-z0-9](Test|Tests|IT)\.java$/;
/** Java files that declare no types: documentation and module descriptors. */
const JAVA_NON_CODE = /(^|\/)(package|module)-info\.java$/;
const CONFIG_FILES = /(^|\/)[^/]*(config|rc)\.(c|m)?(js|ts)$/i;

/** Files the local engine maps by default; the most architecturally relevant ones are kept. */
export const MAX_GRAPH_FILES = 400;
/** The most a user may ask for: past this a canvas is slow to draw and too dense to read. */
export const MAX_MAPPABLE_FILES = 2_000;
export const MIN_MAPPED_FILES = 20;
/** Files an AI model groups into components: bounded by what fits in its prompt. */
export const MAX_AI_FILES = 60;

/** A user-supplied limit, kept inside what the engine and the canvas can handle. */
export function clampMaxFiles(value: number): number {
  return Number.isFinite(value) ? Math.min(MAX_MAPPABLE_FILES, Math.max(MIN_MAPPED_FILES, Math.round(value))) : MAX_GRAPH_FILES;
}
const MAX_NODE_CODE_LINES = 120;

const KIND_RULES: Array<{ kind: NodeKind; pattern: RegExp }> = [
  { kind: "data", pattern: /(Repository|Dao|Entity)\.java$|(^|\/)(db|database|models?|schemas?|prisma|repositor(y|ies)|migrations?|cache|redis|entities|dal|store)(\/|\.|_|$)/i },
  { kind: "api", pattern: /(Controller|Resource|Endpoint)\.java$|(^|\/)(api|routes?|routers?|endpoints?|handlers?|urls\.py|views\.py)(\/|\.|$)|route\.(t|j)s$/i },
  { kind: "frontend", pattern: /\.(tsx|jsx|vue|svelte)$|(^|\/)(components|pages|screens|ui|views|app\/.*page)(\/|\.|$)/i },
];

export function classifyPath(path: string): NodeKind {
  return KIND_RULES.find((rule) => rule.pattern.test(path))?.kind ?? "logic";
}

export function isAnalyzableSource(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path) && !IGNORED_PATHS.test(path) && !CONFIG_FILES.test(path) && !JAVA_TESTS.test(path) && !JAVA_NON_CODE.test(path) && !NON_SOURCE_ASSETS.test(path);
}

const JS_IMPORT = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
const JS_EXPORT = /export\s+(default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const FIRST_SIGNATURE = /(?:function\s+\w+|func\s+\w+|fn\s+\w+|def\s+\w+|\w+\s*=\s*(?:async\s*)?)\s*\(([^)]*)\)/;

/**
 * Specifiers imported only through `import type` / `export type` (and never by value) in a file.
 * Type-only imports are erased at runtime, so they are not architectural coupling.
 */
export function typeOnlyImports(file: SourceFile): Set<string> {
  if (/\.(py|m|go|java|rs)$/.test(file.path)) return new Set();
  const typeSpecs = new Set<string>();
  const valueSpecs = new Set<string>();
  for (const match of file.content.matchAll(JS_IMPORT)) {
    const spec = match[1];
    if (!spec) continue;
    (/^(import|export)\s+type\b/.test(match[0]) ? typeSpecs : valueSpecs).add(spec);
  }
  return new Set([...typeSpecs].filter((s) => !valueSpecs.has(s)));
}

export function extractImports(file: SourceFile): string[] {
  if (file.path.endsWith(".go")) return [...new Set(goImports(file.content).map((i) => i.path))];
  if (file.path.endsWith(".rs")) return [...new Set(rustUses(file.content).map((u) => u.segments.join("::")))];
  if (file.path.endsWith(".java")) return [...new Set(javaImports(file.content).map((i) => i.name + (i.wildcard ? ".*" : "")))];
  if (file.path.endsWith(".py")) return [...new Set(parsePythonImports(file.content).map((i) => "." .repeat(i.level) + i.module).filter(Boolean))];
  const specs = new Set<string>();
  const pattern = JS_IMPORT;
  for (const match of file.content.matchAll(pattern)) {
    const spec = match[1];
    if (spec) specs.add(spec);
  }
  return [...specs];
}

/** Names in `export { a, b as c }` lists, with or without `from`: how modules re-export things declared elsewhere. */
const LISTED_EXPORT = /export\s+(?:type\s+)?\{([^}]*)\}/g;

function listedExports(content: string): string[] {
  const names: string[] = [];
  // Doc comments often show `export { a, b }` as an example; only real code counts.
  const code = content.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
  for (const m of code.matchAll(LISTED_EXPORT)) {
    for (const part of m[1]!.split(",")) {
      const cleaned = part.trim().replace(/^type\s+/, "");
      const exported = cleaned.split(/\s+as\s+/).pop()?.trim();
      if (exported && /^[A-Za-z_$][\w$]*$/.test(exported)) names.push(exported === "default" ? "default" : exported);
    }
  }
  return names.filter((n) => n !== "default");
}

export function extractExports(file: SourceFile): string[] {
  if (file.path.endsWith(".m")) return matlabFunctions(file.content);
  if (file.path.endsWith(".go")) return goExports(file.content);
  if (file.path.endsWith(".java")) return javaExports(file.content);
  if (file.path.endsWith(".rs")) return rustExports(file.content);
  if (file.path.endsWith(".py")) return pythonExports(file.content);
  return [...new Set([...[...file.content.matchAll(JS_EXPORT)].map((m) => (m[1] ? `default ${m[2]}` : m[2]!)), ...listedExports(file.content)])];
}

function extractParams(file: SourceFile): CodeParam[] {
  const signature = FIRST_SIGNATURE.exec(file.content)?.[1];
  if (!signature) return [];
  return signature
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p && p !== "self")
    .map((p) => {
      const [name, type] = p.split(/:(.*)/s).map((s) => s?.trim());
      return { name: (name ?? p).replace(/[{}?]/g, "").trim(), type: type || "unknown" };
    });
}

/** Files whose imports are analysed by their own language module instead of the JS/TS symbol scanner. */
const hasOwnImportAnalysis = (path: string) => /\.(py|m|go|java|rs)$/i.test(path);

function stripExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mjs|cjs|py|go|rs|java|vue|svelte|m)$/i, "").replace(/\/index$/, "");
}

function joinPath(base: string, relative: string): string {
  const parts = base.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
}

/** Resolve an import specifier to a file in the set; supports `./`, `../`, `@/` and `~/` aliases and Python modules. */
export function resolveImport(fromPath: string, spec: string, index: ReadonlyMap<string, string>): string | undefined {
  let candidate: string | undefined;
  if (spec.startsWith(".") && !fromPath.endsWith(".py")) candidate = joinPath(fromPath, spec);
  else if (/^[@~]\//.test(spec)) candidate = spec.slice(2);
  else if (fromPath.endsWith(".py")) candidate = spec.replace(/^\.+/, "").replace(/\./g, "/");
  if (!candidate) return undefined;

  const key = stripExtension(candidate);
  return index.get(key) ?? index.get(`src/${key}`) ?? [...index.entries()].find(([k]) => k.endsWith(`/${key}`))?.[1];
}

function slugify(path: string): string {
  return stripExtension(path).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function labelFor(path: string): string {
  const parts = stripExtension(path).split("/");
  const base = parts.pop() ?? path;
  // Next.js-style `page`/`route` files are named after their folder.
  // Rust `mod.rs` is the module named by its folder.
  const name = base === "mod" && parts.length > 0 ? parts.pop()! : ["page", "route", "index", "layout"].includes(base) ? `${parts.pop() ?? base}/${base}` : base;
  return name.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (c) => c.toUpperCase());
}

function languageFor(path: string): string {
  if (/\.m$/i.test(path)) return "matlab";
  return path.split(".").pop()?.toLowerCase() ?? "text";
}

/** Prefer files that are more likely to be architectural seams: routes, services, schemas over leaf UI. */
function relevance(file: SourceFile): number {
  const kind = classifyPath(file.path);
  const kindWeight = { api: 4, data: 4, logic: 3, frontend: 2 }[kind];
  const depthPenalty = file.path.split("/").length * 0.1;
  return kindWeight - depthPenalty + Math.min(file.content.length / 20_000, 1);
}

export function selectGraphFiles(files: readonly SourceFile[], maxFiles: number = MAX_GRAPH_FILES): { selected: SourceFile[]; warnings: string[] } {
  const analyzable = files.filter((f) => isAnalyzableSource(f.path));
  // `#[cfg(test)] mod x;` files are not part of the built crate.
  const testOnly = rustTestOnlyPaths(analyzable);
  const candidates = testOnly.size ? analyzable.filter((f) => !testOnly.has(f.path)) : analyzable;
  const warnings: string[] = [];
  if (candidates.length === 0) warnings.push("No supported source files found (ts, js, py, go, java, rb, cs, php, vue, svelte).");
  if (candidates.length > maxFiles) {
    warnings.push(`Showing the ${maxFiles} most architecturally relevant of ${candidates.length} source files.`);
  }
  const selected = [...candidates].sort((a, b) => relevance(b) - relevance(a)).slice(0, maxFiles);
  return { selected, warnings };
}

export function truncateCode(content: string): string {
  const lines = content.split("\n");
  if (lines.length <= MAX_NODE_CODE_LINES) return content;
  return [...lines.slice(0, MAX_NODE_CODE_LINES), `// … ${lines.length - MAX_NODE_CODE_LINES} more lines`].join("\n");
}

/**
 * Deterministic file-level dependency graph: one node per relevant source file,
 * one edge per resolvable internal import.
 */
export function buildHeuristicGraph(name: string, files: readonly SourceFile[], options: { maxFiles?: number } = {}): ArchitectureGraph {
  const { selected, warnings } = selectGraphFiles(files, options.maxFiles);
  const index = new Map(selected.map((f) => [stripExtension(f.path), f.path]));
  const idForPath = new Map(selected.map((f) => [f.path, slugify(f.path)]));

  const nodes: ArchNode[] = selected.map((file) => ({
    id: idForPath.get(file.path)!,
    type: "component",
    position: { x: 0, y: 0 },
    data: {
      label: labelFor(file.path),
      kind: classifyPath(file.path),
      filePath: file.path,
      description: `${file.content.split("\n").length} lines · detected by path heuristics`,
      language: languageFor(file.path),
      code: truncateCode(file.content),
      exports: extractExports(file),
      imports: extractImports(file),
      params: extractParams(file),
      keywords: slugify(file.path).split("-").filter((s) => s.length >= 3),
      lineCount: file.content.split("\n").length,
    },
  }));

  const edges: DependencyEdge[] = [];
  const seen = new Set<string>();
  for (const file of selected) {
    const typeOnly = typeOnlyImports(file);
    if (hasOwnImportAnalysis(file.path)) continue;
    const symbolsBySpec = importedSymbols(file.content);
    const edgeByTarget = new Map<string, DependencyEdge>();
    for (const spec of extractImports(file)) {
      const targetPath = resolveImport(file.path, spec, index);
      if (!targetPath || targetPath === file.path) continue;
      const source = idForPath.get(file.path)!;
      const target = idForPath.get(targetPath)!;
      const id = `e-${source}--${target}`;
      const symbols = symbolsBySpec?.get(spec);
      const existing = edgeByTarget.get(id);
      if (existing) {
        // Another specifier for the same file: merge what it uses; one unknown makes the whole edge unknown.
        if (!symbols || !existing.symbols) delete existing.symbols;
        else existing.symbols = [...new Set([...existing.symbols, ...symbols])].sort();
        continue;
      }
      if (seen.has(id)) continue;
      seen.add(id);
      const edge: DependencyEdge = { id, source, target, relation: "imports", ...(typeOnly.has(spec) ? { typeOnly: true } : {}), ...(symbols ? { symbols } : {}) };
      edgeByTarget.set(id, edge);
      edges.push(edge);
    }
  }

  // Go: importer → the files that define the exported names it uses.
  for (const edge of goEdges(selected, idForPath, name)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push(edge);
  }

  // Python: imports by name (`from a import B` links to the file defining B).
  for (const edge of pythonEdges(selected, idForPath)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push(edge);
  }

  // Rust: `use` paths resolved through the module tree.
  for (const edge of rustEdges(selected, idForPath, name)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push(edge);
  }

  // Java: imports by qualified name, plus same-package use.
  for (const edge of javaEdges(selected, idForPath)) {
    if (seen.has(edge.id)) continue;
    seen.add(edge.id);
    edges.push(edge);
  }

  // MATLAB/Python scripts: add function calls, data files read/written, and layer names.
  const layer = analyzeScriptFiles(selected, idForPath);
  const allNodes = [
    ...nodes.map((n) => {
      const patch = layer.patches.get(n.data.filePath);
      return patch ? { ...n, data: { ...n.data, ...patch } } : n;
    }),
    ...layer.dataNodes,
  ];
  const allEdges = [...edges, ...layer.edges.filter((e) => !seen.has(e.id))];

  return {
    id: `import-${slugify(name)}-${Date.now().toString(36)}`,
    name,
    description: `${allNodes.length} components and ${allEdges.length} dependencies mapped heuristically.`,
    nodes: layer.kindLabels ? layoutByKind(allNodes, SCRIPT_LAYER_ORDER) : layoutByKind(allNodes),
    edges: allEdges,
    commits: [],
    scenarios: [],
    kindLabels: layer.kindLabels,
    warnings: [...warnings, ...layer.warnings],
  };
}
