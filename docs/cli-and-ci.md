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

Every command that maps code accepts **`--max-files N`** (default 500, from 20 to 2,000): how many files to map. If a folder has more, the most architecturally relevant files are kept. A bigger map is slower to open in the app; the CLI itself handles 2,000 files in well under a second.

`npm run cli` bundles `scripts/cli/main.ts` with esbuild into `dist/cli/codearchitect.mjs` (one file, no dependencies) and runs it. You can also run the bundle directly: `node dist/cli/codearchitect.mjs …`.

### `analyze [dir]`

Maps the folder (git-tracked and untracked-but-not-ignored files when it is a git repo), applies `.codearchitect.json`, and prints a Markdown report: grade, rule violations, health issues, riskiest components.

| Option | Meaning |
|---|---|
| `--rules <file>` | Use this rules file instead of `<dir>/.codearchitect.json` |
| `--format markdown\|json` | Output format (default markdown) |
| `--output <file>` | Write to a file instead of stdout |
| `--no-fail` | Exit 0 even when an error-level rule is broken |

### `history [dir] [--max-points N] [--refine N] [--format markdown|json] [--output file]`

Shows how the architecture drifted. It samples up to `--max-points` (default 30) evenly spaced commits on the first-parent history, always including the first and last, reads each commit's files through git (nothing is checked out), and records health score and grade, cycles, rule violations, components and dependencies.

- A commit is a **regression** if health drops by 3+ points, or it adds a cycle or a rule violation; the worst are listed first (a new cycle counts like 10 points, a new violation like 5). **Improvements** are the mirror image.
- The trend is *improving*/*declining* when the net change across the range is 3+ points, otherwise *steady*.
- The **current** rules (`.codearchitect.json`) are applied to every commit, so changes reflect code, not rule edits.
- Each point uses the same heuristic mapper as `analyze`, so absolute numbers are indicative; the direction and the biggest drops are the useful part. Sampling can still miss a regression that was introduced and fixed again between two samples: raise `--max-points` for finer resolution.
- **Pinpointing.** Sampling alone can only say that health dropped *between* two sampled commits, which blames whichever sampled commit comes next (often an innocent one). So for each regression whose two ends are not neighbouring commits, the tool **bisects**: it measures the commit in the middle, keeps the half that still contains the first commit worse than the earlier end, and repeats until the culprit and its parent are both measured, so the reported delta is exact. `--refine N` is the budget of extra measurements (default 12, spent on the biggest regressions first; `0` turns it off) and the report's footer says how many were used. Each probe re-analyses one more commit, so a regression costs about log2(gap) probes. It assumes a regression persists once introduced: if it was fixed and re-broken inside one gap, bisecting finds one of the transitions. The pinpointed commits are added to the series.
- `view --history` stores the series on the graph (`drift`) and the Story tab draws it, marking regressions in red.

### `share [dir] [--output file.html]`

Writes a single self-contained HTML page of the folder's architecture (default name `<folder>-architecture.html`). It has no external scripts, styles or fonts and makes no network requests, so it works offline, from an email attachment, or as a CI artifact. The page has a pan/zoom diagram, search (`/`), the reading-order guide, and a details panel per component (risk, used-by, uses, exports, source). Source is embedded, so share it only where sharing the code is fine; the first 200 lines of each file are kept.

In CI, upload it next to the PR comment:

```yaml
- run: npm run cli -- share . --output architecture.html
- uses: actions/upload-artifact@v4
  with: { name: architecture, path: architecture.html }
```

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
| `--fail-on-removed-exports` | Also fail when the change removes an export that a file the change does not touch still imports (off by default: the match is heuristic) |

The report lists what is new and what the change fixed, plus the **blast radius**: the components that contain changed files, everything that depends on them (directly and indirectly), the riskiest component touched, and deleted components that surviving ones still use. Changed files that belong to no component (docs, config) are noted, not counted.

**Changed exports.** For TypeScript, JavaScript, Python, Go, Java and Rust files, the report goes below "this file changed" to **which exports changed**, by comparing the file before and after line by line and attributing each changed line to the export whose declaration it sits under. For each changed file it says what was modified, added or removed, then splits the direct importers into the ones that **use a changed name** (and which) and the ones that **import the file but none of those names**. A removed export that an untouched file still imports is flagged with a warning (and fails the check with `--fail-on-removed-exports`). The JSON output has the same data under `blastRadius.changedSymbols`.

How cautious it is: a change that cannot be tied to one export (module-level code before the first export, for example) is reported as such and **no importer is narrowed**; import-only and blank-line edits are ignored; an importer whose usage could not be read (dynamic import, non-JS/TS-style import) counts as affected. It does not tell whether a changed export's *behaviour* matters to a caller, only who names it, and a helper function that sits after an export is attributed to that export.

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
