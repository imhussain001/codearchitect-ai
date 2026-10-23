/**
 * CodeArchitect command line: architecture health, rules and pull-request blast radius.
 *
 *   codearchitect analyze [dir]                       health + rules of the working tree
 *   codearchitect pr --base <ref> [--head <ref>]      what a change does to the architecture
 *   codearchitect view [dir] [--port N] [--no-open] [--history]   map a folder and open it in the app
 *   codearchitect history [dir] [--max-points N] [--refine N]     how health, cycles and rule violations changed over time
 *   codearchitect share [dir] [--output file.html]    one self-contained, explorable page of the architecture
 *
 * Files are read through git, so any two commits can be compared without checking them out.
 * Exit codes: 0 passed, 1 check failed, 2 usage or environment error.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildHeuristicGraph, isAnalyzableSource, MAX_MAPPABLE_FILES, MIN_MAPPED_FILES } from "../../lib/engines/heuristicGraph";
import { analyzeChangedSymbols } from "../../lib/engines/changedSymbols";
import { comparisonToJson, compareSnapshots, evaluateCheck, renderAnalysis, renderMarkdown, takeSnapshot, type CheckOptions } from "../../lib/report";
import { analyzeDrift, measure, refineDrift, renderDriftMarkdown, sampleIndices, type DriftPoint, type IndexedPoint } from "../../lib/engines/drift";
import { PRELOAD_ENV } from "../../lib/preload";
import { renderShareHtml } from "../../lib/share";
import { parseRulesJson } from "../../lib/rulesSchema";
import type { ArchRule, SourceFile } from "../../lib/types";

const CONFIG_FILE = ".codearchitect.json";
const MAX_SOURCE_FILE_BYTES = 200 * 1024;
const DEFAULT_MAPPED_FILES = 500;
const MAX_GIT_BUFFER_BYTES = 1 << 30;
const SKIPPED_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "coverage", "venv", ".venv", "__pycache__", "target", "vendor"]);

class UsageError extends Error {}

/* ---------- Arguments ---------- */

type Args = { command: string; positional: string[]; flags: Map<string, string | true> };

const BOOLEAN_FLAGS = new Set(["help", "no-open", "history", "no-fail", "no-fail-on-cycles", "no-fail-on-violations", "fail-on-removed-exports"]);

function parseArgs(argv: string[]): Args {
  const [command = "help", ...rest] = argv[0] === "--help" || argv[0] === "-h" ? ["help", ...argv.slice(1)] : argv;
  const flags = new Map<string, string | true>();
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!name) throw new UsageError(`Unexpected argument "${arg}".`);
    if (inline !== undefined) flags.set(name, inline);
    else if (BOOLEAN_FLAGS.has(name)) flags.set(name, true);
    else {
      const value = rest[++i];
      if (value === undefined || value.startsWith("--")) throw new UsageError(`--${name} needs a value.`);
      flags.set(name, value);
    }
  }
  return { command, positional, flags };
}

function flag(args: Args, name: string): string | undefined {
  const value = args.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

/* ---------- Reading source ---------- */

function git(cwd: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync("git", args, { cwd, input, maxBuffer: MAX_GIT_BUFFER_BYTES, stdio: ["pipe", "pipe", "pipe"] });
  } catch (error) {
    const stderr = (error as { stderr?: Buffer }).stderr?.toString().trim();
    throw new UsageError(`git ${args.join(" ")} failed${stderr ? `: ${stderr}` : "."}`);
  }
}

function isGitRepo(dir: string): boolean {
  try {
    git(dir, ["rev-parse", "--is-inside-work-tree"]);
    return true;
  } catch {
    return false;
  }
}

