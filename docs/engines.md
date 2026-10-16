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
| Unconnected | No edges at all in a graph of more than one component | low |

**Change-risk per component** (0–100): 8 per direct dependent (cap 40) + 3 per dependency (cap 15) + 1 per 20 lines (cap 20) + 30 if in a cycle + 15 if it crosses layers. Bands: healthy < 35, watch 35–64, risky ≥ 65.

**Overall** = 100 − (12 × cycles + 8 × crossed layers + 5 × hubs + 4 × large files + 2 × unconnected), floored at 0. Grades: A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, else F.

The weights are named constants at the top of the file. They are heuristics for ranking where to look first, not calibrated probabilities.

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
| Select | Top 60 by relevance = kind weight (api/data 4, logic 3, frontend 2) − 0.1 × path depth + min(size / 20 KB, 1) |
| Edges | JS/TS `import … from`, `import()`, `require()` and `export … from`; Python `from x import` and `import x`. Resolves `./`, `../`, `@/` and `~/` (also under `src/`) and dotted Python modules |
| Node data | Exports by regex. Params from the first function signature. Code truncated to 120 lines with a "… N more lines" marker |

`lib/engines/zip.ts` extracts archives with JSZip. It strips a single wrapping folder (as in GitHub zipballs), skips `..` paths and files over 200 KB, and caps archives at 50 MB.

## Script data-flow mapper (`lib/engines/scripts.ts`)

Tests: `tests/scripts.test.ts`. Maps MATLAB (`.m`) and Python (`.py`) analysis code. Runs inside the heuristic mapper whenever scripts are present.

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
