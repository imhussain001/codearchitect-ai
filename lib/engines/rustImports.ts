import type { DependencyEdge, SourceFile } from "@/lib/types";

/**
 * Rust support. Files form a module tree under each crate's `src/` (`a.rs` and `a/mod.rs` are
 * module `a`), and a `use` path names a module or an item in it, so an edge goes to the file of
 * the longest module prefix of the path, with the item after it as the symbol.
 *
 * Handles `crate::`, `self::`, `super::`, nested groups (`use a::{b, c::D as E}`), globs, `pub use`,
 * and workspace crates referenced by name (the crate name is taken from its directory, since
 * `Cargo.toml` is not analysed). Lexical: no macro expansion, no `#[path]`, no trait resolution.
 */

const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Replace comments (including nested block comments) and string/char literals with spaces. Lifetimes are left alone. */
function blankRust(source: string, { strings }: { strings: boolean }): string {
  let out = "";
  let i = 0;
  const n = source.length;
  const fill = (t: string) => t.replace(/[^\n]/g, " ");
  const emit = (text: string) => (strings ? fill(text) : text);
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
    } else if ((c === "r" || (c === "b" && next === "r")) && /^b?r#*"/.test(source.slice(i, i + 12))) {
      const m = /^b?r(#*)"/.exec(source.slice(i, i + 12))!;
      const close = `"${m[1]}`;
      const end = source.indexOf(close, i + m[0].length);
      const stop = end < 0 ? n : end + close.length;
      out += emit(source.slice(i, stop));
      i = stop;
    } else if (c === '"') {
      let j = i + 1;
      while (j < n && source[j] !== '"') j += source[j] === "\\" ? 2 : 1;
      const stop = Math.min(j + 1, n);
      out += emit(source.slice(i, stop));
      i = stop;
    } else if (c === "'") {
      // 'x' or '\n' is a char literal; 'a (no closing quote right after) is a lifetime.
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

/* ---------- `use` parsing ---------- */

export type UsePath = {
  segments: string[];
  alias?: string;
  glob: boolean;
  /** Brace depth of the statement: above 0 it is inside an inline `mod { }` or a function body, where `self`/`super` mean something else. */
  depth: number;
};

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") depth--;
    else if (text[i] === "," && depth === 0) (parts.push(text.slice(start, i)), (start = i + 1));
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function matchingBrace(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return i;
  }
  return text.length;
}

/** Expand one use tree (`a::{b, c::D as E}`) into flat paths. */
export function expandUseTree(tree: string, depth = 0): UsePath[] {
  const out: UsePath[] = [];
  const walk = (prefix: string[], text: string) => {
    const t = text.trim();
    const brace = t.indexOf("{");
    if (brace < 0) {
      const [path = "", alias] = t.split(/\s+as\s+/).map((s) => s.trim());
      const segments = path.split("::").map((s) => s.trim()).filter(Boolean);
      if (segments.length === 0) return;
      const all = [...prefix, ...segments];
      // `use a::b::{self}` names the module `a::b` itself.
      if (all.at(-1) === "self" && all.length > 1) all.pop();
      out.push({ segments: all, ...(alias && alias !== "_" ? { alias } : {}), glob: all.at(-1) === "*", depth });
      return;
    }
    const head = t.slice(0, brace).replace(/::\s*$/, "").split("::").map((s) => s.trim()).filter(Boolean);
    const close = matchingBrace(t, brace);
    for (const part of splitTop(t.slice(brace + 1, close))) walk([...prefix, ...head], part);
  };
  walk([], tree);
  return out;
}

/** Every `use` in a file (including `pub use` and `pub(crate) use`), expanded. */
export function rustUses(content: string): UsePath[] {
  const code = blankRust(content, { strings: true });
  const depthAt = new Int32Array(code.length + 1);
  let d = 0;
  for (let k = 0; k < code.length; k++) {
    depthAt[k] = d;
    if (code[k] === "{") d++;
    else if (code[k] === "}") d = Math.max(0, d - 1);
  }
  const out: UsePath[] = [];
  for (const m of code.matchAll(/(?:^|[;{}\s])(?:pub(?:\([^)]*\))?\s+)?use\s+([^;]+);/g)) out.push(...expandUseTree(m[1]!.replace(/\s+/g, " "), depthAt[m.index! + m[0].indexOf("use")]!));
  return out;
}

