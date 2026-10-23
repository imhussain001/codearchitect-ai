# Analysis engines

The local engines are pure TypeScript modules in `lib/engines/`, plus `lib/graph.ts` and `lib/diff.ts`. They are deterministic, have no I/O, and run both in the browser and on the server. Each section names its source file and its tests.

## Graph primitives (`lib/graph.ts`)

### Reverse-dependency BFS: `collectDependents(rootId, edges)`

Builds a `target → [sources]` index, then runs a breadth-first search from `rootId` along it. It returns `Map<nodeId, hops>` with the root at 0.

- Complexity **O(V + E)**. Each node is enqueued at most once, so cycles terminate.
- BFS gives the *shortest* hop count, which is what the canvas shows as "N hop".

### Impact-path edges: `impactPathEdgeIds(edges, impactedSet)`

An edge is highlighted when both its endpoints are impacted. This is a cheap approximation of the propagation subgraph. It can also highlight an edge between two impacted siblings that isn't on a root path; that is acceptable for visual emphasis.

### Layered layout: `layoutByKind(nodes)`

Places nodes in bands, top to bottom: `frontend → api → logic → data`. Each band holds at most 5 nodes per row (250 px column, 190 px row spacing), and rows are centred. It is deterministic, so re-importing the same repo gives the same picture.

## Architecture health (`lib/engines/health.ts`)

Tests: `tests/health.test.ts`. Pure; draft nodes and edges from the builder are ignored.

| Finding | Rule | Severity |
|---|---|---|
| Circular dependency | A strongly connected component with more than one node, or a self-loop (Tarjan, O(V+E)) | high |
| Crossed layer | An edge from a `frontend` node to a `data` node, or from `data` to `frontend`/`api` | medium |
| Hub | At least 4 direct dependents and at least 25% of the other components | medium |
| Large file | ≥ 400 lines (low), ≥ 800 lines (medium); uses `lineCount`, since `code` may be truncated | low / medium |
| Unconnected | No edges at all in a graph of more than one component, unless it looks like an entry point (Next.js `layout`/`page`/`route`, `main`/`index`, `*.config.*`, or anything under `scripts/`, `bin/`, `cli/`) | low |

**Type-only imports.** The mapper marks an edge `typeOnly` when a file imports a module only through `import type` / `export type` (a value import of the same module wins). Health ignores these edges for hubs, fan-in, cycles and crossed layers, because they are erased at runtime; a type-only module still counts as connected. Blast radius and rules keep them, since changing a type breaks its users at compile time. On this repo that removed a false "Types is a hub (40 dependents)" and lifted the grade from B to A.

**Change-risk per component** (0–100): 8 per direct dependent (cap 40) + 3 per dependency (cap 15) + 1 per 20 lines (cap 20) + 30 if in a cycle + 15 if it crosses layers. Bands: healthy < 35, watch 35–64, risky ≥ 65.

**Overall** = 100 − (12 × cycles + 8 × crossed layers + 5 × hubs + 4 × large files + 2 × unconnected), floored at 0. Grades: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, else F.

The weights are named constants at the top of the file. They are heuristics for ranking where to look first, not calibrated probabilities.

## Architecture rules (`lib/engines/rules.ts`)