/** Source files of a commit, read with one `git cat-file --batch` call. */
function sourceFilesAtRef(cwd: string, ref: string): SourceFile[] {
  const paths = git(cwd, ["ls-tree", "-r", "-z", "--name-only", ref]).toString("utf8").split("\0").filter(isAnalyzableSource);
  if (paths.length === 0) return [];
  const out = git(cwd, ["cat-file", "--batch"], paths.map((p) => `${ref}:${p}\n`).join(""));

  const files: SourceFile[] = [];
  let pos = 0;
  for (const path of paths) {
    const eol = out.indexOf(0x0a, pos);
    if (eol < 0) break;
    const header = out.subarray(pos, eol).toString("utf8");
    pos = eol + 1;
    const size = Number(header.split(" ")[2]);
    if (!Number.isFinite(size)) continue; // "<object> missing"
    const body = out.subarray(pos, pos + size);
    pos += size + 1;
    if (size <= MAX_SOURCE_FILE_BYTES) files.push({ path, content: body.toString("utf8") });
  }
  return files;
}

function walk(dir: string, prefix = ""): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return SKIPPED_DIRS.has(entry.name) ? [] : walk(join(dir, entry.name), `${prefix}${entry.name}/`);
    return [`${prefix}${entry.name}`];
  });
}

function sourceFilesInDir(dir: string): SourceFile[] {
  const paths = isGitRepo(dir)
    ? git(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString("utf8").split("\0")
    : walk(dir);
  return paths
    .filter(isAnalyzableSource)
    .filter((p) => existsSync(join(dir, p)) && statSync(join(dir, p)).size <= MAX_SOURCE_FILE_BYTES)
    .map((path) => ({ path, content: readFileSync(join(dir, path), "utf8") }));
}

function loadRules(text: string | null, origin: string): ArchRule[] {
  if (text === null) return [];
  const parsed = parseRulesJson(text);
  if (!parsed.ok) throw new UsageError(`${origin}: ${parsed.error}`);
  return parsed.rules;
}

function rulesFromFile(path: string): ArchRule[] {
  return existsSync(path) ? loadRules(readFileSync(path, "utf8"), path) : [];
}

function rulesAtRef(cwd: string, ref: string): ArchRule[] {
  try {
    return loadRules(git(cwd, ["show", `${ref}:${CONFIG_FILE}`]).toString("utf8"), `${CONFIG_FILE} at ${ref}`);
  } catch (error) {
    if (error instanceof UsageError && /does not exist|exists on disk, but not in/.test(error.message)) return [];
    if (error instanceof UsageError && error.message.startsWith("git ")) return [];
    throw error;
  }
}

/* ---------- Commands ---------- */

function checkOptions(args: Args): CheckOptions {
  const drop = flag(args, "max-health-drop");
  if (drop !== undefined && !Number.isFinite(Number(drop))) throw new UsageError("--max-health-drop must be a number.");
  return {
    failOnNewCycles: !args.flags.has("no-fail-on-cycles"),
    failOnNewViolations: !args.flags.has("no-fail-on-violations"),
    failOnRemovedExports: args.flags.has("fail-on-removed-exports"),
    maxHealthDrop: drop === undefined ? undefined : Number(drop),
  };
}

/** `--max-files N`: how many files to map (the most relevant are kept). */
function parseMaxFiles(args: Args): number {
  const raw = flag(args, "max-files");
  if (raw === undefined) return DEFAULT_MAPPED_FILES;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < MIN_MAPPED_FILES || n > MAX_MAPPABLE_FILES) throw new UsageError(`--max-files must be a whole number from ${MIN_MAPPED_FILES} to ${MAX_MAPPABLE_FILES}.`);
  return n;
}

function emit(args: Args, text: string): void {
  const output = flag(args, "output");
  if (output) writeFileSync(output, text);
  else process.stdout.write(text);
}

function runAnalyze(args: Args): number {
  const maxFiles = parseMaxFiles(args);
  const dir = resolve(args.positional[0] ?? ".");
  if (!existsSync(dir)) throw new UsageError(`Directory not found: ${dir}`);
  const files = sourceFilesInDir(dir);
  if (files.length === 0) throw new UsageError(`No supported source files found in ${dir}.`);

  const rulesPath = flag(args, "rules") ?? join(dir, CONFIG_FILE);
  const snapshot = takeSnapshot(buildHeuristicGraph(basename(dir), files, { maxFiles }), rulesFromFile(rulesPath));
  const errors = snapshot.violations.filter((v) => v.severity === "error");

  if (flag(args, "format") === "json") {
    emit(args, `${JSON.stringify({ health: { grade: snapshot.health.grade, score: snapshot.health.overall, counts: snapshot.health.counts }, issues: snapshot.health.issues.map(({ kind, severity, title, detail }) => ({ kind, severity, title, detail })), violations: snapshot.violations }, null, 2)}\n`);
  } else {
    emit(args, renderAnalysis(snapshot, basename(dir)));
  }
  return errors.length > 0 && !args.flags.has("no-fail") ? 1 : 0;
}