/** Public top-level items (`pub fn`, `pub struct`, …; `pub(crate)` and `pub(super)` included) and exported macros. */
export function rustExports(content: string): string[] {
  const code = blankRust(content, { strings: true });
  const depth = new Int32Array(code.length + 1);
  let d = 0;
  for (let i = 0; i < code.length; i++) {
    depth[i] = d;
    if (code[i] === "{") d++;
    else if (code[i] === "}") d = Math.max(0, d - 1);
  }
  const names = new Set<string>();
  const item = new RegExp(String.raw`^[ \t]*pub(?:\([^)]*\))?\s+(?:(?:async|unsafe|const|default)\s+|extern\s+"[^"]*"\s+)*(?:fn|struct|enum|trait|type|const|static|mod|union)\s+(${IDENT})`, "gm");
  for (const m of code.matchAll(item)) if (depth[m.index!] === 0) names.add(m[1]!);
  // Strings were blanked, so macro attributes and names are read from the comment-free original.
  for (const m of blankRust(content, { strings: false }).matchAll(new RegExp(String.raw`#\[macro_export[^\]]*\]\s*macro_rules!\s*(${IDENT})`, "g"))) names.add(m[1]!);
  return [...names];
}

/* ---------- Module tree ---------- */

type Located = { crate: string; mod: string[]; path: string };

const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Directories that hold a crate root (`main.rs` or `lib.rs`) outside the conventional `src/`, for
 * crates whose `Cargo.toml` points `path` somewhere else (ripgrep keeps its binary in `crates/core/`).
 */
