import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * C# support. A file declares types inside a namespace, and other files reach them through
 * `using Namespace;` (a whole namespace, not one type), through the namespace they are in or
 * enclosed by, through `global using`, or by writing the full name. So the link is made by name:
 * a file uses type `T` when it mentions `T` and `T`'s namespace is visible to it.
 *
 * Lexical: no compiler, no project files, no assemblies. A name declared in several visible
 * namespaces links to the nearest one, or to all of them when they are equally near; a type
 * reached only through `var`, reflection or dependency injection by interface name is linked
 * only if its name appears. Types outside the file set (the framework, NuGet packages) never match.
 */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Replace comments and string/char literals (regular, verbatim, interpolated, raw) with spaces; offsets and newlines kept. */
function blankCs(source: string, { strings }: { strings: boolean }): string {
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
      const end = source.indexOf("*/", i + 2);
      const stop = end < 0 ? n : end + 2;
      out += fill(source.slice(i, stop));
      i = stop;
    } else if (source.startsWith('"""', i) || (/[$@]/.test(c) && /^[$@]+"""/.test(source.slice(i, i + 6)))) {
      const start = source.indexOf('"""', i);
      const end = source.indexOf('"""', start + 3);
      const stop = end < 0 ? n : end + 3;
      out += emit(source.slice(i, stop));
      i = stop;
    } else if (/^[$@]+"/.test(source.slice(i, i + 3)) || c === '"') {
      // Verbatim strings (@"...") end at a quote that is not doubled; the others honour backslash escapes.
      const prefix = /^[$@]*/.exec(source.slice(i, i + 3))![0];
      const verbatim = prefix.includes("@");
      let j = i + prefix.length + 1;
      while (j < n) {
        if (verbatim) {
          if (source[j] === '"' && source[j + 1] === '"') j += 2;
          else if (source[j] === '"') break;
          else j++;
        } else if (source[j] === "\\") j += 2;
        else if (source[j] === '"' || source[j] === "\n") break;
        else j++;
      }
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

export type CsType = { name: string; namespace: string; isPublic: boolean };
export type CsUsing = { namespace: string; isStatic: boolean; alias?: string; isGlobal: boolean };

/** Brace depth in front of every offset. */
function braceDepths(code: string): Int32Array {
  const depth = new Int32Array(code.length + 1);
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    depth[i] = d;
    if (code[i] === "{") d++;
    else if (code[i] === "}") d = Math.max(0, d - 1);
  }
  depth[code.length] = d;
  return depth;
}

function closingBrace(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return i;
  }
  return code.length;
}

type NamespaceRegion = { name: string; start: number; end: number; bodyDepth: number };

/** Namespaces of a file: block regions (`namespace A.B { }`, possibly nested) and a file-scoped one (`namespace A.B;`). */
function namespaceRegions(code: string, depth: Int32Array): { blocks: NamespaceRegion[]; fileScoped?: { name: string; start: number } } {
  const blocks: NamespaceRegion[] = [];
  let fileScoped: { name: string; start: number } | undefined;
  for (const m of code.matchAll(new RegExp(String.raw`(?:^|[\s;}])namespace\s+([\w.]+)\s*([{;])`, "g"))) {
    const at = m.index! + m[0].indexOf("namespace");
    if (m[2] === ";") fileScoped = { name: m[1]!, start: at };
    else {
      const open = m.index! + m[0].length - 1;
      blocks.push({ name: m[1]!, start: open, end: closingBrace(code, open), bodyDepth: depth[open]! + 1 });
    }
  }
  return { blocks, fileScoped };
}

const TYPE_DECL = new RegExp(
  String.raw`(?:^|[\s;{}\]])((?:(?:public|internal|private|protected|static|abstract|sealed|partial|readonly|unsafe|new|ref|file)\s+)*)(?:class|struct|interface|enum|record(?:\s+(?:class|struct))?)\s+(${IDENT})`,
  "g",
);
const DELEGATE_DECL = new RegExp(String.raw`(?:^|[\s;{}\]])((?:(?:public|internal|private|protected|unsafe|new)\s+)*)delegate\s+[^;(]*?\b(${IDENT})\s*[<(]`, "g");