function runPr(args: Args): number {
  const maxFiles = parseMaxFiles(args);
  const base = flag(args, "base");
  if (!base) throw new UsageError("pr needs --base <ref>, e.g. --base origin/main");
  const head = flag(args, "head") ?? "HEAD";
  const cwd = resolve(flag(args, "dir") ?? args.positional[0] ?? ".");
  if (!isGitRepo(cwd)) throw new UsageError(`${cwd} is not inside a git repository.`);

  let changed: string[];
  try {
    changed = git(cwd, ["diff", "--name-only", "-z", `${base}...${head}`]).toString("utf8").split("\0").filter(Boolean);
  } catch {
    changed = git(cwd, ["diff", "--name-only", "-z", base, head]).toString("utf8").split("\0").filter(Boolean); // no merge base
  }

  const name = basename(cwd);
  const headFiles = sourceFilesAtRef(cwd, head);
  const baseFiles = sourceFilesAtRef(cwd, base);
  if (headFiles.length === 0) throw new UsageError(`No supported source files found at ${head}.`);

  // Rules come from the head commit, so a PR can change the rules and be judged by its own.
  const rules = flag(args, "rules") ? rulesFromFile(flag(args, "rules")!) : rulesAtRef(cwd, head);
  const options = { maxFiles };
  const headSnap = takeSnapshot(buildHeuristicGraph(name, headFiles, options), rules);
  const baseSnap = baseFiles.length ? takeSnapshot(buildHeuristicGraph(name, baseFiles, options), rules) : null;

  const comparison = compareSnapshots(baseSnap, headSnap, changed, analyzeChangedSymbols(baseFiles, headFiles, changed));
  const check = evaluateCheck(comparison, checkOptions(args));
  emit(args, flag(args, "format") === "json" ? `${JSON.stringify(comparisonToJson(comparison, check), null, 2)}\n` : renderMarkdown(comparison, check));
  if (!check.passed) process.stderr.write(`Architecture check failed: ${check.failures.join("; ")}\n`);
  return check.passed ? 0 : 1;
}

const DEFAULT_VIEW_PORT = 3000;
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 120_000;

/** Slug used for the graph id, so two folders never share a saved workspace. */
const slug = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "folder";

function openBrowser(url: string): void {
  const [command, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  spawn(command!, args as string[], { stdio: "ignore", detached: true }).on("error", () => process.stdout.write(`Open ${url} in your browser.
`)).unref();
}

async function waitUntilReady(url: string, isAlive: () => boolean): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && isAlive()) {
    try {
      if ((await fetch(`${url}/api/preload`)).status < 500) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return false;
}

const DEFAULT_HISTORY_POINTS = 30;
const FIELD_SEPARATOR = "\x1f";

/** First-parent history of `ref`, oldest first. */
function commitLog(cwd: string, ref: string): Array<Pick<DriftPoint, "hash" | "author" | "date" | "message">> {
  const out = git(cwd, ["log", "--first-parent", "--reverse", `--format=%H${FIELD_SEPARATOR}%an${FIELD_SEPARATOR}%aI${FIELD_SEPARATOR}%s`, ref]).toString("utf8");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", author = "", date = "", ...message] = line.split(FIELD_SEPARATOR);
      return { hash, author, date, message: message.join(FIELD_SEPARATOR) };
    });
}

const DEFAULT_REFINE_PROBES = 12;

