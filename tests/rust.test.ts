import { describe, expect, it } from "vitest";
import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { expandUseTree, locate, rustExports, rustUses } from "@/lib/engines/rustImports";
import { analyzeHealth } from "@/lib/engines/health";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";

describe("use trees", () => {
  it("expands nested groups, aliases, self and globs", () => {
    expect(expandUseTree("crate::a::{b, c::D as E, self}")).toEqual([
      { segments: ["crate", "a", "b"], glob: false, depth: 0 },
      { segments: ["crate", "a", "c", "D"], alias: "E", glob: false, depth: 0 },
      { segments: ["crate", "a"], glob: false, depth: 0 },
    ]);
    expect(expandUseTree("super::*")).toEqual([{ segments: ["super", "*"], glob: true, depth: 0 }]);
    expect(expandUseTree("std::{io::{self, Read}, fmt}").map((u) => u.segments.join("::"))).toEqual(["std::io", "std::io::Read", "std::fmt"]);
  });

  it("finds every use statement, including pub use, and skips comments and strings", () => {
    const src = `// use fake::One;\nuse crate::a::X;\npub use crate::b::Y;\npub(crate) use self::c::Z;\nlet s = "use nope::Two;";\n/* use also::Fake; */\n`;
    expect(rustUses(src).map((u) => u.segments.join("::"))).toEqual(["crate::a::X", "crate::b::Y", "self::c::Z"]);
  });
});

describe("exports and module position", () => {
  it("lists pub top-level items, not methods or private items", () => {
    const src = `pub fn run() {}\nfn hidden() {}\npub struct Cfg { pub field: u8 }\nimpl Cfg { pub fn method(&self) {} }\npub(crate) enum Mode {}\npub async fn go() {}\n#[macro_export]\nmacro_rules! shout { () => {} }\n// pub fn commented() {}\n`;
    expect(rustExports(src).sort()).toEqual(["Cfg", "Mode", "go", "run", "shout"]);
  });

  it("places files in the module tree", () => {
    expect(locate("src/lib.rs")).toEqual({ crate: "", mod: [], path: "src/lib.rs" });
    expect(locate("src/a/b.rs")?.mod).toEqual(["a", "b"]);
    expect(locate("src/a/mod.rs")?.mod).toEqual(["a"]);
    expect(locate("crates/core/src/x.rs")).toEqual({ crate: "crates/core", mod: ["x"], path: "crates/core/src/x.rs" });
    expect(locate("src/bin/tool.rs")).toEqual({ crate: "#bin/tool", mod: [], path: "src/bin/tool.rs" });
    expect(locate("examples/demo.rs")).toBeUndefined();
  });
});

const files = [
  { path: "src/main.rs", content: `mod config;\nmod net;\n\nuse crate::config::Settings;\nuse crate::net::{client::Client, server};\nuse std::collections::HashMap;\nuse serde::Serialize;\n\nfn main() { let s = Settings::load(); server::run(&s); let _ = Client::new(); }\n` },
  { path: "src/config.rs", content: `pub struct Settings;\nimpl Settings { pub fn load() -> Self { Settings } }\npub fn unused_helper() {}\n` },
  { path: "src/net/mod.rs", content: `pub mod client;\npub mod server;\n\npub fn shared() {}\n` },
  { path: "src/net/client.rs", content: `use super::shared;\nuse crate::config::Settings;\n\npub struct Client;\nimpl Client { pub fn new() -> Self { shared(); let _ = Settings; Client } }\n` },
  { path: "src/net/server.rs", content: `use super::client::Client;\nuse crate::config::*;\n\npub fn run(s: &Settings) { let _ = Client::new(); }\n` },
];
const graph = buildHeuristicGraph("app", files);
const idOf = (p: string) => graph.nodes.find((n) => n.data.filePath === p)!.id;
const edge = (a: string, b: string) => graph.edges.find((e) => e.source === idOf(a) && e.target === idOf(b));

