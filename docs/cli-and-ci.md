# Architecture rules, the command line and the PR check

Three connected pieces:

1. **Rules** state what an architecture must never do. They are checked live in the app (Health tab) and in CI.
2. **The CLI** (`codearchitect`) analyses a folder or compares two git commits.
3. **The GitHub workflow** runs the CLI on every pull request and comments the result.

No AI or API key is involved in any of this.

## Rules

A rule file is a JSON array, or an object with a `rules` array. In a repository it lives at `.codearchitect.json`; in the app it is edited in **Health → Rules** and stored on the graph (so it is exported with it).

```json
{
  "rules": [
    { "id": "ui-not-data", "type": "forbid", "from": "kind:frontend", "to": "kind:data",
      "message": "UI must go through the API or logic layer" },
    { "id": "no-cycles", "type": "no-cycles" },
    { "id": "small-hubs", "type": "max-dependents", "limit": 6, "severity": "warn" },
    { "id": "small-files", "type": "max-lines", "limit": 500, "selector": "path:src/**" }
  ]
}
```

| Type | Meaning | Fields |
|---|---|---|
| `forbid` | No dependency from a component matching `from` to one matching `to` | `from`, `to` |
| `no-cycles` | No circular dependencies | none |
| `max-dependents` | A component may have at most `limit` direct dependents | `limit`, optional `selector` |
| `max-lines` | A file may have at most `limit` lines | `limit`, optional `selector` |

Every rule has a unique `id` (letters, digits, `. _ -`), an optional `message`, and an optional `severity`: `"error"` (default) fails the PR check, `"warn"` only reports.

### Selectors

A selector is one or more alternatives joined with `|`.

| Form | Matches |
|---|---|
| `kind:frontend` | A layer: `frontend`, `api`, `logic` or `data` |
| `path:src/ui/**` | A file path glob (`**` any depth, `*` within a folder, `?` one character) |
| `label:Users*` | A component name glob |
| `id:users-db` | An exact component id |
| `*` | Everything |
| `Users Database` | A bare word matches a label or a path |

Example: `"from": "path:components/**|path:hooks/**"` means "anything in `components/` or `hooks/`".

### How rules relate to health

Rules and the Health tab use the same graph, but they treat `import type` differently on purpose:

- **Health** ignores type-only imports (they are erased at runtime, so they are not real coupling): no hubs, cycles or crossed layers from them.
- **Rules and blast radius** count them. A rule like "browser code must not import `lib/server`" should catch `import type` too, and changing a type does break its users at compile time.

A `no-cycles` violation describes the same loop as the health check's cycle, so the PR report counts it once.

## Command line

```bash
npm run cli -- analyze .                       # health + rules of a folder
npm run cli -- pr --base main                  # what this branch does to the architecture
```

`npm run cli` bundles `scripts/cli/main.ts` with esbuild into `dist/cli/codearchitect.mjs` (one file, no dependencies) and runs it. You can also run the bundle directly: `node dist/cli/codearchitect.mjs …`.

### `analyze [dir]`

Maps the folder (git-tracked and untracked-but-not-ignored files when it is a git repo), applies `.codearchitect.json`, and prints a Markdown report: grade, rule violations, health issues, riskiest components.

| Option | Meaning |
|---|---|
| `--rules <file>` | Use this rules file instead of `<dir>/.codearchitect.json` |
| `--format markdown\|json` | Output format (default markdown) |
| `--output <file>` | Write to a file instead of stdout |
| `--no-fail` | Exit 0 even when an error-level rule is broken |

### `view [dir] [--port N] [--no-open]`

Maps a folder (the current one by default) and opens it in the app, with no zip or GitHub step. Files come from `git ls-files` in a repository (so `.gitignore` is respected) or a directory walk otherwise, and `.codearchitect.json` in that folder supplies the rules.

From a clone of this project: `npm run view -- <folder>`. It writes the graph to a temporary file, starts the app with `CODEARCHITECT_PRELOAD_FILE` pointing at it, and opens the browser once the server answers. The app loads it once per launch: reloading the tab keeps your edits, relaunching re-reads the folder. The temporary file is removed when you press Ctrl+C.

Limits: it runs the development server, so the first page load compiles for a few seconds; the app can show one folder at a time (Next.js refuses a second dev server in the same project); and the folder is read locally, nothing is uploaded.

### `pr --base <ref> [--head <ref>]`

Reads the **base** and **head** commits straight from git (no checkout), maps both, and compares them.

| Option | Meaning |
|---|---|
| `--base <ref>` | Required. The branch or commit to compare against, e.g. `origin/main` |
| `--head <ref>` | Default `HEAD` |
| `--dir <path>` | The repository (default: the current folder) |
| `--rules <file>` | Override the rules (default: `.codearchitect.json` **at the head commit**, so a PR can change the rules and is judged by its own) |
| `--format`, `--output` | As above |
| `--max-health-drop N` | Also fail when the health score drops by more than N points |
| `--no-fail-on-cycles` | Do not fail on a new circular dependency |
| `--no-fail-on-violations` | Do not fail on new error-level rule violations |

The report lists what is new and what the change fixed, plus the **blast radius**: the components that contain changed files, everything that depends on them (directly and indirectly), the riskiest component touched, and deleted components that surviving ones still use. Changed files that belong to no component (docs, config) are noted, not counted.

For script projects (MATLAB, Python), the report also lists **output files that may be out of date**: every data file downstream of a changed script or input, found by the same data-flow tracing as the Trace section, so a PR that changes `nrmse_percent.m` says which CSVs and figures to regenerate. It is advisory and never fails the check.

**Exit codes:** `0` passed, `1` the check failed, `2` usage or environment error (bad flag, not a git repo, unreadable rules file).

**What fails by default:** a new circular dependency, or a new `error`-severity rule violation. Problems that already existed on the base branch never fail a PR.

## GitHub workflow

`.github/workflows/architecture-check.yml` runs on every pull request to `main`:

1. Checks out the full history and runs `npm ci`.
2. Runs `codearchitect pr --base origin/<base branch> --head HEAD`.
3. Writes the report to the job summary.
4. Creates one pull-request comment, then updates that same comment on every later push (found by a hidden marker, so other bots' comments are never touched).
5. Fails the check if the CLI failed.

To use it in another repository, copy the workflow and add the CLI: commit `scripts/cli/`, `scripts/build-cli.mjs`, the `lib/` modules it imports, the `esbuild` dev dependency and the two `package.json` scripts. A packaged action or npm package would remove that copying and is a natural next step.

Notes:

- **Fork pull requests** get a read-only token, so the comment is skipped; the check and the job summary still work.
- The comment needs `pull-requests: write`, set in the workflow's `permissions`.
- The mapper is heuristic and file-level (imports between source files). It tells you *where to look*; it cannot judge whether a change is correct.

## Limits

- Large repositories are capped at the 500 most architecturally relevant source files; a note says so.
- Dynamic imports with computed paths, and dependencies injected at runtime, are invisible to the scan.
- Both sides of a comparison are mapped with the same rules, so differences are real changes, but a renamed file shows as one removed and one added component.