/**
 * Measure health at up to `maxPoints` evenly spaced commits, then spend up to `refine` extra
 * measurements bisecting each regression to the commit that caused it. The current rules apply to
 * every commit, so changes reflect code, not rule edits.
 */
function collectDrift(cwd: string, name: string, rules: readonly ArchRule[], maxPoints: number, refine: number = DEFAULT_REFINE_PROBES, maxFiles: number = DEFAULT_MAPPED_FILES): { points: DriftPoint[]; extra: number } {
  const commits = commitLog(cwd, "HEAD");
  const cache = new Map<number, DriftPoint | null>();
  const measureAt = (index: number): DriftPoint | null => {
    const cached = cache.get(index);
    if (cached !== undefined) return cached;
    const commit = commits[index]!;
    const files = sourceFilesAtRef(cwd, commit.hash);
    // A commit before any supported source existed has nothing to measure.
    const point = files.length === 0 ? null : measure(commit, takeSnapshot(buildHeuristicGraph(name, files, { maxFiles }), rules));
    cache.set(index, point);
    return point;
  };

  const sampled = sampleIndices(commits.length, maxPoints);
  const initial: IndexedPoint[] = [];
  sampled.forEach((index, i) => {
    process.stderr.write(`\rMeasuring history ${i + 1}/${sampled.length}…`);
    const point = measureAt(index);
    if (point) initial.push({ index, point });
  });

  let probes = 0;
  const refined =
    refine > 0
      ? refineDrift(
          initial,
          (index) => {
            process.stderr.write(`\rPinpointing regressions (${++probes}/${refine})…`);
            return measureAt(index);
          },
          refine,
        )
      : { points: initial, extra: 0 };
  process.stderr.write("\r\x1b[K");
  return { points: refined.points.map((p) => p.point), extra: refined.extra };
}

function parseRefine(args: Args): number {
  const raw = flag(args, "refine");
  const n = raw === undefined ? DEFAULT_REFINE_PROBES : Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new UsageError("--refine must be a whole number, 0 or more (0 turns pinpointing off).");
  return n;
}

function parseMaxPoints(args: Args): number {
  const raw = flag(args, "max-points");
  const n = raw === undefined ? DEFAULT_HISTORY_POINTS : Number(raw);
  if (!Number.isInteger(n) || n < 2) throw new UsageError("--max-points must be a whole number of at least 2.");
  return n;
}

function runHistory(args: Args): number {
  const cwd = resolve(args.positional[0] ?? flag(args, "dir") ?? ".");
  if (!isGitRepo(cwd)) throw new UsageError(`${cwd} is not inside a git repository.`);
  const name = basename(cwd);
  const { points, extra } = collectDrift(cwd, name, rulesFromFile(join(cwd, CONFIG_FILE)), parseMaxPoints(args), parseRefine(args), parseMaxFiles(args));
  const report = analyzeDrift(points);
  emit(args, flag(args, "format") === "json" ? `${JSON.stringify({ ...report, extraCommitsMeasured: extra }, null, 2)}
` : renderDriftMarkdown(report, name, { extra }));
  return 0;
}

/** Write a single HTML file that anyone can open: diagram, search, reading order and per-component details. */
function runShare(args: Args): number {
  const maxFiles = parseMaxFiles(args);
  const dir = resolve(args.positional[0] ?? ".");
  if (!existsSync(dir)) throw new UsageError(`Directory not found: ${dir}`);
  const files = sourceFilesInDir(dir);
  if (files.length === 0) throw new UsageError(`No supported source files found in ${dir}.`);
  const graph = buildHeuristicGraph(basename(dir), files, { maxFiles });
  const rules = rulesFromFile(join(dir, CONFIG_FILE));
  const output = resolve(flag(args, "output") ?? `${slug(basename(dir))}-architecture.html`);
  writeFileSync(output, renderShareHtml({ ...graph, rules: rules.length ? rules : graph.rules }));
  process.stdout.write(`Wrote ${output} (${graph.nodes.length} components)
`);
  return 0;
}

