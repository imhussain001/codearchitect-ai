# CodeArchitect AI

**An interactive map of a codebase's architecture.** Map a repository into a live dependency graph, simulate what a change would break before you make it, replay how the architecture evolved, and draw new components to generate the code that wires them in.

Built with Next.js 16 (App Router), React 19, React Flow 12 and Tailwind 4. Analysis can run on **any major AI model** — Claude, OpenAI, Gemini, or free local models through **Ollama** / LM Studio — and falls back to a **deterministic local engine**, so the app is fully usable offline and for free.

---

## Features

| | Feature | What it does |
|---|---|---|
| 🗺️ | **Dependency graph** | A React Flow canvas of components, colour-coded by layer (UI, API route, business logic, data). Animated edges show data flow; there's a minimap, zoom and pan. |
| 💥 | **Blast-radius simulator** | Describe a change (e.g. *"Change `userId` from integer to UUID v4"*). Affected nodes pulse red (breaks) or amber (needs review), and the drawer shows a risk score and a side-by-side diff for every file that must change. |
| ⏳ | **Time-machine story** | Replay commit history on the canvas: components appear as they were introduced, with a narrative for each phase. Paste any `git log --name-status` to build a timeline. |
| 🧩 | **Diagram-to-code builder** | Add components, drag connections between them, and generate the new files plus the edits that wire them into existing ones. |
| 📦 | **Import / export** | Import a repository from a ZIP or a GitHub URL. Export every component's code plus a manifest that restores the exact graph. |

Two sample repositories are built in (*E-Commerce API*, *Auth Microservice*). The app also ships a map of **its own codebase** in `public/samples/`; load it via **Custom Upload…** to explore how this project is put together.

## Quick start

Requires Node.js 20+.

```bash
npm install
npm run dev
```

Open http://localhost:3000. No configuration is needed.

**Try it:**

1. Pick **Auth Microservice** in the repository selector.
2. Open **Blast Radius**, click the sample prompt *"Change `userId` from integer to UUID v4"*, then **Run Impact Analysis**.
3. Click **Toggle Time-Machine Story** and press ▶ to watch the architecture build up commit by commit.
4. In **Builder**, add an *"Export PDF Button"*, drag from **User Dashboard**'s bottom handle to its top handle, then click **Generate glue code**.

## Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm run build` / `npm start` | Production build (includes a type check) / serve it |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests (Vitest) |
| `npm run graph:self` | Regenerate `public/samples/codearchitect-self.graph.json` from the current code and git history |

## Configuration

All configuration is optional. Copy `.env.example` to `.env.local`. Without any of it, the local engine does everything.

### Choosing an AI model

| Provider | `AI_PROVIDER` | Key variable | Notes |
|---|---|---|---|
| **Ollama** (local, free) | `ollama` | — | Install [Ollama](https://ollama.com), `ollama pull qwen2.5-coder:14b`, set `AI_MODEL` |
| **LM Studio** (local, free) | `lmstudio` | — | Start its local server; set `AI_MODEL` to the loaded model |
| Anthropic Claude | `anthropic` | `ANTHROPIC_API_KEY` | Default model `claude-opus-5-5`; uses native structured outputs |
| OpenAI | `openai` | `OPENAI_API_KEY` | Set `AI_MODEL` |
| Google Gemini | `gemini` | `GEMINI_API_KEY` | Via Gemini's OpenAI-compatible endpoint; set `AI_MODEL` |
| OpenRouter / Groq / DeepSeek | `openrouter` / `groq` / `deepseek` | `OPENROUTER_API_KEY` / `GROQ_API_KEY` / `DEEPSEEK_API_KEY` | Set `AI_MODEL` |
| Any OpenAI-compatible server | `custom` | `AI_API_KEY` (optional) | Set `AI_BASE_URL` and `AI_MODEL` (vLLM, llama.cpp server, LocalAI, Azure, …) |

Free local example (`.env.local`):

```bash
AI_PROVIDER=ollama
AI_MODEL=qwen2.5-coder:14b
```

If `AI_PROVIDER` is empty, the first provider whose key is set is used. Existing setups with only `ANTHROPIC_API_KEY` keep working unchanged.

| Variable | Default | Effect |
|---|---|---|
| `AI_PROVIDER`, `AI_MODEL` | auto / preset | Which provider and model to use |
| `AI_BASE_URL`, `AI_API_KEY` | preset | Override the endpoint or key for any provider |
| `AI_MAX_INPUT_CHARS` | preset | Source characters per request: 40k for local models, 200k–600k for hosted ones |
| `CODEARCHITECT_ENGINE` | `auto` | `local` never calls a model. (`claude` is a legacy alias that forces Anthropic) |
| `GITHUB_TOKEN` | — | Raises GitHub's rate limit for URL imports |

The top bar shows which engine is active. A misconfiguration, such as a missing model or key, is reported there rather than silently ignored.

> A claude.ai Pro/Max or ChatGPT Plus subscription does **not** include API access; hosted APIs are billed separately. Ollama and LM Studio cost nothing.

## How it works

```mermaid
flowchart LR
  UI["UI components<br/>canvas · inspector · builder"] --> Store["Workspace reducer"]
  Store --> VM["View-model<br/>(derives status & glow)"] --> UI
  UI --> Client["API client"]
  Client -- HTTP --> Routes["/api/* routes<br/>zod validation"]
  Routes -->|model configured| AI["AI analyzers<br/>Anthropic · OpenAI-compatible"]
  Routes -->|none / failure| Engines["Local engines<br/>(pure TypeScript)"]
  Client -. server unreachable .-> Engines
```

- **Status is derived, not stored.** Nodes hold facts about the code; the impact, story and draft overlays are computed every render, so modes can't leave stale state behind.
- **Edges point from dependent to dependency**, so a blast radius is a reverse BFS from the changed node, O(V+E).
- **AI is optional, provider-neutral and checked.** Every model's output is validated with the same Zod schemas (with one automatic repair retry for malformed JSON) and then against the graph: unknown node IDs are dropped, depths are recomputed, and "before" code always comes from the graph itself. Any model failure falls back to the local engine with a visible warning.

## Documentation

| Doc | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Layers, data flow, state model, key design decisions |
| [API reference](docs/api.md) | Every route: request, response, errors, limits |
| [Analysis engines](docs/engines.md) | Algorithms: impact ranking and severity, risk score, diff, repo mapping, git parsing, scaffolding |
| [Graph format](docs/graph-format.md) | The `codearchitect/v1` JSON manifest, for building your own graphs |
| [Development guide](docs/development.md) | Project layout, testing, adding samples and scenarios, Next.js 16 notes |

## Project status and limits

- The local engine's impact diffs are exact only for **authored scenarios**. For other prompts it marks the affected lines heuristically, and an AI model is needed for concrete code edits.
- Repository mapping by the local engine is file-level: one node per file, at most 60 files. An AI model groups files into architectural components instead.
- Applied refactors and scaffolds change the in-memory model only. Use **Export Code Base** to get the files; nothing is written to your repository.
- Graph state is not persisted between page reloads. Export the graph to keep it.