describe("Rust edges", () => {
  it("resolves crate:: paths to the module file, naming the item", () => {
    expect(edge("src/main.rs", "src/config.rs")?.symbols).toEqual(["Settings"]);
    expect(edge("src/main.rs", "src/net/client.rs")?.symbols).toEqual(["Client"]);
  });

  it("follows a module imported by name and the items used through it", () => {
    expect(edge("src/main.rs", "src/net/server.rs")?.symbols).toEqual(["run"]);
  });

  it("resolves super:: to the parent module file and marks it as an ancestor link", () => {
    const e = edge("src/net/client.rs", "src/net/mod.rs");
    expect(e?.symbols).toEqual(["shared"]);
    expect(e?.samePackage).toBe(true);
    expect(edge("src/main.rs", "src/config.rs")?.samePackage).toBeUndefined();
  });

  it("links a glob to the module, naming the items the file mentions", () => {
    expect(edge("src/net/server.rs", "src/config.rs")?.symbols).toEqual(["Settings"]);
  });

  it("ignores std and external crates", () => {
    expect(graph.edges.every((e) => graph.nodes.some((n) => n.id === e.target))).toBe(true);
    expect(graph.edges).toHaveLength(7);
  });

  it("treats main.rs and lib.rs as entry points and does not report a parent/child loop as a cycle", () => {
    const loop = buildHeuristicGraph("l", [
      { path: "src/lib.rs", content: `pub mod a;\npub use crate::a::Thing;\npub struct Root;\n` },
      { path: "src/a.rs", content: `use super::Root;\npub struct Thing(Root);\n` },
    ]);
    expect(loop.edges).toHaveLength(2);
    expect(analyzeHealth(loop).issues.filter((i) => i.kind === "cycle")).toEqual([]);
    const orphans = analyzeHealth(graph).issues.filter((i) => i.kind === "orphan").flatMap((i) => i.nodeIds);
    expect(orphans).not.toContain(idOf("src/main.rs"));
  });

  it("narrows blast radius to the files that use the named item", () => {
    const result = analyzeImpactLocally(graph, "change unused_helper", idOf("src/config.rs"));
    const touched = result.impacts.map((i) => graph.nodes.find((n) => n.id === i.nodeId)!.data.filePath);
    expect(touched).toEqual(["src/config.rs"]);
  });

  it("resolves workspace crates by directory name", () => {
    const ws = buildHeuristicGraph("ws", [
      { path: "crates/core-lib/src/lib.rs", content: `pub mod model;\n` },
      { path: "crates/core-lib/src/model.rs", content: `pub struct Item;\n` },
      { path: "crates/cli/src/main.rs", content: `use core_lib::model::Item;\nfn main() { let _ = Item; }\n` },
    ]);
    const e = ws.edges.find((x) => ws.nodes.find((n) => n.id === x.source)!.data.filePath === "crates/cli/src/main.rs");
    expect(ws.nodes.find((n) => n.id === e!.target)!.data.filePath).toBe("crates/core-lib/src/model.rs");
    expect(e!.symbols).toEqual(["Item"]);
  });

  it("copes with raw strings, lifetimes and nested comments", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/lib.rs", content: `pub mod a;\nfn f<'a>(x: &'a str) -> char { let _ = r#"use crate::a::Fake;"#; /* /* nested */ use crate::a::Nope; */ 'x' }\nuse crate::a::Real;\n` },
      { path: "src/a.rs", content: `pub struct Real;\n` },
    ]);
    expect(g.edges.map((e) => e.symbols)).toEqual([["Real"]]);
  });
});

describe("scope-relative uses", () => {
  it("ignores super/self inside inline modules (e.g. `mod tests { use super::*; }`)", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/lib.rs", content: `pub mod a;\npub struct Root;\n` },
      { path: "src/a.rs", content: `pub struct Thing;\n#[cfg(test)]\nmod tests {\n    use super::*;\n    use super::super::Root;\n}\n` },
    ]);
    expect(g.edges).toEqual([]);
  });

  it("still follows crate:: paths inside function bodies", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/lib.rs", content: `pub mod a;\npub fn f() { use crate::a::Thing; let _ = Thing; }\n` },
      { path: "src/a.rs", content: `pub struct Thing;\n` },
    ]);
    expect(g.edges.map((e) => e.symbols)).toEqual([["Thing"]]);
  });

  it("names mod.rs files after their folder", () => {
    const g = buildHeuristicGraph("t", [{ path: "src/net/mod.rs", content: `pub fn a() {}\n` }, { path: "src/lib.rs", content: `pub mod net;\n` }]);
    expect(g.nodes.map((n) => n.data.label).sort()).toEqual(["Lib", "Net"]);
  });
});

