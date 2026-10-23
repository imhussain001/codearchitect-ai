import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * Ruby support. Ruby has no import statement for names: `require` loads a file, and any constant
 * (`Foo`, `Foo::Bar`) can then be used. Rails and Zeitwerk skip `require` altogether and load
 * `Foo::Bar` from `foo/bar.rb` on first use. So a file depends on another when it
 *   - `require`s / `require_relative`s / `autoload`s it, or
 *   - mentions a constant that the other file declares (`class`, `module`, `Struct.new` ...).
 *
 * Lexical: no interpreter. Nesting is read from indentation (`module A` / `  class B` is `A::B`),
 * which is how every Ruby style guide formats it.
 */

const OPENERS_BEFORE_REGEX = /(?:^|\n|[=(\[,{|&!?:;+\-*~<>]|\b(?:if|unless|elsif|when|and|or|not|return|then|while|until|puts|print|match|split|scan|sub|gsub|grep))\s*$/;
const PAIRS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };

/** Replace comments, heredoc bodies, `%w[]`-style and regex literals (and, if `strings`, quoted strings) with spaces. */
function blankRuby(source: string, { strings }: { strings: boolean }): string {
  const chunks: string[] = [];
  let tail = ""; // the last few characters written: string ops on the growing result would be quadratic
  const put = (t: string) => {
    chunks.push(t);
    tail = (tail + t).slice(-32);
  };
  let i = 0;
  const n = source.length;
  const fill = (t: string) => t.replace(/[^\n]/g, " ");
  const pendingHeredocs: Array<{ id: string; squiggly: boolean }> = [];
  const atLineStart = () => tail === "" || tail.endsWith("\n");
  const closer = (open: string) => PAIRS[open] ?? open;

  const skipDelimited = (from: number, open: string, nestable: boolean): number => {
    const close = closer(open);
    let depth = 1;
    let j = from;
    while (j < n && depth > 0) {
      const c = source[j]!;
      if (c === "\\") j += 2;
      else if (nestable && c === open && open !== close) (depth++, j++);
      else if (c === close) (depth--, j++);
      else j++;
    }
    return Math.min(j, n);
  };

  while (i < n) {
    const c = source[i]!;

    if (c === "\n" && pendingHeredocs.length > 0) {
      put(c);
      i++;
      for (const heredoc of pendingHeredocs.splice(0)) {
        while (i < n) {
          const end = source.indexOf("\n", i);
          const stop = end < 0 ? n : end;
          const line = source.slice(i, stop);
          put(fill(line));
          i = stop;
          if (i < n) (put("\n"), i++);
          if ((heredoc.squiggly ? line.trim() : line.replace(/\r$/, "")) === heredoc.id || line.trim() === heredoc.id) break;
        }
      }
      continue;
    }

    if (atLineStart() && source.startsWith("=begin", i)) {
      const end = source.indexOf("\n=end", i);
      const stop = end < 0 ? n : source.indexOf("\n", end + 1) < 0 ? n : source.indexOf("\n", end + 1);
      put(fill(source.slice(i, stop)));
      i = stop;
      continue;
    }
    if (atLineStart() && /^__END__\r?(\n|$)/.test(source.slice(i, i + 9))) {
      put(fill(source.slice(i)));
      break;
    }
    if (c === "#") {
      const end = source.indexOf("\n", i);
      const stop = end < 0 ? n : end;
      put(fill(source.slice(i, stop)));
      i = stop;
      continue;
    }

    if (c === "<" && source[i + 1] === "<") {
      const m = /^<<([~-]?)(["'`]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(source.slice(i, i + 80));
      const prev = tail.replace(/[ \t]+$/, "").slice(-1);
      // `x <<EOS` is a heredoc; `list <<Item` and `a << b` are appends, so a bare identifier must follow an assignment or an opening bracket.
      const startsExpression = prev === "" || "=(,[{".includes(prev);
      if (m && m[3] === m[3]!.toUpperCase() && (m[1] !== "" || m[2] !== "" || startsExpression)) {
        pendingHeredocs.push({ id: m[3]!, squiggly: m[1] === "~" || m[1] === "-" });
        put(m[0]);
        i += m[0].length;
        continue;
      }
    }

    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && source[j] !== c) {
        if (source[j] === "\\") j += 2;
        else if (c === '"' && source[j] === "#" && source[j + 1] === "{") j = skipDelimited(j + 2, "{", true);
        else j++;
      }
      const stop = Math.min(j + 1, n);
      const text = source.slice(i, stop);
      put(strings || c === "`" ? fill(text) : text);
      i = stop;
      continue;
    }

    if (c === "%") {
      const m = /^%([qQwWiIrsx]?)([(\[{<|!\/])/.exec(source.slice(i, i + 3));
      if (m && OPENERS_BEFORE_REGEX.test(tail.slice(-24))) {
        const stop = skipDelimited(i + m[0].length, m[2]!, true);
        put(fill(source.slice(i, stop)));
        i = stop;
        continue;
      }
    }

    if (c === "/" && OPENERS_BEFORE_REGEX.test(tail.slice(-24)) && source[i + 1] !== " " && source[i + 1] !== "=" && source[i + 1] !== "/") {
      const stop = skipDelimited(i + 1, "/", false);
      put(fill(source.slice(i, stop)));
      i = stop;
      continue;
    }

    put(c);
    i++;
  }
  return chunks.join("");
}

export type RubyRequire = { kind: "require" | "relative" | "autoload"; target: string };

export function rubyRequires(content: string): RubyRequire[] {
  const code = blankRuby(content, { strings: false });
  const out: RubyRequire[] = [];
  for (const m of code.matchAll(/^[ \t]*(require_relative|require_dependency|require|load)\b[ \t]*\(?[ \t]*(['"])([^'"\n]+)\2/gm))
    out.push({ kind: m[1] === "require_relative" ? "relative" : "require", target: m[3]! });
  for (const m of code.matchAll(/\bautoload\b[ \t]*\(?[ \t]*:\w+[ \t]*,[ \t]*(['"])([^'"\n]+)\1/g)) out.push({ kind: "autoload", target: m[2]! });
  return out;
}

/** Qualified names of the classes, modules and `X = Struct.new`-style constants a file declares. */
export function rubyDeclarations(content: string): string[] {
  const code = blankRuby(content, { strings: true });
  const stack: Array<{ indent: number; name: string }> = [];
  const found: string[] = [];
  for (const line of code.split("\n")) {
    const m = /^([ \t]*)(?:(?:class|module)[ \t]+(?!<<)([A-Z]\w*(?:::[A-Z]\w*)*)|([A-Z]\w*)[ \t]*=[ \t]*(?:Struct|Class|Module|Data)\.(?:new|define)\b)/.exec(line);
    if (!m) continue;
    const indent = m[1]!.replace(/\t/g, "  ").length;
    while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
    const name = (m[2] ?? m[3])!.replace(/^::/, "");
    const qualified = [...stack.map((s) => s.name), name].join("::");
    found.push(qualified);
    if (m[2]) stack.push({ indent, name });
  }
  return [...new Set(found)];
}

export const rubyExports = (content: string): string[] => rubyDeclarations(content);

/** Constant chains (`Foo`, `Foo::Bar`) used in code, excluding the names a file declares. */
function constantMentions(content: string): Set<string> {
  const code = blankRuby(content, { strings: true });
  const body = code.replace(/^([ \t]*(?:class|module)[ \t]+)([A-Z]\w*(?:::[A-Z]\w*)*)/gm, (_, head: string, name: string) => head + " ".repeat(name.length));
  const out = new Set<string>();
  for (const m of body.matchAll(/(?<![\w$@.:])(?:::)?([A-Z]\w*(?:::[A-Z]\w*)*)/g)) out.add(m[1]!);
  return out;
}

const joinPath = (base: string, relative: string): string => {
  const parts = base.split("/").slice(0, -1);
  for (const segment of relative.split("/")) {
    if (segment === "..") parts.pop();
    else if (segment !== ".") parts.push(segment);
  }
  return parts.join("/");
};

const MAX_AMBIGUOUS_FILES = 3;

/** Classes Ruby ships with. A file that says `class Float` is monkey-patching, not defining, so it does not own the name. */
const CORE_CONSTANTS = new Set(
  "Object BasicObject Module Class Kernel Comparable Enumerable Enumerator Array Hash String Symbol Integer Float Numeric Rational Complex Range Regexp MatchData Proc Method UnboundMethod Struct Time Date DateTime File Dir IO Exception StandardError RuntimeError ArgumentError NameError NoMethodError TypeError IOError LoadError Set BigDecimal Pathname URI Thread Mutex Fiber Process Marshal Math Random Binding NilClass TrueClass FalseClass Data ObjectSpace GC Signal Encoding StringIO".split(" "),
);

export function rubyEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>): DependencyEdge[] {
  const rb = files.filter((f) => f.path.endsWith(".rb") && idForPath.has(f.path));
  if (rb.length === 0) return [];
  const paths = new Set(rb.map((f) => f.path));

  type Info = { file: SourceFile; decls: string[]; namespaces: Set<string>; scopes: Set<string>; mentions: Set<string>; requires: RubyRequire[] };
  const infos: Info[] = rb.map((file) => {
    const decls = rubyDeclarations(file.content);
    const namespaces = new Set<string>([""]);
    for (const d of decls) {
      const parts = d.split("::");
      for (let k = 1; k < parts.length; k++) namespaces.add(parts.slice(0, k).join("::"));
    }
    return { file, decls, namespaces, scopes: new Set([...namespaces, ...decls]), mentions: constantMentions(file.content), requires: rubyRequires(file.content) };
  });

  const declaredAs = new Map<string, Array<{ info: Info; qualified: string }>>();
  for (const info of infos)
    for (const qualified of info.decls) {
      if (CORE_CONSTANTS.has(qualified)) continue;
      const last = qualified.slice(qualified.lastIndexOf(":") + 1);
      (declaredAs.get(last) ?? declaredAs.set(last, []).get(last)!).push({ info, qualified });
    }

  // `module Acme` is reopened by every file under lib/acme/: only the file that owns it is what a mention of `Acme` depends on.
  // The owner is the file at the conventional path (Acme::HttpClient -> acme/http_client.rb), else a file that is not just a wrapper.
  const underscore = (name: string) => name.replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2").replace(/([a-z\d])([A-Z])/g, "$1_$2").toLowerCase();
  const conventionalPath = (qualified: string) => qualified.split("::").map(underscore).join("/");
  for (const [last, entries] of declaredAs) {
    const byQualified = new Map<string, Array<{ info: Info; qualified: string }>>();
    for (const e of entries) (byQualified.get(e.qualified) ?? byQualified.set(e.qualified, []).get(e.qualified)!).push(e);
    const kept: Array<{ info: Info; qualified: string }> = [];
    for (const [qualified, group] of byQualified) {
      if (group.length === 1) {
        kept.push(...group);
        continue;
      }
      const wanted = `${conventionalPath(qualified)}.rb`;
      const conventional = group.filter((e) => e.info.file.path === wanted || e.info.file.path.endsWith(`/${wanted}`));
      const concrete = group.filter((e) => !e.info.decls.some((d) => d.startsWith(`${qualified}::`)));
      kept.push(...(conventional.length ? conventional : concrete.length === 1 ? concrete : []));
    }
    declaredAs.set(last, kept);
  }

  const merged = new Map<string, DependencyEdge>();
  const add =(from: Info, to: Info, symbols: string[], samePackage: boolean) => {
    if (from === to) return;
    const source = idForPath.get(from.file.path)!;
    const target = idForPath.get(to.file.path)!;
    const id = `e-${source}--${target}`;
    const clean = [...new Set(symbols)].sort();
    const existing = merged.get(id);
    if (!existing) return void merged.set(id, { id, source, target, relation: "imports", ...(samePackage ? { samePackage: true } : {}), ...(clean.length ? { symbols: clean } : {}) });
    if (clean.length) existing.symbols = [...new Set([...(existing.symbols ?? []), ...clean])].sort();
    if (!samePackage) delete existing.samePackage;
  };

  const byPath = new Map(infos.map((i) => [i.file.path, i]));
  // `require "a/b"` is resolved against load paths: a gem's lib/ directory (or Rails' app/*/), never a deeper folder that happens to end the same way.
  const loadable = new Map<string, string[]>();
  for (const p of paths) {
    const keys = [p, /(?:^|\/)lib\/(.+)$/.exec(p)?.[1], /(?:^|\/)app\/[^/]+\/(.+)$/.exec(p)?.[1]];
    for (const key of keys) if (key) (loadable.get(key) ?? loadable.set(key, []).get(key)!).push(p);
  }
  const resolveRequire = (from: Info, r: RubyRequire): Info | undefined => {
    const target = r.target.endsWith(".rb") ? r.target : `${r.target}.rb`;
    if (r.kind === "relative") {
      const hit = joinPath(from.file.path, target);
      return paths.has(hit) ? byPath.get(hit) : undefined;
    }
    const hits = loadable.get(target.replace(/^\.?\//, ""));
    if (!hits) return undefined;
    const rank = (p: string) => (/(^|\/)lib\//.test(p) ? 0 : 1) * 1000 + p.length;
    return byPath.get([...hits].sort((a, b) => rank(a) - rank(b))[0]!);
  };

  /** The declarations a constant chain refers to: the longest prefix that something declares, preferring the file's own namespaces. */
  const resolve = (from: Info, chain: string): Array<{ info: Info; qualified: string }> => {
    const parts = chain.split("::");
    for (let k = parts.length; k >= 1; k--) {
      const key = parts.slice(0, k).join("::");
      // Ruby looks a constant up in the enclosing modules, then at the top level: `Request` inside `module Rack::Protection` is never `Sinatra::Request`.
      const pick = (declaredAs.get(parts[k - 1]!) ?? []).filter((d) => d.qualified === key || [...from.scopes].some((scope) => scope !== "" && d.qualified === `${scope}::${key}`));
      if (pick.length === 0) continue;
      return new Set(pick.map((d) => d.info)).size > MAX_AMBIGUOUS_FILES ? [] : pick;
    }
    return [];
  };

  for (const from of infos) {
    const required = new Set<Info>();
    for (const r of from.requires) {
      const to = resolveRequire(from, r);
      if (to && to !== from) required.add(to);
    }
    const bySymbols = new Map<Info, { symbols: string[]; samePackage: boolean }>();
    for (const chain of from.mentions) {
      for (const hit of resolve(from, chain)) {
        if (hit.info === from) continue;
        const ns = hit.qualified.includes("::") ? hit.qualified.slice(0, hit.qualified.lastIndexOf("::")) : "";
        const isAncestor = from.decls.some((d) => d === hit.qualified || d.startsWith(`${hit.qualified}::`));
        const samePackage = isAncestor || (ns !== "" && from.namespaces.has(ns));
        const entry = bySymbols.get(hit.info) ?? bySymbols.set(hit.info, { symbols: [], samePackage: true }).get(hit.info)!;
        entry.symbols.push(hit.qualified);
        entry.samePackage &&= samePackage;
      }
    }
    // Reopening `module A` in a file that declares `A::B`: the file belongs to A, so it depends on where A is defined.
    for (const d of from.decls) {
      const parts = d.split("::");
      for (let k = 1; k < parts.length; k++) {
        const ancestor = parts.slice(0, k).join("::");
        for (const hit of declaredAs.get(ancestor.slice(ancestor.lastIndexOf(":") + 1)) ?? []) {
          if (hit.qualified !== ancestor || hit.info === from) continue;
          const entry = bySymbols.get(hit.info) ?? bySymbols.set(hit.info, { symbols: [], samePackage: true }).get(hit.info)!;
          entry.symbols.push(ancestor);
        }
      }
    }
    // A file that requires the file defining its parent namespace (`require 'acme'` in acme/client.rb) is not depending on a peer.
    const definesParent = (to: Info) => to.decls.some((d) => from.decls.some((fd) => fd.startsWith(`${d}::`)));
    for (const [to, { symbols, samePackage }] of bySymbols) add(from, to, symbols, samePackage && (!required.has(to) || definesParent(to)));
    for (const to of required) if (!bySymbols.has(to)) add(from, to, [], definesParent(to));
  }
  return [...merged.values()];
}
