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
  server/                  claude, analyzers, schemas, respond, github  (server-only)
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
```

## Testing

The tests cover the pure layers: the engines, diff, graph and reducer. UI behaviour was verified manually in a browser. Two bugs were found that way, both now fixed: the diff column overflow and the impact over-reporting.

Conventions:

- One suite per module, named `tests/<module>.test.ts`.
- Use the sample repositories as fixtures (`authMicroservice`, `ecommerceApi`) rather than building ad-hoc graphs.
- Every bug fix gets a regression test (see `localImpact.test.ts` → *review-only dependents*).

There are no automated UI or E2E tests yet; Playwright would be the natural next step.

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

### Add an analysis route

1. Put the algorithm in `lib/engines/` so it stays pure and testable.
2. Add a request schema to `lib/server/schemas.ts` and a Claude output schema.
3. Add a `…WithClaude` function to `lib/server/analyzers.ts` that validates model output against the graph.
4. Keep the route thin: `parseBody`, then `runWithFallback(claude, local)`.
5. Add a wrapper in `lib/apiClient.ts`, with `withOfflineFallback` if the local engine can run in the browser.

### Change the Claude model or effort

`CLAUDE_MODEL` lives in `lib/server/claude.ts`; effort is set per call in `lib/server/analyzers.ts`. Check the target model's thinking and fallback support before switching. This repo's self-graph includes a *"Make the Claude model configurable"* scenario that shows the change.

## Git conventions

[Conventional Commits](https://www.conventionalcommits.org/): `type(scope): summary`. The types used here are `feat`, `fix`, `docs`, `chore`, `test` and `refactor`. Keep commits atomic: a fix goes in its own commit with its regression test, separate from feature work. The commit history doubles as the self-graph's Story mode, so the subject's prefix selects the narrative in `scripts/build-self-graph.mjs`.

## Known limitations and next steps

- No persistence: state is lost on reload, so export to keep work. Next step: save to IndexedDB.
- Local heuristic diffs are review markers, not refactors.
- `impactPathEdgeIds` can highlight an edge between two impacted siblings even when it isn't on a path from the root.
- No E2E tests.
- Large graphs (> 200 nodes) are rejected by the schema; that would need virtualisation or grouping before raising.
