# API reference

All routes are Next.js route handlers under `app/api/`. Request and response bodies are JSON.

## Response envelope

```ts
type ApiSuccess<T> = { ok: true; data: T; warning?: string };
type ApiFailure     = { ok: false; error: string };
```

`warning` is set when an AI provider was configured but failed (or is misconfigured) and the local engine answered instead. It explains why, e.g. *"Could not reach Ollama — is it running? Showing the local engine's result instead."*

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
{ "engine": "ai",    "label": "qwen2.5-coder:14b · Ollama", "provider": "ollama", "model": "qwen2.5-coder:14b" }
{ "engine": "local", "label": null, "provider": null, "model": null }
{ "engine": "local", "label": null, "provider": null, "model": null, "error": "Ollama needs a model name: set AI_MODEL …" }
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
  engine: "ai" | "local";
  engineLabel?: string;         // which model answered, e.g. "gpt-x · OpenAI"
  scenarioId?: string;          // local engine: authored scenario that matched
}
```

**AI path:** `effort: "high"`. The response is checked against the graph as described in [architecture.md § Trust boundaries](architecture.md#trust-boundaries).
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

The AI path uses `effort: "medium"`, and returned phases are filtered to known hashes. The local path echoes each commit's own `phase` and `narrative`.

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
  engine: "ai" | "local";
  engineLabel?: string;
}
```

AI results are filtered so that `files` cover only draft nodes and `diffs` only existing nodes. Returns 422 if nothing is drafted.

---

## `POST /api/analyze-repo`

Maps a repository into an `ArchitectureGraph`.

`maxFiles` (optional, whole number 20–2,000, default 400) is how many files the **local engine** maps; the most relevant are kept. With an AI model configured, grouping uses at most 60 files regardless.

**Request**, one of:

```ts
{ kind: "github"; url: string; maxFiles?: number }   // https://github.com/owner/repo[/tree/<ref>]
{ kind: "files";  name: string; files: Array<{ path: string; content: string }>; maxFiles?: number }
```

For `github`, the server downloads `api.github.com/repos/{owner}/{repo}/zipball[/{ref}]`. The request has a 30 s timeout, archives over 50 MB are rejected, and `GITHUB_TOKEN` is used when set.

**Response `data`:** an `ArchitectureGraph` with an ID of the form `import-<name>-<timestamp>`, empty `commits` and `scenarios`, and `warnings` describing anything skipped.

| Engine | Granularity | Source budget |
|---|---|---|
| AI model (`effort: "medium"`) | 4–25 architectural components | Whole files up to the provider's `AI_MAX_INPUT_CHARS` budget (40k chars for local models, up to 600k for large-context hosted models); files that don't fit are listed in `warnings` |
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

## Model request shape

Every model call goes through one interface, `StructuredGenerator.generate({ schema, schemaName, system, prompt, effort })` (`lib/server/ai/`). Provider selection is `resolveProviderConfig(env)` in `lib/server/ai/config.ts`.

**Anthropic adapter** (`anthropic.ts`)
- `client.beta.messages.parse` with `betaZodOutputFormat(schema)` (native structured outputs), `max_tokens: 16000`, `output_config.effort`
- `fallbacks: "default"` with beta `server-side-fallback-2026-07-01`, so a policy decline is retried server-side
- `stop_reason` `refusal` / `max_tokens` → `ModelResponseError`

**OpenAI-compatible adapter** (`openaiCompatible.ts`), used for OpenAI, Gemini, Ollama, LM Studio, OpenRouter, Groq, DeepSeek and custom endpoints
- `chat.completions.create`. The JSON Schema (from `z.toJSONSchema`) is always embedded in the system prompt.
- `response_format` degrades per endpoint: `json_schema` → `json_object` → none, on 400/422. The accepted mode is remembered per process.
- Replies are parsed tolerantly (code fences and surrounding prose are stripped) and validated with the same Zod schema. On failure the validation error is sent back once for a repair; a second failure raises `ModelResponseError`.
- OpenAI itself gets `max_completion_tokens` + `reasoning_effort` (`xhigh`/`max` → `high`); other endpoints get `max_tokens`.
- `finish_reason` `length` / `content_filter` and refusals → `ModelResponseError`.

**Context budgets:** impact and scaffold prompts include every component's code. When that exceeds `AI_MAX_INPUT_CHARS`, each file is truncated evenly, and model-written edits to truncated files are discarded, since an "after" written from partial code would silently delete the unseen remainder.