/** Top-level types of a file with the namespace each is in (not nested types). */
export function csTypes(content: string): CsType[] {
  const code = blankCs(content, { strings: true });
  const depth = braceDepths(code);
  const { blocks, fileScoped } = namespaceRegions(code, depth);
  const out: CsType[] = [];

  const consider = (m: RegExpMatchArray, modifiers: string) => {
    const at = m.index! + m[0].lastIndexOf(m[2]!);
    // The namespace this declaration sits in: the innermost block containing it, nested names joined.
    const enclosing = blocks.filter((b) => at > b.start && at < b.end).sort((a, b) => a.start - b.start);
    const inner = enclosing.at(-1);
    const bodyDepth = inner ? inner.bodyDepth : 0;
    if (depth[at] !== bodyDepth) return; // inside another type
    const parts = enclosing.map((b) => b.name);
    if (fileScoped && at > fileScoped.start) parts.unshift(fileScoped.name);
    out.push({ name: m[2]!, namespace: parts.join("."), isPublic: !/\b(private|file)\b/.test(modifiers) });
  };
  for (const m of code.matchAll(TYPE_DECL)) consider(m, m[1]!);
  for (const m of code.matchAll(DELEGATE_DECL)) consider(m, m[1]!);
  return out;
}

export function csUsings(content: string): CsUsing[] {
  const code = blankCs(content, { strings: true });
  const out: CsUsing[] = [];
  for (const m of code.matchAll(new RegExp(String.raw`^[ \t]*(global\s+)?using\s+(static\s+)?(?:(${IDENT})\s*=\s*)?([\w.]+)\s*;`, "gm"))) {
    out.push({ namespace: m[4]!, isStatic: !!m[2], isGlobal: !!m[1], ...(m[3] ? { alias: m[3] } : {}) });
  }
  return out;
}

/** Public and internal top-level types (what other files can see). */
export const csExports = (content: string): string[] => [...new Set(csTypes(content).filter((t) => t.isPublic).map((t) => t.name))];

const ancestors = (ns: string): string[] => {
  const parts = ns.split(".").filter(Boolean);
  return parts.map((_, i) => parts.slice(0, parts.length - i).join("."));
};

/** Names of the extension methods a file declares (`static T Name(this X x, …)`), with the static class each sits in. */
function extensionMethodNames(code: string, types: readonly CsType[]): Array<{ method: string; type: CsType }> {
  const out: Array<{ method: string; type: CsType }> = [];
  const owner = types.find((t) => new RegExp(String.raw`static\s+class\s+${t.name}\b`).test(code)) ?? types[0];
  if (!owner) return out;
  for (const m of code.matchAll(new RegExp(String.raw`\bstatic\s+[^;{}=()]*?\b(${IDENT})\s*(?:<[^>(){}]*>)?\s*\(\s*(?:\[[^\]]*\]\s*)?this\s`, "g"))) out.push({ method: m[1]!, type: owner });
  return out;
}

/**
 * Edges for the C# files in `files`. Types in the importer's own namespace or an enclosing one
 * (no `using` needed) are linked as `samePackage`, like Java's same-package use; types reached
 * through `using` are real dependencies.
 */