describe("found by mapping ripgrep, anyhow and friends", () => {
  it("maps a crate whose root is not under src/ (a custom [[bin]] path)", () => {
    const g = buildHeuristicGraph("rg", [
      { path: "crates/core/main.rs", content: `mod flags;\nmod haystack;\nuse crate::flags::Mode;\nfn main() { let _ = Mode::Search; haystack::scan(); }\n` },
      { path: "crates/core/flags/mod.rs", content: `mod defs;\npub enum Mode { Search }\npub use defs::Flag;\n` },
      { path: "crates/core/flags/defs.rs", content: `use super::Mode;\npub struct Flag(Mode);\n` },
      { path: "crates/core/haystack.rs", content: `pub fn scan() {}\n` },
    ]);
    const at = (a: string, b: string) => g.edges.find((e) => g.nodes.find((n) => n.id === e.source)!.data.filePath === a && g.nodes.find((n) => n.id === e.target)!.data.filePath === b);
    expect(at("crates/core/main.rs", "crates/core/flags/mod.rs")?.symbols).toEqual(["Mode"]);
    expect(at("crates/core/main.rs", "crates/core/haystack.rs")?.symbols).toEqual(["scan"]);
    expect(at("crates/core/flags/mod.rs", "crates/core/flags/defs.rs")?.symbols).toEqual(["Flag"]);
    expect(at("crates/core/flags/defs.rs", "crates/core/flags/mod.rs")?.samePackage).toBe(true);
  });

  it("treats `crate::` items that live in the crate root as an ancestor link, so a child and its parent are not a cycle", () => {
    const g = buildHeuristicGraph("gs", [
      { path: "src/lib.rs", content: `mod glob;\npub use crate::glob::Glob;\npub struct Error;\n` },
      { path: "src/glob.rs", content: `use crate::Error;\npub struct Glob(Error);\n` },
    ]);
    expect(g.edges).toHaveLength(2);
    expect(g.edges.filter((e) => e.samePackage)).toHaveLength(1);
    expect(analyzeHealth(g).issues.filter((i) => i.kind === "cycle")).toEqual([]);
  });

  it("leaves out files that only exist under #[cfg(test)], and what they declare", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/lib.rs", content: `pub mod real;\n#[cfg(test)]\nmod testutil;\n` },
      { path: "src/real.rs", content: `pub fn f() {}\n` },
      { path: "src/testutil.rs", content: `mod helpers;\npub fn t() { crate::real::f(); }\n` },
      { path: "src/testutil/helpers.rs", content: `pub fn h() {}\n` },
    ]);
    expect(g.nodes.map((n) => n.data.filePath).sort()).toEqual(["src/lib.rs", "src/real.rs"]);
  });

  it("links a module used as `x::item` after `mod x;` with no use statement", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/lib.rs", content: `mod literal;\npub fn run() { literal::build(); let _ = literal::Kind::A; }\n` },
      { path: "src/literal.rs", content: `pub fn build() {}\npub enum Kind { A }\n` },
    ]);
    expect(g.edges.map((e) => e.symbols)).toEqual([["Kind", "build"]]);
  });

  it("links a fully written-out crate:: path in code", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/lib.rs", content: `mod config;\nmod app;\n` },
      { path: "src/app.rs", content: `pub fn go() { let _ = crate::config::load(); }\n` },
      { path: "src/config.rs", content: `pub fn load() {}\n` },
    ]);
    const e = g.edges.find((x) => g.nodes.find((n) => n.id === x.source)!.data.filePath === "src/app.rs");
    expect(e?.symbols).toEqual(["load"]);
  });

  it("does not turn a use group's prefix into an extra link", () => {
    const g = buildHeuristicGraph("t", [
      { path: "src/main.rs", content: `mod net;\nuse crate::net::{client::Client, server};\nfn main() { let _ = Client; server::run(); }\n` },
      { path: "src/net/mod.rs", content: `pub mod client;\npub mod server;\n` },
      { path: "src/net/client.rs", content: `pub struct Client;\n` },
      { path: "src/net/server.rs", content: `pub fn run() {}\n` },
    ]);
    const fromMain = g.edges.filter((e) => g.nodes.find((n) => n.id === e.source)!.data.filePath === "src/main.rs");
    expect(fromMain.map((e) => g.nodes.find((n) => n.id === e.target)!.data.filePath).sort()).toEqual(["src/net/client.rs", "src/net/server.rs"]);
  });

  it("prefers a child module over a workspace crate of the same name", () => {
    const g = buildHeuristicGraph("ws", [
      { path: "crates/index/src/lib.rs", content: `pub use index::Index;\nmod index;\n` },
      { path: "crates/index/src/index.rs", content: `pub struct Index;\n` },
    ]);
    expect(g.edges).toHaveLength(1);
    expect(g.nodes.find((n) => n.id === g.edges[0]!.target)!.data.filePath).toBe("crates/index/src/index.rs");
  });

  it("treats build.rs as an entry point", () => {
    const g = buildHeuristicGraph("t", [{ path: "build.rs", content: `fn main() {}\n` }, { path: "src/lib.rs", content: `pub fn f() {}\n` }]);
    const orphans = analyzeHealth(g).issues.filter((i) => i.kind === "orphan").flatMap((i) => i.nodeIds);
    expect(orphans.map((id) => g.nodes.find((n) => n.id === id)!.data.filePath)).not.toContain("build.rs");
  });
});

describe("non-source assets", () => {
  it("skips Maven site resources and minified bundles", async () => {
    const { isAnalyzableSource } = await import("@/lib/engines/heuristicGraph");
    expect(isAnalyzableSource("src/site/resources/images/svg/diagrams.js")).toBe(false);
    expect(isAnalyzableSource("web/app.min.js")).toBe(false);
    expect(isAnalyzableSource("src/main/java/a/B.java")).toBe(true);
    expect(isAnalyzableSource("src/app.js")).toBe(true);
  });
});
