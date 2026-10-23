import type { Snapshot } from "@/lib/report";
import type { DriftPoint } from "@/lib/types";

/**
 * Architecture drift: how health, cycles and rule violations changed commit by commit, and
 * which commits made things worse. Pure functions over measured points; the CLI does the
 * git work (checking out nothing: it reads each commit's files through git).
 */

export type { DriftPoint };

export type DriftStep = DriftPoint & {
  /** Change against the previous point; zero for the first. */
  scoreDelta: number;
  cyclesDelta: number;
  violationsDelta: number;
};

export type DriftReport = {
  steps: DriftStep[];
  /** Commits that made the architecture worse, worst first. */
  regressions: DriftStep[];
  /** Commits that made it better, best first. */
  improvements: DriftStep[];
  first: DriftPoint | null;
  last: DriftPoint | null;
  /** last.score − first.score. */
  netScoreDelta: number;
  trend: "improving" | "steady" | "declining";
};

/** A score drop of at least this many points, a new cycle or a new violation counts as a regression. */
export const REGRESSION_MIN_DROP = 3;
/** The net change that separates "steady" from a trend. */
export const TREND_MIN_NET = 3;
const MAX_LISTED = 5;

/** What one commit's analysed architecture contributes to the series. */
export function measure(commit: Pick<DriftPoint, "hash" | "message" | "author" | "date">, snapshot: Snapshot): DriftPoint {
  const loops = snapshot.health.counts.cycles;
  return {
    ...commit,
    components: snapshot.graph.nodes.length,
    dependencies: snapshot.graph.edges.length,
    score: snapshot.health.overall,
    grade: snapshot.health.grade,
    cycles: loops,
    violations: snapshot.violations.filter((v) => v.ruleType !== "no-cycles").length,
  };
}

const isRegression = (s: DriftStep) => s.scoreDelta <= -REGRESSION_MIN_DROP || s.cyclesDelta > 0 || s.violationsDelta > 0;
const isImprovement = (s: DriftStep) => s.scoreDelta >= REGRESSION_MIN_DROP || s.cyclesDelta < 0 || s.violationsDelta < 0;

/** How bad a regression is, for ordering: new cycles and violations outweigh a few points. */
const badness = (s: DriftStep) => Math.max(0, -s.scoreDelta) + 10 * Math.max(0, s.cyclesDelta) + 5 * Math.max(0, s.violationsDelta);
const goodness = (s: DriftStep) => Math.max(0, s.scoreDelta) + 10 * Math.max(0, -s.cyclesDelta) + 5 * Math.max(0, -s.violationsDelta);

export function analyzeDrift(points: readonly DriftPoint[]): DriftReport {
  const steps: DriftStep[] = points.map((p, i) => {
    const prev = points[i - 1];
    return { ...p, scoreDelta: prev ? p.score - prev.score : 0, cyclesDelta: prev ? p.cycles - prev.cycles : 0, violationsDelta: prev ? p.violations - prev.violations : 0 };
  });
  const rest = steps.slice(1); // the first point has no predecessor, so it cannot regress
  const first = points[0] ?? null;
  const last = points.at(-1) ?? null;
  const net = first && last ? last.score - first.score : 0;
  return {
    steps,
    regressions: rest.filter(isRegression).sort((a, b) => badness(b) - badness(a)).slice(0, MAX_LISTED),
    improvements: rest.filter(isImprovement).sort((a, b) => goodness(b) - goodness(a)).slice(0, MAX_LISTED),
    first,
    last,
    netScoreDelta: net,
    trend: net >= TREND_MIN_NET ? "improving" : net <= -TREND_MIN_NET ? "declining" : "steady",
  };
}

/**
 * Evenly spaced indices into a list of `total` items, always including the first and last,
 * so a long history is sampled rather than skipped.
 */
