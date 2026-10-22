import { nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ArchNode } from "@/lib/types";

/**
 * Symbol-level coupling for TypeScript/JavaScript: not just "A imports B" but "A uses
 * `verifyToken` and `Session` from B". It is a lexical analysis (no type checker), so it
 * can miss a symbol used only through an alias of an alias, but it never invents one:
 * when it cannot tell what an import uses, it says so (`null`) and callers treat that as
 * "everything".
 *
 * (TypeScript 7 ships as a native binary with no in-process compiler API, which is why this
 * is a purpose-built scanner. It runs the same in the browser, the server and the CLI.)
 */

/** Marks "uses the whole module" (namespace import used as a value, `export *`). */
export const ALL_SYMBOLS = "*";

/* ---------- Lexing ---------- */

/** Replace comments (and, optionally, quoted strings) with spaces, keeping offsets and newlines. */
function blank(source: string, { strings }: { strings: boolean }): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const fill = (text: string) => text.replace(/[^\n]/g, " ");
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      out += fill(source.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += fill(source.slice(i, stop));
      i = stop;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && source[j] !== c && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, n);
      out += strings ? fill(source.slice(i, stop)) : source.slice(i, stop);
      i = stop;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/* ---------- Import bindings ---------- */

type Binding = { imported: string; local: string };

type ParsedImport = {
  spec: string;
  /** The text of the whole statement, so it can be removed before counting uses. */
  range: [number, number];
  bindings: Binding[];
  /** `import * as ns`. */
  namespace?: string;
  /** `export … from`: a re-export counts as use of each named symbol. */
  reexport: boolean;
  /** `export * from`. */
  star: boolean;
};

