import { javaPackage, javaTypes } from "@/lib/engines/javaImports";
import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * Kotlin support. Like Java, a file has a `package` and imports by qualified name, but a Kotlin
 * file can also declare top-level functions and properties, and those are imported by name too
 * (`import com.acme.util.slugify`). So the unit of a link is a *declaration*: a class, object,
 * interface, typealias, or top-level function or property, and an import or a mention is matched
 * to the file that declares it.
 *
 * Lexical: no compiler. Kotlin files may use Java classes in the same repository (resolved);
 * Java files that use Kotlin classes are not followed by the Java mapper.
 */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Replace comments (nested block comments too) and string/char literals with spaces; template holes are blanked with the string. */
function blankKotlin(source: string, { strings }: { strings: boolean }): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const fill = (t: string) => t.replace(/[^\n]/g, " ");
  const emit = (t: string) => (strings ? fill(t) : t);
  while (i < n) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      out += fill(source.slice(i, stop));
      i = stop;
    } else if (c === "/" && next === "*") {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (source[j] === "/" && source[j + 1] === "*") (depth++, (j += 2));
        else if (source[j] === "*" && source[j + 1] === "/") (depth--, (j += 2));
        else j++;
      }
      out += fill(source.slice(i, j));
      i = j;
    } else if (source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end + 3;
      out += emit(source.slice(i, stop));
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"' && source[j] !== "\n") j += source[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, n);
      out += emit(source.slice(i, stop));
      i = stop;
    } else if (c === "'") {
      const m = /^'(?:\\.[^']*|[^\\'])'/.exec(source.slice(i, i + 12));
      if (m) {
        out += emit(m[0]);
        i += m[0].length;
      } else {
        out += c;
        i++;
      }
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

export const ktPackage = (content: string): string => new RegExp(String.raw`^\s*package\s+([\w.]+)`, "m").exec(blankKotlin(content, { strings: true }))?.[1] ?? "";

export type KtImport = { name: string; alias?: string; wildcard: boolean };

export function ktImports(content: string): KtImport[] {
  const code = blankKotlin(content, { strings: true });
  return [...code.matchAll(new RegExp(String.raw`^[ \t]*import\s+([\w.]+?)(\.\*)?(?:\s+as\s+(${IDENT}))?[ \t]*$`, "gm"))].map((m) => ({ name: m[1]!, wildcard: !!m[2], ...(m[3] ? { alias: m[3] } : {}) }));
}

export type KtDeclaration = { name: string; kind: "type" | "function" | "property"; isPublic: boolean };

const MODIFIERS = String.raw`(?:(?:public|internal|private|protected|open|abstract|sealed|final|data|enum|annotation|inline|value|inner|expect|actual|external|tailrec|suspend|operator|infix|const|override|lateinit|fun|vararg|noinline|crossinline|reified)\s+)*`;

/** Top-level classes, objects, interfaces, typealiases, functions and properties (nothing inside a type or a function body). */
export function ktDeclarations(content: string): KtDeclaration[] {
  const code = blankKotlin(content, { strings: true });
  const depth = new Int32Array(code.length + 1);
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    depth[i] = d;
    if (code[i] === "{") d++;
    else if (code[i] === "}") d = Math.max(0, d - 1);
  }
  const out: KtDeclaration[] = [];
  const add = (m: RegExpMatchArray, name: string, kind: KtDeclaration["kind"], modifiers: string) => {
    const at = m.index! + m[0].lastIndexOf(name);
    if (depth[at] !== 0) return;
    if (!out.some((x) => x.name === name && x.kind === kind)) out.push({ name, kind, isPublic: !/\bprivate\b/.test(modifiers) });
  };

  // Annotations and modifiers before a declaration are allowed in any order; the keyword decides the kind.
  for (const m of code.matchAll(new RegExp(String.raw`(?:^|[\s;}])((?:@${IDENT}(?:\([^)]*\))?\s+)*${MODIFIERS})(?:class|interface|object|typealias)\s+(${IDENT})`, "g"))) add(m, m[2]!, "type", m[1]!);
  // `fun interface X` is a type, not a function called "interface"; `fun String.slug()` is an extension function named slug.
  for (const m of code.matchAll(new RegExp(String.raw`(?:^|[\s;}])((?:@${IDENT}(?:\([^)]*\))?\s+)*${MODIFIERS})fun\s+(?!interface\b)(?:<[^>]*>\s*)?(?:[\w.<>?,\s*]+?\.)?(${IDENT})\s*\(`, "g"))) add(m, m[2]!, "function", m[1]!);
  for (const m of code.matchAll(new RegExp(String.raw`(?:^|[\s;}])((?:@${IDENT}(?:\([^)]*\))?\s+)*${MODIFIERS})(?:val|var)\s+(?:<[^>]*>\s*)?(?:[\w.<>?,*]+\.)?(${IDENT})\s*(?:[:=]|$|\n)`, "g"))) add(m, m[2]!, "property", m[1]!);
  return out;
}

/** What other files can import: every non-private top-level declaration. */
export const ktExports = (content: string): string[] => [...new Set(ktDeclarations(content).filter((x) => x.isPublic).map((x) => x.name))];

/**
 * Edges for the Kotlin files in `files` (and Kotlin → Java where both are in the set).
 * - `import a.b.C` / `import a.b.slugify` → the file declaring `C` / `slugify` in package `a.b` (symbol = the name)
 * - `import a.b.*` → files of package `a.b` whose declarations the importer mentions
 * - same package, no import → `samePackage` edges to files whose declarations the importer mentions
 */