export function sampleIndices(total: number, maxPoints: number): number[] {
  if (total <= 0) return [];
  if (total <= maxPoints || maxPoints < 2) return maxPoints < 2 ? [total - 1] : Array.from({ length: total }, (_, i) => i);
  return [...new Set(Array.from({ length: maxPoints }, (_, i) => Math.round((i * (total - 1)) / (maxPoints - 1))))];
}

const BLOCKS = "▁▂▃▄▅▆▇█";

/** Smallest score span the sparkline stretches to full height, so a 2-point wobble does not look like a cliff. */
const SPARKLINE_MIN_SPAN = 10;

/** A one-line text chart of the score series (for terminals and Markdown). */
export function sparkline(scores: readonly number[]): string {
  if (scores.length === 0) return "";
  const lo = Math.min(...scores);
  const hi = Math.max(Math.max(...scores), lo + SPARKLINE_MIN_SPAN);
  if (scores.every((s) => s === scores[0])) return BLOCKS[BLOCKS.length >> 1]!.repeat(scores.length);
  return scores.map((s) => BLOCKS[Math.round(((s - lo) / (hi - lo)) * (BLOCKS.length - 1))]!).join("");
}

/* ---------- Markdown ---------- */

const signed = (n: number) => (n === 0 ? "±0" : n > 0 ? `+${n}` : `−${Math.abs(n)}`);
const cell = (text: string) => text.replace(/\|/g, "\|").replace(/\r?\n/g, " ");
const short = (hash: string) => hash.slice(0, 7);
const day = (iso: string) => iso.slice(0, 10);

function describe(s: DriftStep): string {
  const parts = [`health ${signed(s.scoreDelta)}`];
  if (s.cyclesDelta) parts.push(`${signed(s.cyclesDelta)} cycle${Math.abs(s.cyclesDelta) === 1 ? "" : "s"}`);
  if (s.violationsDelta) parts.push(`${signed(s.violationsDelta)} rule violation${Math.abs(s.violationsDelta) === 1 ? "" : "s"}`);
  return parts.join(", ");
}

export function renderDriftMarkdown(report: DriftReport, name: string): string {
  const { steps, first, last } = report;
  if (!first || !last) return `# Architecture drift: ${name}\n\nNo commits with supported source files were found.\n`;
  const lines = [
    `# Architecture drift: ${name}`,
    "",
    `**${report.trend === "improving" ? "Improving" : report.trend === "declining" ? "Declining" : "Steady"}.** Health went from **${first.grade} · ${first.score}** (${day(first.date)}) to **${last.grade} · ${last.score}** (${day(last.date)}), ${signed(report.netScoreDelta)} over ${steps.length} commit${steps.length === 1 ? "" : "s"} sampled.`,
    "",
    `\`${sparkline(steps.map((s) => s.score))}\``,
    "",
  ];
  if (report.regressions.length) {
    lines.push("## Commits that made it worse", "");
    for (const s of report.regressions) lines.push(`- \`${short(s.hash)}\` ${cell(s.message)} _(${day(s.date)}, ${cell(s.author)})_: ${describe(s)}`);
    lines.push("");
  }
  if (report.improvements.length) {
    lines.push("## Commits that made it better", "");
    for (const s of report.improvements) lines.push(`- \`${short(s.hash)}\` ${cell(s.message)} _(${day(s.date)})_: ${describe(s)}`);
    lines.push("");
  }
  lines.push("## Timeline", "", "| Commit | Date | Health | Δ | Cycles | Violations | Components |", "|---|---|---|---|---|---|---|");
  for (const s of steps) lines.push(`| \`${short(s.hash)}\` ${cell(s.message).slice(0, 60)} | ${day(s.date)} | ${s.grade} · ${s.score} | ${signed(s.scoreDelta)} | ${s.cycles} | ${s.violations} | ${s.components} |`);
  lines.push("", "<sub>Each point re-analyses that commit's source. Rules are the current ones, applied to every commit, so changes reflect code, not rule edits. Heuristic: it shows direction, not exact quality.</sub>", "");
  return lines.join("\n");
}