export function customCrateRoots(paths: readonly string[]): string[] {
  const roots = new Set<string>();
  for (const path of paths) {
    if (!path.endsWith(".rs") || /(^|\/)src\//.test(path)) continue;
    if (baseOf(path) === "main.rs" || baseOf(path) === "lib.rs") roots.add(dirOf(path));
  }
  return [...roots];
}

/**
 * Which crate a file belongs to and where it sits in that crate's module tree. Files under `src/`
 * follow the Cargo convention; files elsewhere belong to the nearest enclosing `rootDirs` entry
 * (see `customCrateRoots`). Anything else has no module position.
 */
export function locate(path: string, rootDirs: readonly string[] = []): Located | undefined {
  const m = /^(?:(.*?)\/)?src\/(.*)$/.exec(path);
  if (m && m[2]!.endsWith(".rs")) {
    const dir = m[1] ?? "";
    const segs = m[2]!.slice(0, -3).split("/");

    if (segs[0] === "bin" && segs.length > 1) {
      // src/bin/tool.rs and src/bin/tool/main.rs are crate roots of their own; src/bin/tool/x.rs is module x of it.
      const tool = segs[1]!;
      const crate = `${dir}#bin/${tool}`;
      const rest = segs.slice(2);
      if (segs.length === 2 || (rest.length === 1 && rest[0] === "main")) return { crate, mod: [], path };
      if (rest.at(-1) === "mod") rest.pop();
      return { crate, mod: rest, path };
    }
    const rest = [...segs];
    if (rest.length === 1 && (rest[0] === "lib" || rest[0] === "main")) return { crate: dir, mod: [], path };
    if (rest.at(-1) === "mod") rest.pop();
    return { crate: dir, mod: rest, path };
  }

  // A crate whose root is not under src/: the deepest root directory that contains the file.
  const root = rootDirs.filter((r) => (r === "" ? true : path.startsWith(`${r}/`))).sort((a, b) => b.length - a.length)[0];
  if (root === undefined || !path.endsWith(".rs")) return undefined;
  const segs = (root === "" ? path : path.slice(root.length + 1)).slice(0, -3).split("/");
  if (segs.length === 1 && (segs[0] === "lib" || segs[0] === "main")) return { crate: root || ".", mod: [], path };
  if (segs.at(-1) === "mod") segs.pop();
  return { crate: root || ".", mod: segs, path };
}

const crateNameOf = (dir: string, repoName: string) => (dir.split("/").pop() || repoName).replace(/-/g, "_");

/** Positions of every Rust file in its crate's module tree, and a way to find the file of a module. */
function buildModuleIndex(rs: readonly SourceFile[], repoName: string) {
  const rootDirs = customCrateRoots(rs.map((f) => f.path));
  const modules = new Map<string, string>(); // "crate|a::b" → path
  const libCrates = new Map<string, string>(); // crate name → crate key (library crates can be imported by name)
  const at = new Map<string, Located>();
  for (const f of rs) {
    const loc = locate(f.path, rootDirs);
    if (!loc) continue;
    at.set(f.path, loc);
    modules.set(`${loc.crate}|${loc.mod.join("::")}`, f.path);
    if (/(^|\/)src\/lib\.rs$/.test(f.path) || (loc.mod.length === 0 && baseOf(f.path) === "lib.rs")) libCrates.set(crateNameOf(loc.crate, repoName), loc.crate);
  }
  const fileOf = (crate: string, mod: readonly string[]) => modules.get(`${crate}|${mod.join("::")}`);
  return { at, libCrates, fileOf };
}

/** `mod name;` declarations (not inline `mod name { }`), with whether `#[cfg(test)]` is directly above. */
function declaredModules(content: string): Array<{ name: string; testOnly: boolean }> {
  const code = blankRust(content, { strings: true });
  const out: Array<{ name: string; testOnly: boolean }> = [];
  for (const m of code.matchAll(new RegExp(String.raw`((?:#\[[^\]]*\]\s*)*)(?:pub(?:\([^)]*\))?\s+)?mod\s+(${IDENT})\s*;`, "g"))) {
    out.push({ name: m[2]!, testOnly: /#\[cfg\(\s*test\s*\)\]/.test(m[1]!) });
  }
  return out;
}

/**
 * Files that only exist under `#[cfg(test)]` (`#[cfg(test)] mod testutil;`) and everything they
 * declare in turn. They are not part of the built crate, so mapping them adds links and cycles
 * that are not in the product.
 */
export function rustTestOnlyPaths(files: readonly SourceFile[], repoName = ""): Set<string> {
  const rs = files.filter((f) => f.path.endsWith(".rs"));
  const { at, fileOf } = buildModuleIndex(rs, repoName);
  const content = new Map(rs.map((f) => [f.path, f.content]));
  const testOnly = new Set<string>();

  const childOf = (parent: string, name: string): string | undefined => {
    const loc = at.get(parent);
    return loc ? fileOf(loc.crate, [...loc.mod, name]) : undefined;
  };
  const queue: string[] = [];
  for (const f of rs) {
    for (const d of declaredModules(f.content)) {
      const child = d.testOnly ? childOf(f.path, d.name) : undefined;
      if (child && !testOnly.has(child)) (testOnly.add(child), queue.push(child));
    }
  }
  while (queue.length) {
    const parent = queue.pop()!;
    for (const d of declaredModules(content.get(parent) ?? "")) {
      const child = childOf(parent, d.name);
      if (child && !testOnly.has(child)) (testOnly.add(child), queue.push(child));
    }
  }
  return testOnly;
}

/**
 * Edges for the Rust files in `files`.
 * - Path starting `crate`/`self`/`super`, a child module in scope, or a workspace crate name resolves to a module file.
 * - The edge's symbols are the item names imported (or used through a module alias: `utils::helper()` → `helper`).
 * - Imports that climb to an ancestor module (`super::`, or `crate::` items that live in the crate root or a parent) are
 *   marked `samePackage`: a child using its parent's items is routine, and the parent re-exporting the child would
 *   otherwise look like a cycle.
 */
export function rustEdges(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>, repoName = ""): DependencyEdge[] {
  const rs = files.filter((f) => f.path.endsWith(".rs") && idForPath.has(f.path));
  if (rs.length === 0) return [];
  const { at, libCrates, fileOf } = buildModuleIndex(rs, repoName);

  const merged = new Map<string, DependencyEdge>();
  const add = (from: string, to: string, symbols: string[], ancestor: boolean) => {
    if (from === to) return;
    const source = idForPath.get(from)!;
    const target = idForPath.get(to)!;
    const id = `e-${source}--${target}`;
    const clean = [...new Set(symbols)].sort();
    const existing = merged.get(id);
    if (!existing) return void merged.set(id, { id, source, target, relation: "imports", ...(ancestor ? { samePackage: true } : {}), ...(clean.length ? { symbols: clean } : {}) });
    if (clean.length) existing.symbols = [...new Set([...(existing.symbols ?? []), ...clean])].sort();
    if (!ancestor) delete existing.samePackage;
  };

  for (const f of rs) {
    const here = at.get(f.path);
    const code = blankRust(f.content, { strings: true });

    /** Resolve one path (from a `use` or written out in code) to a module file and record the edge. */
    const link = (use: UsePath) => {
      const segs = use.segments;
      let crate: string | undefined;
      let mod: string[];
      let i = 0;

      const first = segs[0]!;
      // Inside an inline `mod x { }` or a function, `self` and `super` are relative to that scope, not this file.
      if (use.depth > 0 && (first === "self" || first === "super")) return;
      if (first === "crate" && here) ((crate = here.crate), (mod = []), (i = 1));
      else if (first === "self" && here) ((crate = here.crate), (mod = [...here.mod]), (i = 1));
      else if (first === "super" && here) {
        crate = here.crate;
        mod = [...here.mod];
        while (segs[i] === "super") (mod.pop(), i++);
      } else if (here && use.depth === 0 && fileOf(here.crate, [...here.mod, first])) ((crate = here.crate), (mod = [...here.mod]), (i = 0)); // a child module in scope wins over a crate of the same name
      else if (libCrates.has(first)) ((crate = libCrates.get(first)!), (mod = []), (i = 1));
      else return; // std, core, or an external crate

      // Walk as deep into the module tree as files exist; what follows is an item.
      while (i < segs.length && segs[i] !== "*" && fileOf(crate, [...mod, segs[i]!])) mod.push(segs[i++]!);
      const target = fileOf(crate, mod);
      if (!target) return;

      // The target is a strict ancestor of this file in the same crate (including the crate root).
      const ancestor = !!here && crate === here.crate && mod.length < here.mod.length && mod.every((s, k) => s === here.mod[k]);

      const symbols: string[] = [];
      if (use.glob) {
        // Link the module; name the items we can see in use.
        for (const name of rustExports(rs.find((x) => x.path === target)!.content)) if (new RegExp(String.raw`(?<![\w$.])${name}(?![\w])`).test(code)) symbols.push(name);
      } else if (i < segs.length) {
        symbols.push(segs[i]!);
      } else {
        // The module itself was imported: items are reached as `alias::item`.
        const local = use.alias ?? segs.at(-1)!;
        for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${local}\s*::\s*(${IDENT})`, "g"))) symbols.push(m[1]!);
      }
      add(f.path, target, symbols, ancestor);
    };

    for (const use of rustUses(f.content)) link(use);

    if (!here) continue;
    // Look for qualified paths only in real code: a `use crate::a::{b, c}` already named everything it needs.
    const body = code.replace(new RegExp(String.raw`(?:^|[;{}\s])(?:pub(?:\([^)]*\))?\s+)?use\s+[^;]+;`, "g"), (m) => m.replace(/[^\n]/g, " "));
    // Modules this file declares (`mod x;`) are used as `x::item` with no `use` at all.
    for (const { name } of declaredModules(f.content)) {
      const child = fileOf(here.crate, [...here.mod, name]);
      if (!child) continue;
      const used = [...body.matchAll(new RegExp(String.raw`(?<![\w$:.])${name}\s*::\s*(${IDENT})`, "g"))].map((m) => m[1]!);
      if (used.length) add(f.path, child, used, false);
    }
    // Paths written out in code: `crate::config::load()`.
    for (const m of body.matchAll(new RegExp(String.raw`(?<![\w$:.])crate((?:\s*::\s*${IDENT})+)`, "g"))) {
      const rest = m[1]!.split("::").map((s) => s.trim()).filter(Boolean);
      link({ segments: ["crate", ...rest], glob: false, depth: 0 });
    }
  }
  return [...merged.values()];
}