Tests: `tests/rules.test.ts`. `evaluateRules(graph, rules?)` returns one `RuleViolation` per breach: `forbid` per offending edge (the edge is drawn dashed orange), `no-cycles` per loop (every edge inside it), `max-dependents` and `max-lines` per component. A selector is `|`-joined alternatives of `kind:`, `path:` (glob), `label:` (glob), `id:` or `*`; globs treat `**` as any depth. `violationKey` gives each violation a stable identity so a PR check can tell new from existing. Syntax and examples: [cli-and-ci.md](cli-and-ci.md#rules).

## Pull-request report (`lib/report.ts`)

Tests: `tests/report.test.ts`. A `Snapshot` is a graph plus its health report and violations. `compareSnapshots(base, head, changedFiles)`:

1. **New and fixed problems:** issues and violations are matched by stable keys (a cycle by its sorted member ids, others by id), so only genuinely new ones are reported.
2. **Blast radius:** each changed file maps to a component in the head graph (path-suffix match); a reverse BFS over the head's edges gives direct (1 hop) and indirect (2+ hops) dependents. Files that no longer exist are looked up in the base graph, and survivors that still depend on them are flagged. Unmappable files (docs, config) are listed separately.
3. **Check:** fails on a new cycle and on a new `error`-severity violation by default, optionally on a health drop. A `no-cycles` violation that matches a new cycle is folded into it so one loop is counted once.

`renderMarkdown` produces the PR comment, led by a hidden marker so a bot can update its own comment; `comparisonToJson` gives a compact machine-readable form.

## Search ranking (`lib/search.ts`)

Tests: `tests/search.test.ts`. The query is split into words and **every word must match** (AND). Each word scores by its best field: name word-prefix 80, name substring 60, path 40, exported symbol 35, keyword prefix 30, description 10. An exact full-name match adds 100 and a name prefix adds 40. CamelCase and path separators are split so "user dash" finds `UserDashboard`.

## Impact analysis

`lib/engines/localImpact.ts` · tests: `tests/localImpact.test.ts`

```
prompt ──► authored scenario match? ──yes──► root = scenario.rootNodeId
                │ no
                ▼
        rank nodes for prompt ──► root (selected node wins on near-ties)
                │
                ▼
     reverse BFS from root ──► severity per node ──► diffs ──► risk score
```

### 1. Scenario matching

`graph.scenarios[i].triggers` are case-insensitive regex sources, and the first scenario with any matching trigger wins. Scenarios carry hand-written `after` code, so their diffs are exact.

### 2. Root ranking (no scenario)

The prompt is tokenised: camelCase is split, text is lower-cased and split on non-alphanumerics, and tokens shorter than 3 characters or in a small stop-word list are dropped. Each node is then scored:

| Match | Points |
|---|---|
| token ∈ `keywords` | +3 each |
| token ∈ words of `label` | +2 each |
| token ∈ words of an export name | +2 each |
| token ∈ segments of `filePath` | +1 each |

If a node is **selected**, it is the root unless the best-scoring node beats it by **≥ 2 points**, meaning the prompt clearly names something else. With no selection and a best score of 0, the engine throws `ImpactRootNotFoundError`.

### 3. Severity

| Situation | `modified` | `broken` | `impacted` |
|---|---|---|---|
| Root | always | | |
| Authored scenario | | the node has an authored edit | every other dependent (review only) |
| No scenario | | depth 1 (direct consumers) | depth ≥ 2 |

`scenario.extraImpacts` adds couplings that the graph cannot show, for example a value carried inside a JWT claim. They are added at depth 1 and are `broken` if the scenario also edits that node.

> The scenario rule exists because "every direct dependent breaks" over-reports badly. Changing `collectDependents` from a `Map` to a `Record` affects five importers of `lib/graph.ts`, yet only two call Map methods. See the `fix(impact)` commit.

### 4. Diffs

- **Scenario:** `before` is the node's current code and `after` is the authored code.
- **Heuristic:** for the root, lines containing prompt tokens are annotated `// ⚠ affected` and a `// CHANGE: <prompt>` marker is inserted after the imports. For dependents, lines that reference the root's exported identifiers (word-boundary match) are annotated and a `// REVIEW:` marker is inserted. The rationale says how many lines were flagged. These are pointers for review, not refactors.

### 5. Risk score

```
risk = min(100, round( (|impacts| / |nodes|) · 70  +  maxDepth · 10 ))
```

Breadth (the share of the system touched) contributes up to 70 points, and each hop of depth adds 10. The UI bands are Low ≤ 34, Medium ≤ 67, High > 67. The formula is a heuristic for ranking changes against each other, not a calibrated probability.

## Line diff (`lib/diff.ts`)

Tests: `tests/diff.test.ts`

1. Normalise `\r\n` to `\n` and split into lines.
2. Build an LCS table of `Uint32Array((n+1)(m+1))` cells: **O(n·m)** time and memory. Above 4,000,000 cells (about 16 MB) it falls back to "all removed, then all added".
3. Walk the table to get an edit script of `same`, `del` and `add` operations.
4. Pair each run of deletions with the following run of additions, row by row, into `changed` rows; leftovers become `removed` or `added`. This keeps the two columns of the side-by-side view aligned.

## Story engine (`lib/engines/story.ts`)

Tests: `tests/story.test.ts`

- **`parseGitLog(text)`** accepts default `git log --name-status` output (`commit <sha>`, `Author:`, `Date:`, an indented subject, then `A|M|D|R<score>\t<path>` lines) and `--oneline --name-status`. Renames keep the destination path. Commits are returned oldest first, with 7-character hashes.
- **`nodeIdForPath(path, nodes)`** normalises slashes and case, then matches when either path is a suffix of the other, so `server/db/users.ts` matches `src/server/db/users.ts`.
- **`commitsFromGitLog`**: the first `A` touching a node marks it *added* in that commit; any other touch counts as *modified*.
- **`visibleNodeIdsAt(nodes, commits, i)`**: a node is visible at frame `i` if it was introduced at or before `i`. Nodes that no commit introduces are treated as older than the history and are always visible.

## Heuristic repo mapper (`lib/engines/heuristicGraph.ts`)

Tests: `tests/heuristicGraph.test.ts`

| Step | Rule |
|---|---|
| Filter | Source extensions `ts tsx js jsx mjs cjs py go java kt rb cs php vue svelte`. Skips `node_modules`, build output, VCS, virtualenvs, tests/specs/stories, `.d.ts` and `*config.*` / `*rc.*` files |
| Classify | Path regexes in order: **data** (`db`, `models`, `schema`, `prisma`, `repository`, `cache`, `redis`…) → **api** (`api`, `routes`, `handlers`, `route.ts`, `urls.py`…) → **frontend** (`.tsx`/`.jsx`/`.vue`/`.svelte`, `components`, `pages`…) → otherwise **logic** |
| Select | Top **400** (`MAX_GRAPH_FILES`; callers may ask for 20–2,000, see `clampMaxFiles`) by relevance = kind weight (api/data 4, logic 3, frontend 2) − 0.1 × path depth + min(size / 20 KB, 1) |
| Edges | JS/TS `import … from`, `import()`, `require()` and `export … from`; Python `from x import` and `import x`. Resolves `./`, `../`, `@/` and `~/` (also under `src/`) and dotted Python modules |
| Node data | Exports by regex. Params from the first function signature. Code truncated to 120 lines with a "… N more lines" marker |

`lib/engines/zip.ts` extracts archives with JSZip. It strips a single wrapping folder (as in GitHub zipballs), skips `..` paths and files over 200 KB, and caps archives at 50 MB.

## Python (`lib/engines/pythonImports.ts`)

Python imports are followed **by name**, so a file's links say what it uses, not just that it imports something.

- **Forms:** `import a.b [as x]`, `from a.b import C [as D]`, `from . import x`, `from ..pkg import y` (relative levels), multi-line `from a import (b, c)`, backslash continuations, and `from a import *`. Comments, docstrings and strings are blanked first.
- **Resolution:** a dotted module is matched against the end of each file's path (the project root is not known), and when several files match the one sharing the longest directory prefix with the importer wins. `from pkg import name` links to `pkg/name.py` when that module exists (with the attributes used through it, `name.attr`), otherwise to the file defining `pkg` with symbol `name`. `import a.b as x` records the attributes used as `x.attr`. The standard library and installed packages never match a project file.
- **Used or not:** an imported name only counts when real code uses it (imports are removed before looking), except in `__init__.py`, where imports are how a package re-exports names.
- **Deferred imports:** an import inside a function, or under `if TYPE_CHECKING:`, is marked `typeOnly`, so health does not report the cycle it exists to break. Blast radius and rules still see it.
- **Exports:** `__all__` if the file defines it, else public top-level `def`, `class` and assignments (names not starting with `_`).
- **Limits:** lexical. `sys.path` changes, `importlib`, `__import__`, conditional imports of the same name, attribute access through objects (`obj.method()`), and calls inside a single module are not followed. Run against `psf/requests` (20 source files): 63 links, 60 with names, its `TYPE_CHECKING` imports flagged, Health B with no false cycles.

## C# (`lib/engines/csharpImports.ts`)

C# imports whole **namespaces**, not types, and a namespace can span many files, so links are made by name: a file uses type `T` when it mentions `T` and `T`'s namespace is visible to it.

- **Visible namespaces:** the file's own namespace and every enclosing one (`A.B.C` sees `A.B` and `A`), every `using Namespace;` in the file, every `global using` anywhere in the repository, and the global namespace. Block (`namespace A.B { }`, nested) and file-scoped (`namespace A.B;`) forms are both read; nested types are not mapped, only top-level ones (class, struct, interface, enum, record, delegate).
- **Other ways a type is reached:** `using Alias = Ns.Type;`, `using static Ns.Type;` (links to that type's file), and names written out in full (`Acme.Data.User.Empty`).
- **Ambiguity:** a name declared in several visible namespaces links to the nearest (own, then enclosing), otherwise to all of them. A `partial` class links to every part.
- **Same namespace:** a link to a type in the file's own or an enclosing namespace needs no `using`, so it is marked `samePackage` (ignored by cycle detection, kept for fan-in and blast radius); a link through a `using` is a real dependency.
- **Extension methods:** `x.Slug()` never names the static class that declares `Slug`, so a file that calls a method an in-repo `static` class declares with `this` is linked to that class when its namespace is visible.
- **Skipped:** `obj/`, `bin/Debug` and `bin/Release`, `*.Designer.cs`, `*.g.cs`, `*.generated.cs`, any `*AssemblyInfo*.cs`, `*.Tests` projects (also dotted like `*.Tests.Benchmarks`) and `*Test.cs` / `*Tests.cs` (case-sensitive, so `Contest.cs` stays).
- **Conventions:** `*Controller.cs` and `*Hub.cs` are API, `*Repository.cs`, `*DbContext.cs`, `*Entity.cs` and `Migrations/` are data; `Program.cs`, `Startup.cs`, controllers and hubs are entry points.
- **Limits:** lexical, no compiler or project files. Types reached only through `var`, reflection or dependency injection by interface name are linked only if the name appears; a method whose name matches an extension method's can be over-linked; strings (including interpolated holes) are blanked, so a type named only inside `$"{...}"` is missed. Run against `jbogard/MediatR` (83 files) and `FluentValidation/FluentValidation` (142 files): found and fixed unlinked extension-method classes and test/assembly-info files; both now map with no unlinked source files.

## Kotlin (`lib/engines/kotlinImports.ts`)

Like Java, a file has a `package` and imports by qualified name, but Kotlin also has **top-level functions and properties**, and those are imported by name too (`import com.acme.util.slugify`). The unit of a link is a declaration, and the edge goes to the file that declares it.

- **Declarations:** top-level class, interface, object, typealias (including `data`, `sealed`, `enum`, `fun interface`), function (including extension functions, named by the function), and `val`/`var`. Nested types and members are not mapped. `private` declarations are not exported.
- **Imports:** `import a.b.C`, `import a.b.slugify`, aliases (`as`) and wildcards. A wildcard links only to the files whose declarations the importer mentions. Java classes in the same repository are importable from Kotlin; Java files that use Kotlin classes are not followed.
- **Same package:** a mention of a declaration from the file's own package needs no import, so it is marked `samePackage` (ignored by cycle detection, kept for fan-in and blast radius); a link through an import is a real dependency.
- **Multiplatform:** the same name declared in several source sets (`expect` in `commonMain`, `actual` in `jvmMain`, `jsMain`...) links to the common declaration only, not every platform file.
- **Skipped:** `src/test*`, `src/androidTest*`, `src/*Test/` source sets and `*Test.kt` / `*Tests.kt` / `*IT.kt` (case-sensitive, so `Contest.kt` stays); `.kts` scripts are not source.
- **Entry points:** `main.kt`, `*Application.kt`, `*Main.kt`, `*App.kt`, `*Controller.kt`, `*Activity.kt`.
- **Limits:** lexical, no compiler or Gradle model. A name used only through string templates or reflection is missed; a function named like a common method can be over-linked when it is called with a dot (extension functions cannot be told from members). Run against `square/okhttp` (393 files) and `InsertKoinIO/koin` (338 files): found and fixed Kotlin Multiplatform `actual` declarations being linked as if each were a separate dependency (Koin: 1,699 → 1,472 edges, the removed ones were platform duplicates). Remaining orphans are the independent sample programs in okhttp and unused annotations in Koin.

## Ruby (`lib/engines/rubyImports.ts`)

Ruby has no import for names: `require` loads a file, and Rails and Zeitwerk load `Foo::Bar` from `foo/bar.rb` on first use with no `require` at all. So a file depends on another when it loads it **or** mentions a constant the other declares.

- **Loading:** `require_relative`, `require`/`require_dependency` and `autoload :Const, "path"` with a literal path. `require "a/b"` is resolved the way Ruby does, against a gem's `lib/` (or Rails' `app/*/`), so `require "pathname"` never lands on a `core_ext/pathname.rb`. Gems and stdlib that are not in the repository match nothing.
- **Constants:** `class`, `module` and `X = Struct.new / Class.new / Data.define`, qualified from indentation (`module A` / `  class B` is `A::B`) and from compact names (`class A::B`). A mention of `Foo` or `A::B` in code links to the file declaring it, with the qualified constant as the symbol. Lookup follows Ruby's rule: the enclosing modules of the file, then the top level, so `Request` inside `Rack::Protection` is never `Sinatra::Request`.
- **Who owns a name:** `module Acme` is reopened by every file under `lib/acme/`. The owner is the file at the conventional path (`Acme::HttpClient` is `acme/http_client.rb`); a name reopened in several files with no owner links to nothing. Core classes (`String`, `Float`, `Pathname`...) are never owned, because `class Float` in a file is a monkey-patch.
- **Same package:** a link to a sibling in the file's own module needs no `require`, and a file that reopens or requires its own parent namespace is not depending on a peer, so both are marked `samePackage` (ignored by cycle detection, kept for fan-in and blast radius). A link through an explicit `require` to anything else is a real dependency.
- **Skipped:** `spec/` and `features/`, `*_spec.rb`, `*_test.rb` and `test/` (already ignored for every language).
- **Entry points and kinds:** `*_controller.rb`, `config/application.rb`, `config/routes.rb`, `config/environment.rb` and anything under `bin/`; `*_controller.rb` is API and `models/`, `db/`, `migrations/` are data.
- **Limits:** lexical, no interpreter. Strings are blanked, so a constant named only inside `"#{Foo.bar}"` is missed; `const_get`, `send`, `Object.const_get("Foo")`, `require` with a computed path and `Dir[...]` loaders are not followed; a constant used only through inheritance (`class A < B` using `B`'s nested constants) resolves only if the lexical rule finds it. A name declared in more than three owning files is treated as too ambiguous to link. Run against `sinatra/sinatra` (56 files, four gems in one repository), `rack/rack` (51 files) and `rails/rails` (1,582 files, mapped in about 5 s). Mapping them found and fixed: namespaces reopened by every file linking to all of them, core-class monkey-patches owning `Float`/`Pathname`, `require "pathname"` resolving to a deeper `core_ext/pathname.rb`, constants resolving outside Ruby's lookup rule (`Sinatra::Request` from rack-protection), a word list in `%w(...)` at the start of a line being read as constants, and a quadratic scan that made 1,582 files take 50 s. Rack and Sinatra now map with no false cycles; the cycles left in Rails are real (`active_support` autoloads children that require it back).

## Rust (`lib/engines/rustImports.ts`)

Files form a module tree under each crate's `src/` (`a.rs` and `a/mod.rs` are module `a`; `lib.rs`/`main.rs` are the root). A `use` path names a module or an item, so the edge goes to the file of the longest module prefix, with the item after it as the symbol.

- **Paths:** `crate::`, `self::`, `super::` (one or more), a child module in scope, and **workspace crates by name** (the name is the crate directory's, with `-` as `_`, since `Cargo.toml` is not analysed). Nested groups (`use a::{b, c::D as E, self}`), `pub use`, `pub(crate) use` and globs are expanded. A module imported by name (`use crate::net::server;`) gets the items used through it (`server::run` → `run`). `std`, `core` and external crates never match.
- **`super::`:** a child using its parent's items is routine, so an edge that climbs to an ancestor is marked `samePackage` (ignored by cycle detection, counted for fan-in and blast radius).
- **Scope:** `self::`/`super::` inside an inline `mod x { }` or a function body is relative to that scope, not the file, so those uses are skipped (this is what makes `#[cfg(test)] mod tests { use super::*; }` harmless). `crate::` paths are followed at any depth.
- **Exports:** top-level `pub` (including `pub(crate)`) fn, struct, enum, trait, type, const, static, mod, union, and `#[macro_export]` macros. `mod.rs` files are labelled by their folder.
- **Entry points:** `main.rs`, `lib.rs` and `src/bin/*`.
- **Layouts:** besides the conventional `src/`, a crate whose `main.rs` or `lib.rs` sits elsewhere (ripgrep keeps its binary in `crates/core/`) is mapped from that directory. `build.rs` is an entry point.
- **Module paths in code:** a child declared with `mod x;` and used as `x::item`, and a fully written-out `crate::a::b()`, link even with no `use` line.
- **Parent/child:** any import of an ancestor module's items (via `super::` or `crate::`, including the crate root) is marked `samePackage`, so a parent that re-exports its child is not a cycle. Sibling cycles are still reported.
- **Test-only code:** files declared under `#[cfg(test)] mod x;` (and what they declare) are left out of the map.
- **Limits:** lexical. No macro expansion, `#[path]` attributes, `extern crate` renames, trait or method resolution, or `cfg`-dependent modules. Rust allows module cycles inside a crate, but they are still reported like any other cycle. Run against `sharkdp/fd` (22 files), `BurntSushi/ripgrep` (93 files, a workspace with a custom crate layout) and `dtolnay/anyhow` (13 files). Mapping ripgrep and anyhow found and fixed: files outside `src/` unlinked (unlinked files 27 → 8), false parent/child cycles, test-only modules mapped as product code, and module-qualified paths used without `use`. The links that remain unconnected are legitimate: public API with no internal user, `#[macro_use]` modules and examples.

## Java (`lib/engines/javaImports.ts`)

A Java file declares one or more top-level types, and an import names a type by its fully qualified name, so the edge goes to the file declaring that type.

- **Imports:** `import a.b.C;` → the file declaring `a.b.C` (symbol `C`). `import static a.b.C.m;` → that file (symbol `m`). A nested type (`a.b.Outer.Inner`) resolves to its outer type's file. `import a.b.*;` links the files of package `a.b` whose public type names the importer mentions. The JDK and external libraries never match a file in the set.
- **Same package:** classes in one package use each other with no import, so they are linked by name and marked `samePackage`. Cycle detection ignores these (bidirectional associations between entities are routine); fan-in, hubs, rules and blast radius keep them.
- **Types:** top-level `class`, `interface`, `enum`, `record` and `@interface` only (found by brace depth, ignoring comments and strings). Exports are the public ones.
- **Conventions:** `*Controller`, `*Resource`, `*Endpoint` are "API"; `*Repository`, `*Dao`, `*Entity` are "data"; `*Controller`, `*Configuration`, `*Config`, `*Application`, `*Main` and `*App` count as entry points (the framework wires them, not an import). `*Test`, `*Tests`, `*IT` (case-sensitive, so `Audit.java` stays), `src/test/`, `package-info.java` and `module-info.java` are skipped.
- **Limits:** lexical. Members used through an instance, annotation-driven wiring (injection by type with no import), reflection, Lombok-generated code and Kotlin are not followed; a type reached only by a fully qualified name in code (no import) is missed. Run against `spring-projects/spring-petclinic` (30 classes), `google/gson` (115 files, 423 internal imports) and `apache/commons-cli` (34 files, 15): every internal import resolved to a file. Generated site resources (`src/site/`) and minified bundles are not treated as source. Mature Java libraries score low on health because their cross-package class cycles are real (for example gson's `Gson` ↔ `GsonBuilder`).

## Go (`lib/engines/goImports.ts`)

Go imports whole packages (directories), but the map shows files. For each import the mapper links the importer to the **files that declare the exported names it uses**: `auth.VerifyToken` produces an edge to the file defining `VerifyToken`, with `symbols: ["VerifyToken"]`. That keeps Go file-level like the other languages and makes blast radius symbol-precise (see below).

- **Module path:** `go.mod` is not part of the analysed files, so it is inferred by vote (and, when the only internal import is the module root itself, from the repository name, optionally ending in `/vN`): an import that ends in the path of a package directory we have votes for the remaining prefix as the module path. Highest vote wins; a tie is broken by the repository name, otherwise nothing is linked. Standard-library and third-party imports never match.
- **Imports:** single, grouped `import ( … )`, aliased, `_` (side effect) and `.` (dot) forms. Side-effect and dot imports, and imports whose names cannot be placed in a file, link to the first 5 files of the package, with no symbols.
- **Exports:** capitalised top-level `func`, `type`, `var`, `const` (including grouped blocks). Methods and struct fields are not listed.
- **Same-package coupling:** files in one package use each other's top-level names (exported or not) without importing, so a file that uses a name another file declares gets an edge marked `samePackage`. Cycle detection ignores these edges (file-level loops inside a package are normal in Go; package-level cycles are impossible), while fan-in, rules and blast radius keep them. Over-approximates: a local variable named like a package-level function counts; names shorter than 3 characters, `init` and `main` are skipped; build-tagged variants that declare the same name all get linked.
- **Entry points:** `cmd/` and `main.go` are treated as entry points, so they are not reported as unconnected.
- **Limits:** lexical, no `go list`. A package whose name differs from its directory is handled through its `package` clause, but build tags, generated code, embedded interfaces and names reached only through methods are not followed. A repo whose only internal import has a third-party look-alike path can be mis-detected; one vote is accepted so small projects still link. Run against `gin-gonic/gin` (59 files, 8 packages), `go-chi/chi` (55 files: all 22 files that import internal packages are linked) and `spf13/cobra` (19 files: the `doc` package links to the root package, which needed the repository-name fallback). `testdata/` folders are ignored. Files of a library's public package that nothing inside the repository uses (chi's middleware) appear unconnected; that is expected for a library.

## Repo guide (`lib/engines/guide.ts`)

`buildGuide(graph)` answers "where do I start?" from graph facts alone (deterministic; no AI).

- **Entry points:** components with no incoming edge that use something and are not data files. A route that another component calls over HTTP is *not* an entry point; the flow starts at its caller.
- **Reading order:** from each entry point (most outgoing links first), follow dependencies depth-first, most-used first, so one flow is read top to bottom before the next. Anything unreachable (cycles with no entry, isolated parts) follows, most important first. Capped at 12 steps; `omitted` says how many are left out.
- **Roles:** *entry*, *core* (used by 3+), *leaf* (uses nothing), *support*. Each step's "why" is built from who uses it and what it uses, plus the first sentence of an authored description (heuristic placeholders are skipped).
- **Most used / read carefully:** top components by fan-in, and the highest change-risk ones from the health analysis.
- **Limits:** importance is structural (links), not semantic; a heavily used utility outranks a small but central business rule. `writes` edges count as flow but not as "use".

## Symbol-level coupling (`lib/engines/symbols.ts`)

For TypeScript/JavaScript, each import edge records *which names* the importer actually uses (`symbols`), not just that it imports the file.

- **How:** a lexical scan, not a type checker (TypeScript 7 is a native binary with no in-process compiler API, and a scanner runs identically in the browser, server and CLI). It blanks comments and string contents, parses `import`/`export … from` clauses (default, named, aliased, `type`, namespace, multi-line), then keeps only names that appear as identifiers in the rest of the file. `ns.member` accesses become `member`; passing `ns` itself, or `export *`, becomes `*`.
- **Unknown stays unknown:** dynamic `import()`, `require()` and side-effect imports leave `symbols` unset, and every consumer treats unset as "uses everything". It never narrows on a guess.
- **Blast radius:** if the prompt names an export of the origin exactly (`rename verifyToken`), only importers that use it are affected, and the summary says how many were spared. Authored scenarios are unchanged.
- **Inspector:** each export lists who uses it (and a per-export Simulate button). An export no mapped file uses is flagged; tests and scripts are not mapped, so check them before deleting.
- **Limits:** a name used only through a re-assigned alias, or hidden behind `export *` chains, can be missed or over-counted; type-only uses count as uses; Python and MATLAB edges carry no symbols.

## Provenance (`lib/engines/provenance.ts`)

Tests: `tests/provenance.test.ts`. A breadth-first traversal over data flow. Edges point at what a thing depends on (`reads`, `calls`, `imports`), except `writes`, which points from a **producer** to what it produces.

| Direction | Question | Rules |
|---|---|---|
| `upstream` | Where does this come from? | From a data node, go to the code that **writes** it. From code, go to what it reads and calls, but **not** to what it writes (an output is a product, not an input). A data node nothing writes is a **raw input**. Repeats across pipeline stages. |
| `downstream` | What does this affect? | From any node, go to the code that reads or calls it, then to everything that code **writes**. Repeats, so changing a raw input lists every result in every later stage that would be out of date. |

Sibling outputs of the producing script are not dragged into an upstream trace. Drafts are ignored and cycles terminate. Steps are ordered like a pipeline (deepest first for upstream; the source first for downstream; at equal depth: inputs, then code, then intermediate files, then the target). `describeTrace` turns a trace into plain sentences.

It also works on ordinary code graphs, where upstream is dependencies and downstream is dependents. In the app, a trace takes over the canvas (numbered steps, the rest dimmed) unless the Health tab is open; Esc clears it.

Note the difference from impact analysis: blast radius follows *code coupling* (who breaks if this changes), while a trace follows *data flow* (which results derive from this).

## Script data-flow mapper (`lib/engines/scripts.ts`)

Tests: `tests/scripts.test.ts`. Maps MATLAB (`.m`) and Python (`.py`) analysis code. Runs inside the heuristic mapper whenever scripts are present. A user-facing walkthrough (what you see, how to try it on the MATLAB sample, stale outputs in pull requests, limits) is in [Research code](research-scripts.md); this section is the algorithm. Python module-to-module links come from the heuristic mapper's `import` handling; this mapper adds the data files and, for MATLAB, the function calls.

1. **Lexer.** One pass per file removes comments (`%`, `%{ … %}`, `...`, `#`), blanks string contents and collects string literals. MATLAB's `'` is a string only when not directly after an identifier, `)`, `]`, `}`, `.` or `'` (otherwise it is the transpose operator); `''` is an escaped quote. Python triple-quoted strings (docstrings) are skipped.
2. **Data files.** Every literal with a data extension (`csv tsv mat xlsx xls txt dat json h5 parquet pkl npy npz xml …`) or an output extension (`png jpg pdf svg eps fig …`) is a reference. It is a **write** when its line has a write call (`writetable`, `save`, `exportgraphics`, `to_csv`, `savefig`, …) or an `fopen`/`open` in write mode; images default to writes unless a read call is on the line; otherwise it is a **read**. A file both read and written counts as written. This works for names kept in cell arrays or struct fields, as real scripts do. Names built at run time (`_base.csv`, `%s.csv`, `*.csv`) are flagged as patterns.
3. **MATLAB calls.** A file's name is a callable. A call is a whole-word occurrence (not after `.`) of another file's name in comment-free, string-free code; a local function of the same name shadows it.
4. **Layers.** A script with no callers that calls something or touches data is an **entry script**; a file using at least two plotting calls is **plots & outputs**; the rest is **analysis code**; referenced files are **data files**. When more than half of the files are scripts, the graph renames the layers (`kindLabels`) and lays them out entry → analysis → plots → data.
5. **Data nodes.** Created from references only; contents are never read. At most 40 are shown; the rest are grouped into "+N more data files".
6. **Node details.** Description from the file's header comment, exports from `function` definitions, parameters from the first signature, and the called functions and files read as imports.

## Scaffold templates (`lib/engines/localScaffold.ts`)

Tests: `tests/localScaffold.test.ts`

| Kind | Suggested path | Primary export | Template |
|---|---|---|---|
| frontend | `src/components/<Pascal>.tsx` | default `<Pascal>` | Client component with pending/error state; calls the first connected API route |
| api | `src/app/api/<kebab>/route.ts` | `POST` | Parses JSON safely, delegates to the first connected logic/data dependency |
| logic | `src/server/services/<camel>.ts` | `<camel>Service` | `execute(input)` delegating downstream |
| data | `src/server/db/<kebab>.ts` | `<camel>Repo` | `pg` pool with a parameterised query |

**Wiring:** for each draft edge from an *existing* node to a new one, an import is added after the last import. A UI-into-UI connection also renders `<Component />` before the outermost closing tag, and a connection to an API route appends a typed `fetch` helper. Several edges from the same source are combined into one diff.
