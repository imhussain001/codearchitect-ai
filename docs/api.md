# API reference

All routes are Next.js route handlers under `app/api/`. Request and response bodies are JSON.

## Response envelope

```ts
type ApiSuccess<T> = { ok: true; data: T; warning?: string };
type ApiFailure     = { ok: false; error: string };
```

`warning` is set when Claude was enabled but failed and the local engine answered instead. It explains why, e.g. *"Claude rate limit reached; retry shortly. Showing the local engine's result instead."*

| Status | Meaning |
|---|---|
| 200 | Success (possibly with `warning`) |
| 400 | Invalid JSON, schema violation, bad GitHub URL, download failure, or a missing precondition |
| 422 | The local engine could not produce a result (e.g. the prompt matches no component) |

Analysis routes set `maxDuration = 300` seconds.

---

## `GET /api/health`

Reports which engine the analysis routes will try first.

```json
{ "engine": "claude", "model": "claude-opus-5-5" }
{ "engine": "local",  "model": null }
```

---

## `POST /api/impact`

Blast-radius analysis for a proposed change.

**Request**

```ts
{
  graph: ArchitectureGraph;     // see graph-format.md
  prompt: string;               // 1–2000 chars, e.g. "Change userId to UUID v4"
  selectedNodeId: string | null // origin hint
}
```

**Response `data`: `ImpactAnalysisResult`**

```ts
{
  prompt: string;
  rootNodeId: string;           // where the change originates
  summary: string;
  riskScore: number;            // 0–100
  impacts: Array<{
    nodeId: string;
    severity: "modified" | "broken" | "impacted"; // origin | must change | review
    depth: number;              // hops from the origin along reverse dependencies
    reason: string;
  }>;
  diffs: Array<{ nodeId; filePath; before; after; rationale }>;
  engine: "claude" | "local";
  scenarioId?: string;          // local engine: authored scenario that matched
}
```

**Claude path:** `effort: "high"`. The response is checked against the graph as described in [architecture.md § Trust boundaries](architecture.md#trust-boundaries).
**Local path:** see [engines.md § Impact](engines.md#impact-analysis).

**Errors:** a 422 with *"Could not map "…" to a component"* when no node matches and none is selected.

---

## `POST /api/story`

Narrates the graph's commit history.

**Request** `{ graph: ArchitectureGraph }`. Returns 400 if `graph.commits` is empty.

**Response `data`: `StoryNarrative`**

```ts
{ overview: string; phases: Array<{ hash; phase; narrative }>; engine }
```

The Claude path uses `effort: "medium"`, and returned phases are filtered to known hashes. The local path echoes each commit's own `phase` and `narrative`.

---

## `POST /api/scaffold`

Generates code for draft components (`data.isDraft`) and wiring for draft edges (`edge.isDraft`).

**Request** `{ graph: ArchitectureGraph }`

**Response `data`: `ScaffoldResult`**

```ts
{
  files: Array<{ nodeId; path; content }>;       // one per draft node
  diffs: Array<{ nodeId; filePath; before; after; rationale }>; // edits to existing nodes
  summary: string;
  engine: "claude" | "local";
}
```

Claude results are filtered so that `files` cover only draft nodes and `diffs` only existing nodes. Returns 422 if nothing is drafted.

---

## `POST /api/analyze-repo`

Maps a repository into an `ArchitectureGraph`.

**Request**, one of:

```ts
{ kind: "github"; url: string }   // https://github.com/owner/repo[/tree/<ref>]
{ kind: "files";  name: string; files: Array<{ path: string; content: string }> }
```

For `github`, the server downloads `api.github.com/repos/{owner}/{repo}/zipball[/{ref}]`. The request has a 30 s timeout, archives over 50 MB are rejected, and `GITHUB_TOKEN` is used when set.

**Response `data`:** an `ArchitectureGraph` with an ID of the form `import-<name>-<timestamp>`, empty `commits` and `scenarios`, and `warnings` describing anything skipped.

| Engine | Granularity | Source budget |
|---|---|---|
| Claude (`effort: "medium"`) | 4–25 architectural components | Whole files up to 600,000 characters in total; files that don't fit are listed in `warnings` |
| Local heuristic | One node per file, top 60 by relevance | — |

**Errors:** 400 for bad URLs, private or missing repos (*"not found or not public"*), GitHub rate limits, or oversized archives. 422 when no supported source files are found.

---

## Limits

These are enforced by `lib/graphSchema.ts` and `lib/server/schemas.ts`.

| Item | Limit |
|---|---|
| Nodes / edges per graph | 200 / 1,000 |
| `code` per node | 60,000 chars |
| Prompt | 2,000 chars |
| Commits / scenarios | 500 / 50 |
| Uploaded files | 5,000 files, 400,000 chars each |
| ZIP archive | 50 MB (source files over 200 KB are skipped) |

## Claude request shape

Every Claude call goes through `generateStructured` in `lib/server/claude.ts`:

- `client.beta.messages.parse` with `betaZodOutputFormat(schema)` (structured outputs)
- model `claude-opus-5-5`, `max_tokens: 16000`, `output_config.effort` set per route
- `betas: ["server-side-fallback-2026-07-01"]` with `fallbacks: "default"`, so a policy decline is retried server-side on Anthropic's recommended fallback model
- `stop_reason` is checked before reading content: `refusal` and `max_tokens` raise `ClaudeResponseError`, which the route turns into a local-engine fallback with a warning