const IMPORT_FROM = /\bimport\s+(?:type\s+)?([^'"();]*?)\s*from\s*(['"])([^'"\n]+)\2/g;
const EXPORT_FROM = /\bexport\s+(?:type\s+)?(\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|\{[^}]*\})\s*from\s*(['"])([^'"\n]+)\2/g;
const IDENT = /^[A-Za-z_$][\w$]*$/;

function parseNamed(list: string): Binding[] {
  return list
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter(Boolean)
    .flatMap((part) => {
      const [imported, local = imported] = part.split(/\s+as\s+/).map((s) => s.trim());
      return imported && local && IDENT.test(imported.replace(/^default$/, "_d")) && IDENT.test(local) ? [{ imported: imported === "default" ? "default" : imported, local }] : [];
    });
}

function parseImports(code: string): ParsedImport[] {
  const out: ParsedImport[] = [];

  for (const m of code.matchAll(IMPORT_FROM)) {
    const clause = m[1]!.trim();
    const parsed: ParsedImport = { spec: m[3]!, range: [m.index!, m.index! + m[0].length], bindings: [], reexport: false, star: false };
    const star = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (star) parsed.namespace = star[1];
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) parsed.bindings.push(...parseNamed(braces[1]!));
    const def = clause.replace(/\{[^}]*\}/, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, "").trim();
    if (def && IDENT.test(def)) parsed.bindings.push({ imported: "default", local: def });
    out.push(parsed);
  }

  for (const m of code.matchAll(EXPORT_FROM)) {
    const what = m[1]!;
    out.push({
      spec: m[3]!,
      range: [m.index!, m.index! + m[0].length],
      bindings: what.startsWith("{") ? parseNamed(what.slice(1, -1)).map((b) => ({ imported: b.imported, local: "" })) : [],
      reexport: true,
      star: what.startsWith("*"),
    });
  }
  return out;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How many times `name` appears as a whole identifier that is not a property access (`x.name`). */
function countUses(code: string, name: string): number {
  return [...code.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}(?![\\w$])`, "g"))].length;
}

/**
 * The symbols each module specifier contributes to this file, or `null` when unknowable
 * (a dynamic `import()`/`require()` of that specifier, or a bare side-effect import).
 */
export function importedSymbols(source: string): Map<string, string[] | null> {
  const noComments = blank(source, { strings: false });
  const imports = parseImports(noComments);

  // Code to count uses in: no comments, no string contents, and the import statements themselves removed.
  const body = blank(source, { strings: true }).split("");
  for (const { range } of imports) for (let i = range[0]; i < range[1]; i++) if (body[i] !== "\n") body[i] = " ";
  const code = body.join("");

  const result = new Map<string, string[] | null>();
  const add = (spec: string, symbols: string[] | null) => {
    const previous = result.get(spec);
    if (symbols === null || previous === null) return void result.set(spec, null);
    result.set(spec, [...new Set([...(previous ?? []), ...symbols])].sort());
  };

  for (const imp of imports) {
    const symbols: string[] = [];
    for (const b of imp.bindings) if (imp.reexport || countUses(code, b.local) > 0) symbols.push(b.imported);
    if (imp.star) symbols.push(ALL_SYMBOLS);
    if (imp.namespace) {
      const members = new Set([...code.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(imp.namespace)}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, "g"))].map((m) => m[1]!));
      const total = countUses(code, imp.namespace);
      const viaMember = [...code.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(imp.namespace)}\\s*\\.`, "g"))].length;
      if (total > viaMember) symbols.push(ALL_SYMBOLS); // the namespace object itself is passed around
      symbols.push(...members);
    }
    add(imp.spec, symbols);
  }

  // Specifiers reached some other way (dynamic import, require, side-effect import) cannot be narrowed.
  const known = new Set(imports.map((i) => i.spec));
  for (const m of noComments.matchAll(/(?:\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g)) {
    const spec = m[2]!;
    if (!known.has(spec) || /\b(?:import|require)\s*\(/.test(m[0])) add(spec, null);
  }
  return result;
}

/* ---------- Graph queries ---------- */

/** Names of what a file exports, without the `default ` prefix `extractExports` adds. */
export const exportedNames = (node: ArchNode): string[] => node.data.exports.map((e) => e.replace(/^default\s+/, "")).filter(Boolean);

/** Does an edge's symbol list include `symbol`? An edge with no symbol data counts as "yes" (unknown). */
export function edgeUses(symbols: readonly string[] | undefined, symbol: string): boolean {
  if (!symbols) return true;
  return symbols.includes(ALL_SYMBOLS) || symbols.includes(symbol) || (symbol === "default" && symbols.includes("default"));
}

export type ExportUsage = {
  name: string;
  /** Components that use this export (or might, where symbol data is missing). */
  users: string[];
  /** True when every user is only *possibly* a user because its edge has no symbol data. */
  uncertain: boolean;
};

/** For each export of a component: who uses it. An export with no users is a candidate for deletion. */
export function exportUsage(graph: ArchitectureGraph, nodeId: string): ExportUsage[] {
  const node = nodeById(graph.nodes, nodeId);
  if (!node) return [];
  const incoming = graph.edges.filter((e) => !e.isDraft && e.target === nodeId && e.relation === "imports");
  return node.data.exports.map((raw) => {
    const isDefault = raw.startsWith("default ");
    const name = raw.replace(/^default\s+/, "");
    const matching = incoming.filter((e) => edgeUses(e.symbols, isDefault ? "default" : name) || (isDefault && edgeUses(e.symbols, name)));
    return { name: raw, users: matching.map((e) => e.source), uncertain: matching.length > 0 && matching.every((e) => !e.symbols) };
  });
}

/** Exports that no other mapped component uses, per component. Only meaningful where symbol data exists. */
export function unusedExports(graph: ArchitectureGraph): Array<{ nodeId: string; names: string[] }> {
  const out: Array<{ nodeId: string; names: string[] }> = [];
  for (const node of graph.nodes) {
    if (node.data.isDraft || node.data.kind === "data" || !/^(tsx?|jsx?|mjs|cjs)$/.test(node.data.language)) continue;
    const incoming = graph.edges.filter((e) => !e.isDraft && e.target === node.id && e.relation === "imports");
    if (incoming.length === 0 || incoming.some((e) => !e.symbols)) continue; // entry points and unknowns are not "unused"
    const names = exportUsage(graph, node.id).filter((u) => u.users.length === 0).map((u) => u.name);
    if (names.length) out.push({ nodeId: node.id, names });
  }
  return out;
}
