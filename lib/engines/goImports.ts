import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * Go support. Go imports whole *packages* (directories), but the map shows files, so an import
 * becomes edges to the specific files that define the exported names the importer actually uses
 * (`auth.VerifyToken` links to the file that declares `VerifyToken`). That keeps the map
 * file-level like the other languages and makes the edges symbol-precise.
 *
 * Lexical, like `symbols.ts`: no type checker, no `go list`. The module path is inferred from the
 * imports themselves (see `detectModule`) because `go.mod` is not part of the analysed files.
 */

const EXPORTED = "[A-Z][A-Za-z0-9_]*";
const MAX_FILES_PER_UNRESOLVED_IMPORT = 5;

/** Replace comments, string and rune literals with spaces (offsets and newlines kept). */
function blankGo(source: string, { strings }: { strings: boolean }): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const fill = (t: string) => t.replace(/[^\n]/g, " ");
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
    } else if (c === "`") {
      const end = source.indexOf("`", i + 1);
      const stop = end < 0 ? n : end + 1;
      out += strings ? fill(source.slice(i, stop)) : source.slice(i, stop);
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

export const goPackageName = (content: string): string | undefined => /^\s*package\s+([A-Za-z_]\w*)/m.exec(blankGo(content, { strings: false }))?.[1];

export type GoImport = { path: string; alias?: string };

/** Imports of a Go file: `import "x"`, `import a "x"`, and grouped `import ( … )`. */
export function goImports(content: string): GoImport[] {
  const code = blankGo(content, { strings: false });
  const out: GoImport[] = [];
  const spec = /(?:^|\s)(?:([A-Za-z_.][\w]*)\s+)?"([^"\n]+)"/g;
  const take = (text: string) => {
    for (const m of text.matchAll(spec)) out.push({ path: m[2]!, ...(m[1] ? { alias: m[1] } : {}) });
  };
  for (const m of code.matchAll(/^\s*import\s*\(([^)]*)\)/gm)) take(m[1]!);
  for (const m of code.matchAll(/^\s*import\s+(?:[A-Za-z_.]\w*\s+)?"[^"\n]+"/gm)) take(m[0].replace(/^\s*import\s+/, ""));
  return out;
}

/** Exported (capitalised) top-level functions, types, vars and consts. Methods and struct fields are not top-level names. */
export function goExports(content: string): string[] {
  const code = blankGo(content, { strings: true });
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(`^func\\s+(${EXPORTED})\\s*[(\\[]`, "gm"))) names.add(m[1]!);
  for (const m of code.matchAll(new RegExp(`^type\\s+(${EXPORTED})\\b`, "gm"))) names.add(m[1]!);
  for (const m of code.matchAll(new RegExp(`^(?:var|const)\\s+(${EXPORTED})\\b`, "gm"))) names.add(m[1]!);
  // Grouped declarations: var ( … ) / const ( … ) / type ( … ), names at the start of each entry line.
  for (const block of code.matchAll(/^(?:var|const|type)\s*\(([^)]*)\)/gm)) {
    for (const line of block[1]!.split("\n")) {
      const m = new RegExp(`^\\s+(${EXPORTED})\\b`).exec(line);
      if (m) names.add(m[1]!);
    }
  }
  return [...names];
}

const NAME = "[A-Za-z_][A-Za-z0-9_]*";
const MIN_INTRA_NAME_LENGTH = 3;
const NOT_LINKABLE = new Set(["init", "main"]);

/** Every top-level name a file declares, exported or not (same-package files can use unexported ones). Methods are not top-level names. */
export function goDeclared(content: string): string[] {
  const code = blankGo(content, { strings: true });
  const names = new Set<string>();
  for (const m of code.matchAll(new RegExp(String.raw`^func\s+(${NAME})\s*[(\[]`, "gm"))) names.add(m[1]!);
  for (const m of code.matchAll(new RegExp(String.raw`^(?:type|var|const)\s+(${NAME})\b`, "gm"))) names.add(m[1]!);
  for (const block of code.matchAll(/^(?:var|const|type)\s*\(([^)]*)\)/gm)) {
    for (const line of block[1]!.split("\n")) {
      const m = new RegExp(String.raw`^\s+(${NAME})\b`).exec(line);
      if (m) names.add(m[1]!);
    }
  }
  return [...names].filter((n) => n !== "_" && !NOT_LINKABLE.has(n) && n.length >= MIN_INTRA_NAME_LENGTH);
}

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");

/**
 * The module path, inferred from votes: if import `P` ends with the directory `D` of a package we
 * have, then `P` minus `D` is a candidate module prefix. The prefix with the most votes wins;
 * a tie (or no candidates) means unknown, and nothing is linked on a guess.
 */
