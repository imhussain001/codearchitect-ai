import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * Java support. A file defines one or more top-level types; an import names a type by its
 * fully qualified name (`com.acme.auth.JwtService`), so the edge goes to the file that declares
 * that type. Files in the same package use each other's types with no import at all, so those
 * are linked by name and marked `samePackage` (health ignores them, like Go).
 *
 * Lexical: no type checker, no classpath. Types reached only through wildcard imports are linked
 * when the importer mentions the type's name; members used through an instance are not tracked.
 */

const IDENT = "[A-Za-z_$][A-Za-z0-9_$]*";

/** Replace comments, string/char literals and text blocks with spaces (offsets and newlines kept). */
function blankJava(source: string, { strings }: { strings: boolean }): string {
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
    } else if (c === '"' && source.startsWith('"""', i)) {
      const end = source.indexOf('"""', i + 3);
      const stop = end < 0 ? n : end + 3;
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

export const javaPackage = (content: string): string => new RegExp(String.raw`^\s*package\s+([\w.]+)\s*;`, "m").exec(blankJava(content, { strings: false }))?.[1] ?? "";

export type JavaImport = { name: string; isStatic: boolean; wildcard: boolean };

export function javaImports(content: string): JavaImport[] {
  const code = blankJava(content, { strings: false });
  return [...code.matchAll(new RegExp(String.raw`^\s*import\s+(static\s+)?([\w.]+?)(\.\*)?\s*;`, "gm"))].map((m) => ({ name: m[2]!, isStatic: !!m[1], wildcard: !!m[3] }));
}

export type JavaType = { name: string; isPublic: boolean };

/** Top-level class, interface, enum, record and annotation types (not nested ones). */
export function javaTypes(content: string): JavaType[] {
  const code = blankJava(content, { strings: true });
  // Brace depth at every offset, so only declarations outside any `{ }` count.
  const depth = new Int32Array(code.length + 1);
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    depth[i] = d;
    if (code[i] === "{") d++;
    else if (code[i] === "}") d = Math.max(0, d - 1);
  }
  const decl = new RegExp(String.raw`(?:^|[\s;}])((?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*)(?:@interface|class|interface|enum|record)\s+(${IDENT})`, "g");
  const out: JavaType[] = [];
  for (const m of code.matchAll(decl)) {
    const at = m.index! + m[0].indexOf(m[2]!);
    if (depth[at] !== 0) continue;
    out.push({ name: m[2]!, isPublic: /\bpublic\b/.test(m[1]!) });
  }
  return out;
}

/** What other packages can see: public top-level types. */
export const javaExports = (content: string): string[] => javaTypes(content).filter((t) => t.isPublic).map((t) => t.name);

const countsAs = (code: string, name: string) => new RegExp(String.raw`(?<![\w$.])${name.replace(/\$/g, String.raw`\$`)}(?![\w$])`).test(code);

/**
 * Edges for the Java files in `files`:
 * - `import a.b.C;` → the file declaring `a.b.C` (symbol `C`); `import static a.b.C.m;` → that file (symbol `m`)
 * - `import a.b.*;` → files of package `a.b` whose type names the importer mentions
 * - same package, no import → `samePackage` edges to files whose types the importer mentions
 */
export function javaEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>): DependencyEdge[] {
  const java = files.filter((f) => f.path.endsWith(".java") && idForPath.has(f.path));
  if (java.length === 0) return [];

  type Info = { file: SourceFile; pkg: string; types: JavaType[]; imports: JavaImport[] };
  const infos: Info[] = java.map((file) => ({ file, pkg: javaPackage(file.content), types: javaTypes(file.content), imports: javaImports(file.content) }));

  const byFqn = new Map<string, Info>();
  const byPackage = new Map<string, Info[]>();
  for (const info of infos) {
    for (const t of info.types) byFqn.set(info.pkg ? `${info.pkg}.${t.name}` : t.name, info);
    (byPackage.get(info.pkg) ?? byPackage.set(info.pkg, []).get(info.pkg)!).push(info);
  }

  const merged = new Map<string, DependencyEdge>();
  const add = (from: Info, to: Info, symbols: string[], samePackage: boolean) => {
    if (from === to) return;
    const source = idForPath.get(from.file.path)!;
    const target = idForPath.get(to.file.path)!;
    const id = `e-${source}--${target}`;
    const existing = merged.get(id);
    if (!existing) return void merged.set(id, { id, source, target, relation: "imports", ...(samePackage ? { samePackage: true } : {}), symbols: [...new Set(symbols)].sort() });
    existing.symbols = [...new Set([...(existing.symbols ?? []), ...symbols])].sort();
    if (!samePackage) delete existing.samePackage; // an explicit import is a real dependency
  };

  /** Longest prefix of `name` that is a known type: `a.b.Outer.Inner` → `a.b.Outer`. */
  const resolve = (name: string): { info: Info; rest: string[] } | undefined => {
    const parts = name.split(".");
    for (let end = parts.length; end > 0; end--) {
      const info = byFqn.get(parts.slice(0, end).join("."));
      if (info) return { info, rest: parts.slice(end) };
    }
    return undefined;
  };

  for (const from of infos) {
    // Mentions of other types, with the import and package lines removed so they do not count themselves.
    const body = blankJava(from.file.content, { strings: true }).replace(new RegExp(String.raw`^\s*(?:import|package)\s[^;]*;`, "gm"), (m) => m.replace(/[^\n]/g, " "));

    for (const imp of from.imports) {
      if (imp.wildcard) {
        const pkgFiles = imp.isStatic ? [] : byPackage.get(imp.name) ?? [];
        for (const to of pkgFiles) {
          const used = to.types.filter((t) => t.isPublic && countsAs(body, t.name)).map((t) => t.name);
          if (used.length) add(from, to, used, false);
        }
        if (imp.isStatic) {
          const hit = resolve(imp.name);
          if (hit) add(from, hit.info, hit.rest.length ? hit.rest : [imp.name.split(".").pop()!], false);
        }
        continue;
      }
      const hit = resolve(imp.name);
      if (!hit) continue;
      const symbol = imp.isStatic ? (hit.rest.at(-1) ?? hit.info.types[0]?.name ?? imp.name) : (imp.name.split(".").pop() ?? imp.name);
      add(from, hit.info, [symbol], false);
    }

    for (const to of byPackage.get(from.pkg) ?? []) {
      if (to === from) continue;
      const used = to.types.filter((t) => countsAs(body, t.name)).map((t) => t.name);
      if (used.length) add(from, to, used, true);
    }
  }
  return [...merged.values()];
}