export function csharpEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>): DependencyEdge[] {
  const cs = files.filter((f) => f.path.endsWith(".cs") && idForPath.has(f.path));
  if (cs.length === 0) return [];

  type Info = { file: SourceFile; types: CsType[]; usings: CsUsing[]; body: string; namespaces: string[] };
  const infos: Info[] = cs.map((file) => {
    const types = csTypes(file.content);
    const code = blankCs(file.content, { strings: true });
    // Drop using and namespace lines so they do not count as mentions.
    const body = code.replace(new RegExp(String.raw`^[ \t]*(?:global\s+)?using\s[^;]*;|(?:^|[\s;}])namespace\s+[\w.]+\s*;?`, "gm"), (m) => m.replace(/[^\n]/g, " "));
    return { file, types, usings: csUsings(file.content), body, namespaces: [...new Set(types.map((t) => t.namespace))] };
  });

  // Simple name → every declaration of it (a partial class has one per file).
  const declarations = new Map<string, Array<{ info: Info; type: CsType }>>();
  const byFqn = new Map<string, Info[]>();
  for (const info of infos) {
    for (const type of info.types) {
      (declarations.get(type.name) ?? declarations.set(type.name, []).get(type.name)!).push({ info, type });
      const fqn = type.namespace ? `${type.namespace}.${type.name}` : type.name;
      (byFqn.get(fqn) ?? byFqn.set(fqn, []).get(fqn)!).push(info);
    }
  }
  // Extension methods: method name → the in-repo static classes that declare it.
  const extensionMethods = new Map<string, Array<{ info: Info; type: CsType }>>();
  for (const info of infos) {
    const code = blankCs(info.file.content, { strings: true });
    for (const { method, type } of extensionMethodNames(code, info.types)) (extensionMethods.get(method) ?? extensionMethods.set(method, []).get(method)!).push({ info, type });
  }
  const globalNamespaces = new Set(infos.flatMap((i) => i.usings.filter((u) => u.isGlobal && !u.isStatic && !u.alias).map((u) => u.namespace)));

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
    if (!samePackage) delete existing.samePackage; // a `using` is a real dependency
  };

  for (const from of infos) {
    const ownNamespaces = new Set(from.namespaces.flatMap(ancestors));
    const imported = new Set([...from.usings.filter((u) => !u.isStatic && !u.alias).map((u) => u.namespace), ...globalNamespaces]);
    const aliases = new Map(from.usings.filter((u) => u.alias).map((u) => [u.alias!, u.namespace]));
    const visible = new Set([...ownNamespaces, ...imported, ""]); // types with no namespace are visible everywhere

    const words = new Set([...from.body.matchAll(new RegExp(String.raw`(?<![\w$.@])(${IDENT})`, "g"))].map((m) => m[1]!));

    for (const word of words) {
      const target = aliases.has(word) ? aliases.get(word)!.split(".").pop()! : word;
      const aliasNamespace = aliases.has(word) ? aliases.get(word)!.split(".").slice(0, -1).join(".") : undefined;
      const candidates = (declarations.get(target) ?? []).filter(({ info, type }) => info !== from && (aliasNamespace !== undefined ? type.namespace === aliasNamespace : visible.has(type.namespace)));
      if (candidates.length === 0) continue;
      // Prefer the nearest namespace when a name exists in several visible ones.
      const own = candidates.filter((c) => from.namespaces.includes(c.type.namespace));
      const nearest = own.length ? own : candidates.filter((c) => ownNamespaces.has(c.type.namespace));
      for (const { info, type } of nearest.length ? nearest : candidates) {
        add(from, info, [type.name], ownNamespaces.has(type.namespace) && !imported.has(type.namespace));
      }
    }

    // Extension methods are called as `x.Method()`, so the static class that declares them is never named:
    // link a file that calls a method an in-repo static class defines, when that class's namespace is visible.
    const called = new Set([...from.body.matchAll(new RegExp(String.raw`\.\s*(${IDENT})\s*(?:<[^>;()]*>)?\s*\(`, "g"))].map((m) => m[1]!));
    for (const method of called) {
      for (const { info, type } of extensionMethods.get(method) ?? []) {
        if (info === from || !visible.has(type.namespace)) continue;
        add(from, info, [type.name], ownNamespaces.has(type.namespace) && !imported.has(type.namespace));
      }
    }

    // Names written out in full: `Acme.Services.JwtService.Verify()`.
    for (const m of from.body.matchAll(new RegExp(String.raw`(?<![\w$.@])(${IDENT}(?:\s*\.\s*${IDENT})+)`, "g"))) {
      const parts = m[1]!.split(".").map((p) => p.trim());
      for (let end = parts.length; end >= 2; end--) {
        const hit = byFqn.get(parts.slice(0, end).join("."));
        if (hit) {
          for (const info of hit) add(from, info, [parts[end - 1]!], false);
          break;
        }
      }
    }

    // `using static Acme.Util.Strings;` uses that type's members.
    for (const u of from.usings.filter((x) => x.isStatic)) for (const info of byFqn.get(u.namespace) ?? []) add(from, info, [u.namespace.split(".").pop()!], false);
  }
  return [...merged.values()];
}