/** Map a folder, then start the app with that graph preloaded and open the browser. */
async function runView(args: Args): Promise<number> {
  const maxFiles = parseMaxFiles(args);
  const dir = resolve(args.positional[0] ?? ".");
  if (!existsSync(dir)) throw new UsageError(`Directory not found: ${dir}`);
  const files = sourceFilesInDir(dir);
  if (files.length === 0) throw new UsageError(`No supported source files found in ${dir}.`);
  const port = Number(flag(args, "port") ?? DEFAULT_VIEW_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError("--port must be a port number.");

  const appRoot = fileURLToPath(new URL("../..", import.meta.url));
  const nextBin = join(appRoot, "node_modules", "next", "dist", "bin", "next");
  if (!existsSync(nextBin)) throw new UsageError(`The app is not installed. Run "npm install" in ${appRoot} first.`);

  const name = basename(dir);
  const graph = buildHeuristicGraph(name, files, { maxFiles });
  const rules = rulesFromFile(join(dir, CONFIG_FILE));
  const drift = args.flags.has("history") && isGitRepo(dir) ? collectDrift(dir, name, rules, parseMaxPoints(args), parseRefine(args), maxFiles).points : undefined;
  const scratch = mkdtempSync(join(tmpdir(), "codearchitect-view-"));
  const file = join(scratch, "graph.json");
  writeFileSync(file, JSON.stringify({ stamp: new Date().toISOString(), graph: { ...graph, id: `local-${slug(name)}`, rules: rules.length ? rules : graph.rules, ...(drift?.length ? { drift } : {}) } }));
  process.stdout.write(`Mapped ${graph.nodes.length} components from ${files.length} files in ${dir}
Starting the app on port ${port}…
`);

  const server = spawn(process.execPath, [nextBin, "dev", "--port", String(port)], { cwd: appRoot, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, [PRELOAD_ENV]: file } });
  let alive = true;
  const exited = new Promise<number>((done) => server.on("exit", (code) => ((alive = false), done(code ?? 0))));
  const stop = () => server.kill();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  const url = `http://localhost:${port}`;
  const ready = await waitUntilReady(url, () => alive);
  if (ready) {
    process.stdout.write(`
Ready: ${url}  (Ctrl+C to stop)
`);
    if (!args.flags.has("no-open")) openBrowser(url);
  }
  const code = await exited;
  rmSync(scratch, { recursive: true, force: true });
  if (!ready) process.stderr.write(`\nThe app stopped before it was ready. If "npm run dev" is already running for ${appRoot}, stop it (Ctrl+C) and run view again: one app can only show one folder.\n`);
  return code;
}

const HELP = `CodeArchitect: architecture health, rules and PR blast radius

Usage
  codearchitect analyze [dir] [--rules file] [--format markdown|json] [--output file] [--no-fail]
  codearchitect pr --base <ref> [--head <ref>] [--dir path] [--rules file]
                   [--format markdown|json] [--output file]
                   [--max-health-drop N] [--no-fail-on-cycles] [--no-fail-on-violations] [--fail-on-removed-exports]
  codearchitect view [dir] [--port N] [--no-open] [--history]     map a folder and open it in the app
  codearchitect history [dir] [--max-points N] [--refine N]       how health, cycles and violations changed over time
                        [--format markdown|json] [--output file]
  codearchitect share [dir] [--output file.html]                  one self-contained page to send to others

Rules live in ${CONFIG_FILE} (an array, or {"rules": [...]}). Exit code is 1 when the check fails.
Every command that maps code accepts --max-files N (default ${DEFAULT_MAPPED_FILES}, from ${MIN_MAPPED_FILES} to ${MAX_MAPPABLE_FILES}); the most architecturally relevant files are kept.
`;

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.command === "help" || args.flags.has("help")) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.command === "analyze") return runAnalyze(args);
  if (args.command === "pr") return runPr(args);
  if (args.command === "view") return runView(args);
  if (args.command === "share") return runShare(args);
  if (args.command === "history") return runHistory(args);
  throw new UsageError(`Unknown command "${args.command}".\n\n${HELP}`);
}

main().then(
  (code) => void (process.exitCode = code),
  (error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  },
);
