# Development guide

## Toolchain

| Tool | Version | Note |
|---|---|---|
| Node.js | 20+ (developed on 24) | |
| Next.js | 16 (App Router, Turbopack) | APIs differ from Next 13–15; read `node_modules/next/dist/docs/` before relying on memory (see `AGENTS.md`) |
| React | 19 | |
| TypeScript | 7 | `strict` plus `noUncheckedIndexedAccess` |
| Tailwind CSS | 4 | Configured in CSS (`@import "tailwindcss"` and `@theme` in `app/globals.css`); there is no `tailwind.config.js` |
| React Flow | `@xyflow/react` 12 | Controlled mode |
| Zod | 4 | Imported as `zod/v4` to match the Anthropic SDK helpers |
| Vitest | 5 | Node environment |
| lucide-react | 1.x | Brand icons (e.g. GitHub) were removed in 1.0 |

## Layout

```
app/
  page.tsx                 composition root (client component)
  layout.tsx, globals.css  shell, theme, React Flow skin, glow keyframes
  api/{health,impact,story,scaffold,analyze-repo}/route.ts
components/
  ArchitectureCanvas.tsx   React Flow canvas
  CustomNode.tsx           node card + NodeActionsContext
  InspectorPanel.tsx       tab router
  inspector/               NodeInspector, BlastRadiusPanel, StoryPanel, BuilderPanel, DiffViewer, CodeBlock
  TopNav.tsx, ImportDialog.tsx
hooks/useWorkspace.ts      reducer + actions
lib/
  types.ts                 domain model
  graph.ts, diff.ts        algorithms
  graphSchema.ts           shared zod schema
  viewModel.ts             render overlay
  apiClient.ts, portability.ts, ui.ts
  engines/                 localImpact, story, heuristicGraph, localScaffold, zip
  server/                  analyzers, schemas, respond, github  (server-only)
  server/ai/               provider config, Anthropic + OpenAI-compatible adapters, JSON repair
  mock/, mockData.ts       sample repositories
scripts/build-self-graph.mjs
public/samples/            generated self-graph
tests/                     Vitest suites
docs/
```

## Everyday commands

```bash
npm run dev          # http://localhost:3000
npm test             # unit tests
npm run typecheck
npm run build        # production build; also type-checks
npm run graph:self   # regenerate the self-graph (after code or history changes)
npm run models       # list model IDs your configured providers serve
npm run test:live    # score real models (opt-in; calls provider APIs)
npm run build:cli    # bundle the CLI to dist/cli/codearchitect.mjs
npm run cli -- analyze .            # health + rules of this repo
npm run cli -- pr --base main       # architecture check of this branch vs main
```

`npm test` exits non-zero if any test *file* fails to load, not only if a test fails: check the exit code (or the "Test Files" line), not just "Tests … passed". The opt-in live suite is excluded from it.

## Testing

The tests cover the pure layers: the engines, diff, graph and reducer. UI behaviour was verified manually in a browser. Two bugs were found that way, both now fixed: the diff column overflow and the impact over-reporting.

Conventions:

- One suite per module, named `tests/<module>.test.ts`.
- Use the sample repositories as fixtures (`authMicroservice`, `ecommerceApi`) rather than building ad-hoc graphs.
- Every bug fix gets a regression test (see `localImpact.test.ts` → *review-only dependents*).

There are no automated UI or E2E tests yet; Playwright would be the natural next step.

### Live model tests

`tests/live/providers.live.test.ts` runs all four AI features against real models and checks the answers against the graph, not just that JSON came back:

| Case | Passes when |
|---|---|
| impact · UUID migration | the root is `users-db`, `auth-controller` is broken, and code edits are proposed |
| impact · integer cents | the root is `orders-db` and the payment adapter's ×100 coupling is found |
| story | one phase per commit, with the real hashes |
| scaffold | one new file, plus whether the dashboard was wired |
| ingest | a real slice of this repo maps to ≥ 4 components with edges |

```bash
npm run models                                              # pick real model IDs
LIVE_TARGETS="gemini:<model>,groq:<model>" npm run test:live
```

Keys come from the environment or `.env.local`. Calls run one at a time with a pause between them (`LIVE_PAUSE_MS`, default 8000) so free-tier rate limits aren't what gets measured. A scorecard is written to `tests/live/.results/scorecard.md` (gitignored). The suite is skipped entirely when `LIVE_TARGETS` is empty, and it never runs as part of `npm test`.

## Common tasks

### Add a sample repository