export function detectModule(imports: readonly string[], dirs: readonly string[], repoName?: string): string | undefined {
  const votes = new Map<string, number>();
  for (const path of imports) {
    for (const dir of dirs) {
      if (dir === "") continue;
      if (path.endsWith(`/${dir}`)) {
        const prefix = path.slice(0, path.length - dir.length - 1);
        votes.set(prefix, (votes.get(prefix) ?? 0) + 1);
      }
    }
  }
  // A path that is exactly a prefix of others (the root package, imported as "<module>") also votes for itself.
  for (const path of imports) for (const prefix of votes.keys()) if (path === prefix) votes.set(prefix, (votes.get(prefix) ?? 0) + 1);

  const ranked = [...votes].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length);
  const best = ranked[0];
  if (!best) return undefined;
  const tied = ranked.filter(([, v]) => v === best[1]);
  if (tied.length > 1) {
    const named = repoName ? tied.find(([p]) => p.endsWith(`/${repoName}`) || p === repoName) : undefined;
    return named?.[0];
  }
  return best[0];
}

/**
 * Same-package coupling: file A uses a top-level name that file B declares. Over-approximates
 * (a local variable named like a package-level function counts), and a name declared in several
 * files (build-tagged variants) links to all of them.
 */
function addSamePackageEdges(
  go: readonly SourceFile[],
  byDir: ReadonlyMap<string, Array<{ path: string; exports: string[] }>>,
  idForPath: ReadonlyMap<string, string>,
  add: (source: string, target: string, symbols: string[] | undefined, samePackage?: boolean) => void,
): void {
  const contentOf = new Map(go.map((f) => [f.path, f.content]));
  for (const members of byDir.values()) {
    if (members.length < 2) continue;
    const definers = new Map<string, string[]>();
    for (const m of members) for (const name of goDeclared(contentOf.get(m.path)!)) (definers.get(name) ?? definers.set(name, []).get(name)!).push(m.path);

    for (const m of members) {
      const code = blankGo(contentOf.get(m.path)!, { strings: true });
      const used = new Set([...code.matchAll(new RegExp(String.raw`(?<![\w$.])(${NAME})`, "g"))].map((x) => x[1]!));
      const byTarget = new Map<string, string[]>();
      for (const name of used) {
        for (const path of definers.get(name) ?? []) if (path !== m.path) (byTarget.get(path) ?? byTarget.set(path, []).get(path)!).push(name);
      }
      for (const [path, names] of byTarget) add(idForPath.get(m.path)!, idForPath.get(path)!, names.sort(), true);
    }
  }
}

/**
 * Edges for the Go files in `files`: each importer → the files of the imported package that
 * define the names it uses. `symbols` lists those names.
 */
export function goEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>, repoName?: string): DependencyEdge[] {
  const go = files.filter((f) => f.path.endsWith(".go") && idForPath.has(f.path));
  if (go.length === 0) return [];

  const byDir = new Map<string, Array<{ path: string; exports: string[] }>>();
  const pkgName = new Map<string, string>();
  for (const f of go) {
    const dir = dirOf(f.path);
    (byDir.get(dir) ?? byDir.set(dir, []).get(dir)!).push({ path: f.path, exports: goExports(f.content) });
    const name = goPackageName(f.content);
    if (name && !pkgName.has(dir)) pkgName.set(dir, name);
  }

  const parsed = go.map((f) => ({ file: f, imports: goImports(f.content) }));
  const module = detectModule(parsed.flatMap((p) => p.imports.map((i) => i.path)), [...byDir.keys()], repoName);

  const merged = new Map<string, DependencyEdge>();
  const add = (source: string, target: string, symbols: string[] | undefined, samePackage = false) => {
    if (source === target) return;
    const id = `e-${source}--${target}`;
    const existing = merged.get(id);
    if (!existing) return void merged.set(id, { id, source, target, relation: "imports", ...(samePackage ? { samePackage: true } : {}), ...(symbols ? { symbols } : {}) });
    if (!symbols || !existing.symbols) delete existing.symbols;
    else existing.symbols = [...new Set([...existing.symbols, ...symbols])].sort();
  };

  // Files in one package use each other's names without importing anything.
  addSamePackageEdges(go, byDir, idForPath, add);

  if (!module) return [...merged.values()];

  for (const { file, imports } of parsed) {
    const code = blankGo(file.content, { strings: true });
    const source = idForPath.get(file.path)!;
    for (const imp of imports) {
      if (imp.path !== module && !imp.path.startsWith(`${module}/`)) continue;
      const dir = imp.path === module ? "" : imp.path.slice(module.length + 1);
      const members = byDir.get(dir);
      if (!members) continue;

      const local = imp.alias ?? pkgName.get(dir) ?? dir.split("/").pop() ?? "";
      const used = imp.alias === "_" || imp.alias === "." || !local ? null : [...new Set([...code.matchAll(new RegExp(`(?<![\\w$.])${local.replace(/[$]/g, "\\$")}\\s*\\.\\s*(${EXPORTED})`, "g"))].map((m) => m[1]!))];

      const resolved = new Map<string, string[]>();
      for (const name of used ?? []) {
        for (const m of members) if (m.exports.includes(name)) (resolved.get(m.path) ?? resolved.set(m.path, []).get(m.path)!).push(name);
      }
      if (resolved.size > 0) {
        for (const [path, names] of resolved) add(source, idForPath.get(path)!, names.sort());
      } else {
        // Side-effect or dot import, or only names we could not place: depend on the package, not a guess about which file.
        for (const m of members.slice(0, MAX_FILES_PER_UNRESOLVED_IMPORT)) add(source, idForPath.get(m.path)!, undefined);
      }
    }
  }
  return [...merged.values()];
}