export function kotlinEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>): DependencyEdge[] {
  const kt = files.filter((f) => f.path.endsWith(".kt") && idForPath.has(f.path));
  if (kt.length === 0) return [];

  type Info = { file: SourceFile; pkg: string; decls: KtDeclaration[]; body: string };
  const mk = (file: SourceFile, pkg: string, decls: KtDeclaration[]): Info => ({ file, pkg, decls, body: "" });
  const infos: Info[] = kt.map((file) => {
    const code = blankKotlin(file.content, { strings: true });
    const body = code.replace(new RegExp(String.raw`^[ \t]*(?:package|import)\s[^\n]*`, "gm"), (m) => m.replace(/[^\n]/g, " "));
    return { ...mk(file, ktPackage(file.content), ktDeclarations(file.content)), body };
  });
  // Java classes in the same repository are importable from Kotlin.
  const javaInfos: Info[] = files
    .filter((f) => f.path.endsWith(".java") && idForPath.has(f.path))
    .map((file) => mk(file, javaPackage(file.content), javaTypes(file.content).map((t) => ({ name: t.name, kind: "type" as const, isPublic: t.isPublic }))));
  const all = [...infos, ...javaInfos];

  const byQualified = new Map<string, Array<{ info: Info; decl: KtDeclaration }>>();
  const byPackage = new Map<string, Info[]>();
  for (const info of all) {
    (byPackage.get(info.pkg) ?? byPackage.set(info.pkg, []).get(info.pkg)!).push(info);
    for (const decl of info.decls) {
      const key = info.pkg ? `${info.pkg}.${decl.name}` : decl.name;
      (byQualified.get(key) ?? byQualified.set(key, []).get(key)!).push({ info, decl });
    }
  }

  /** Multiplatform projects declare one name in several source sets (`expect` in common, `actual` per platform): the common one is the dependency. */
  const COMMON_SOURCE_SET = /(^|\/)(commonMain|common)\//;
  const preferCommon = <T extends { info: Info }>(hits: T[]): T[] => {
    if (hits.length < 2) return hits;
    const common = hits.filter((h) => COMMON_SOURCE_SET.test(h.info.file.path));
    return common.length ? common : hits;
  };

  const merged = new Map<string, DependencyEdge>();
  const add = (from: Info, to: Info, symbols: string[], samePackage: boolean) => {
    if (from === to) return;
    const source = idForPath.get(from.file.path)!;
    const target = idForPath.get(to.file.path)!;
    const id = `e-${source}--${target}`;
    const clean = [...new Set(symbols)].sort();
    const existing = merged.get(id);
    if (!existing) return void merged.set(id, { id, source, target, relation: "imports", ...(samePackage ? { samePackage: true } : {}), symbols: clean });
    existing.symbols = [...new Set([...(existing.symbols ?? []), ...clean])].sort();
    if (!samePackage) delete existing.samePackage; // an explicit import is a real dependency
  };

  /** Is the declaration mentioned in `body`? Functions are called (`name(`, also as an extension `.name(`); the rest are named. */
  const mentioned = (body: string, decl: KtDeclaration) =>
    decl.kind === "function"
      ? new RegExp(String.raw`(?<![\w$])${decl.name}\s*[(<]`).test(body)
      : new RegExp(String.raw`(?<![\w$.])${decl.name}(?![\w$])`).test(body);

  for (const from of infos) {
    for (const imp of ktImports(from.file.content)) {
      if (imp.wildcard) {
        const wildcardHits: Array<{ info: Info; name: string }> = [];
        for (const to of byPackage.get(imp.name) ?? []) for (const d of to.decls) if (d.isPublic && mentioned(from.body, d)) wildcardHits.push({ info: to, name: d.name });
        const byName = new Map<string, typeof wildcardHits>();
        for (const h of wildcardHits) (byName.get(h.name) ?? byName.set(h.name, []).get(h.name)!).push(h);
        const grouped = new Map<Info, string[]>();
        for (const hits of byName.values()) for (const h of preferCommon(hits)) (grouped.get(h.info) ?? grouped.set(h.info, []).get(h.info)!).push(h.name);
        for (const [to, names] of grouped) add(from, to, names, false);
        continue;
      }
      // `a.b.Outer.Inner` or `a.b.slugify`: the longest prefix that is a declaration.
      const parts = imp.name.split(".");
      for (let end = parts.length; end >= 1; end--) {
        const hits = byQualified.get(parts.slice(0, end).join("."));
        if (!hits) continue;
        for (const { info, decl } of preferCommon(hits)) add(from, info, [decl.name], false);
        break;
      }
    }

    const samePackageHits: Array<{ info: Info; name: string }> = [];
    for (const to of byPackage.get(from.pkg) ?? []) {
      if (to === from) continue;
      for (const d of to.decls) if (mentioned(from.body, d)) samePackageHits.push({ info: to, name: d.name });
    }
    const byName = new Map<string, typeof samePackageHits>();
    for (const h of samePackageHits) (byName.get(h.name) ?? byName.set(h.name, []).get(h.name)!).push(h);
    const grouped = new Map<Info, string[]>();
    for (const hits of byName.values()) for (const h of preferCommon(hits)) (grouped.get(h.info) ?? grouped.set(h.info, []).get(h.info)!).push(h.name);
    for (const [to, names] of grouped) add(from, to, names, true);
  }
  return [...merged.values()];
}
