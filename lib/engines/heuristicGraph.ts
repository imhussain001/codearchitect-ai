import { layoutByKind, SCRIPT_LAYER_ORDER } from "@/lib/graph";
import { analyzeScriptFiles, matlabFunctions } from "@/lib/engines/scripts";
import { goEdges, goExports, goImports } from "@/lib/engines/goImports";
import { importedSymbols } from "@/lib/engines/symbols";
import type { ArchitectureGraph, ArchNode, CodeParam, DependencyEdge, NodeKind, SourceFile } from "@/lib/types";

const SOURCE_EXTENSIONS = /\.(tsx?|jsx?|mjs|cjs|py|go|java|kt|rb|cs|php|vue|svelte|m)$/i;
const IGNORED_PATHS =
  /(^|\/)(node_modules|dist|build|out|\.next|\.git|vendor|venv|\.venv|__pycache__|coverage|target)(\/|$)|\.d\.ts$|(\.|_)(test|spec|stories)\.|(^|\/)(__tests__|tests?)\//i;
const CONFIG_FILES = /(^|\/)[^/]*(config|rc)\.(c|m)?(js|ts)$/i;

export const MAX_GRAPH_FILES = 60;
const MAX_NODE_CODE_LINES = 120;

const KIND_RULES: Array<{ kind: NodeKind; pattern: RegExp }> = [
  { kind: "data", pattern: /(^|\/)(db|database|models?|schemas?|prisma|repositor(y|ies)|migrations?|cache|redis|entities|dal|store)(\/|\.|_|$)/i },
  { kind: "api", pattern: /(^|\/)(api|routes?|routers?|endpoints?|handlers?|urls\.py|views\.py)(\/|\.|$)|route\.(t|j)s$/i },
  { kind: "frontend", pattern: /\.(tsx|jsx|vue|svelte)$|(^|\/)(components|pages|screens|ui|views|app\/.*page)(\/|\.|$)/i },
];

export function classifyPath(path: string): NodeKind {
  return KIND_RULES.find((rule) => rule.pattern.test(path))?.kind ?? "logic";
}

export function isAnalyzableSource(path: string): boolean {
  return SOURCE_EXTENSIONS.test(path) && !IGNORED_PATHS.test(path) && !CONFIG_FILES.test(path);
}

const JS_IMPORT = /(?:import\s[^'"]*?from\s*|import\s*\(\s*|require\s*\(\s*|export\s[^'"]*?from\s*)['"]([^'"]+)['"]/g;
const PY_IMPORT = /^\s*(?:from\s+([.\w]+)\s+import|import\s+([.\w]+))/gm;
const JS_EXPORT = /export\s+(default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const PY_EXPORT = /^(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/gm;
const FIRST_SIGNATURE = /(?:function\s+\w+|func\s+\w+|def\s+\w+|\w+\s*=\s*(?:async\s*)?)\s*\(([^)]*)\)/;

/**
 * Specifiers imported only through `import type` / `export type` (and never by value) in a file.
 * Type-only imports are erased at runtime, so they are not architectural coupling.
 */
export function typeOnlyImports(file: SourceFile): Set<string> {
  if (/\.(py|m|go)$/.test(file.path)) return new Set();
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
  const specs = new Set<string>();
  const pattern = file.path.endsWith(".py") ? PY_IMPORT : JS_IMPORT;
  for (const match of file.content.matchAll(pattern)) {
    const spec = match[1] ?? match[2];
    if (spec) specs.add(spec);
  }
  return [...specs];
}

export function extractExports(file: SourceFile): string[] {
  if (file.path.endsWith(".m")) return matlabFunctions(file.content);
  if (file.path.endsWith(".go")) return goExports(file.content);
  if (file.path.endsWith(".py")) {
    return [...file.content.matchAll(PY_EXPORT)].map((m) => m[1]!).filter((n) => !n.startsWith("_"));
  }
  return [...new Set([...file.content.matchAll(JS_EXPORT)].map((m) => (m[1] ? `default ${m[2]}` : m[2]!)))];
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
const hasOwnImportAnalysis = (path: string) => /\.(py|m|go)$/i.test(path);

function stripExtension(path: string): string {
  return path.replace(/\.(tsx?|jsx?|mjs|cjs|py|go|vue|svelte|m)$/i, "").replace(/\/index$/, "");
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
  const name = ["page", "route", "index", "layout"].includes(base) ? `${parts.pop() ?? base}/${base}` : base;
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
  const candidates = files.filter((f) => isAnalyzableSource(f.path));
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
    const symbolsBySpec = hasOwnImportAnalysis(file.path) ? null : importedSymbols(file.content);
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