1. Create `lib/mock/<name>.ts` exporting an `ArchitectureGraph`. Use `makeNode(id, position, data)`, and give nodes meaningful `keywords`.
2. Register it in `SAMPLE_REPOSITORIES` and add prompts to `SAMPLE_PROMPTS` in `lib/mockData.ts`.
3. Optionally author `scenarios` with full-file `after` code for the prompts you list.

### Add an impact scenario

Add an entry to the graph's `scenarios` (see [graph-format.md](graph-format.md#impact-scenario)):

- `triggers` should match the sample prompt and its natural paraphrases.
- Include a `diffs` entry for **every** file that must change. Those are reported as *broken*, and everything else reachable as *review only*.
- Use `extraImpacts` for couplings that the import graph cannot see.
- Add a test asserting the severities.

### Add a rule type

Add the variant to `ArchRule` in `lib/types.ts` and to `RuleSchema` in `lib/rulesSchema.ts`, implement it in `evaluateRules` (`lib/engines/rules.ts`, pushing a `RuleViolation` that carries `ruleType`), then test it in `tests/rules.test.ts` and document it in [cli-and-ci.md](cli-and-ci.md#rules).

### Change what the CLI or PR check does

The logic is pure and lives in `lib/report.ts` (comparison, pass/fail, Markdown); `scripts/cli/main.ts` only reads git and files and parses flags. Rebuild with `npm run build:cli`. To try a check on your own branch: `npm run cli -- pr --base main`.

### Add a tour step

Add an entry to `TOUR_STEPS` in `lib/tour.ts` and tag the element to spotlight with `data-tour="<target>"`. `tests/tour.test.ts` fails if a step targets an element that no longer exists. Set `tab` when the target lives in a particular drawer tab.

### Add an architecture-health rule

Add the check inside `analyzeHealth` in `lib/engines/health.ts`, push a `HealthIssue` with a plain-language `detail`, include it in the `counts` and the overall penalty, and extend `tests/health.test.ts`. Keep weights as named constants.

### Add a script language

Extend `scriptLangOf` and the lexer in `lib/engines/scripts.ts` (comment and string rules), then its write-call pattern and, if the language has a callable-by-file-name convention like MATLAB, the call detection. Add the extension to `SOURCE_EXTENSIONS` in `heuristicGraph.ts`.

### Add an analysis route

1. Put the algorithm in `lib/engines/` so it stays pure and testable.
2. Add a request schema to `lib/server/schemas.ts` and a model output schema (keep it simple — small local models must be able to fill it).
3. Add a `…WithAi` function to `lib/server/analyzers.ts` that calls `getGenerator().generate(...)` and validates the output against the graph.
4. Keep the route thin: `parseBody`, then `runWithFallback(ai, local)`.
5. Add a wrapper in `lib/apiClient.ts`, with `withOfflineFallback` if the local engine can run in the browser.

### Switch or add an AI provider

Switching is configuration only: set `AI_PROVIDER` / `AI_MODEL` (see the README). Effort is set per call in `lib/server/analyzers.ts`.

To add a provider that speaks the OpenAI protocol, add a preset to `PROVIDER_PRESETS` in `lib/server/ai/config.ts` (base URL, key variable, context budget) and a case to `tests/aiConfig.test.ts`. A provider with a different protocol needs a new `StructuredGenerator` adapter next to `anthropic.ts`. This repo's self-graph includes an *"Add a Mistral provider preset"* scenario showing the change.

To try local models: install Ollama, `ollama pull qwen2.5-coder:14b`, then put `AI_PROVIDER=ollama` and `AI_MODEL=qwen2.5-coder:14b` in `.env.local`. Models under ~7B parameters often fail the structured output even with the repair retry; the app then falls back to the local engine and says why.

## Git conventions

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`. The types used here are `feat`, `fix`, `docs`, `chore`, `test` and `refactor`. Keep commits atomic: a fix goes in its own commit with its regression test, separate from feature work. The commit history doubles as the self-graph's Story mode, so the subject's prefix selects the narrative in `scripts/build-self-graph.mjs`.

## Known limitations and next steps

- No persistence: state is lost on reload, so export to keep work. Next step: save to IndexedDB.
- Local heuristic diffs are review markers, not refactors.
- `impactPathEdgeIds` can highlight an edge between two impacted siblings even when it isn't on a path from the root.
- No E2E tests.
- Large graphs (> 200 nodes) are rejected by the schema; that would need virtualisation or grouping before raising.
