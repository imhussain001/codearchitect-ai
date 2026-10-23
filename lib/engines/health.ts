import { nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ArchNode, DependencyEdge, HealthLevel, NodeKind } from "@/lib/types";

/* ---------- Tunables (named so the scoring is explainable and testable) ---------- */

/** A component is a "hub" when at least this many others depend on it, and at least HUB_MIN_SHARE of the graph. */
export const HUB_MIN_FAN_IN = 4;
export const HUB_MIN_SHARE = 0.25;
export const LARGE_FILE_LINES = 400;
export const HUGE_FILE_LINES = 800;

const SCORE_PER_DEPENDENT = 8;
const SCORE_DEPENDENT_CAP = 40;
const SCORE_IN_CYCLE = 30;
const SCORE_PER_LINES_UNIT = 20; // one point per this many lines
const SCORE_SIZE_CAP = 20;
const SCORE_LAYERING = 15;
const SCORE_PER_DEPENDENCY = 3;
const SCORE_DEPENDENCY_CAP = 15;
const SCORE_MAX = 100;

const WATCH_FROM = 35;
const RISKY_FROM = 65;

/** Files nothing imports by design: framework entry points, scripts and config. */
const ENTRY_FILE = /(^|\/)(app\/(.*\/)?(layout|page|route|loading|error|not-found|template|default)\.[jt]sx?|(main|index|middleware|instrumentation)\.[jt]sx?|main\.go|(main|lib|build)\.rs|src\/bin\/[^/]+\.rs|[^/]*(Application|Main|App|Controller|Configuration|Config)\.java|[^/]*\.(config|setup)\.[cm]?[jt]s)$/i;
const ENTRY_DIR = /(^|\/)(scripts?|bin|cli|cmd)\//i;

export function isLikelyEntryPoint(filePath: string): boolean {
  const path = filePath.split("\\").join("/");
  return ENTRY_FILE.test(path) || ENTRY_DIR.test(path);
}

export type HealthIssueKind = "cycle" | "hub" | "orphan" | "large" | "layering";
export type HealthSeverity = "high" | "medium" | "low";

export type HealthIssue = {
  id: string;
  kind: HealthIssueKind;
  severity: HealthSeverity;
  title: string;
  /** Plain-language explanation, safe to show to non-experts. */
  detail: string;
  nodeIds: string[];
};

export type NodeHealth = {
  nodeId: string;
  /** How many other components depend on this one (direct). */
  fanIn: number;
  /** How many components this one depends on (direct). */
  fanOut: number;
  lines: number;
  inCycle: boolean;
  isOrphan: boolean;
  /** 0 (calm) – 100 (fragile / expensive to change). */
  score: number;
  level: HealthLevel;
  reasons: string[];
};

export type HealthGrade = "A" | "B" | "C" | "D" | "F";

export type HealthReport = {
  nodes: Record<string, NodeHealth>;
  issues: HealthIssue[];
  /** Edge IDs that sit inside a circular dependency. */
  cycleEdgeIds: string[];
  /** 0–100 for the whole graph; higher is healthier. */
  overall: number;
  grade: HealthGrade;
  counts: { cycles: number; hubs: number; orphans: number; large: number; layering: number };
};

const SEVERITY_ORDER: Record<HealthSeverity, number> = { high: 0, medium: 1, low: 2 };

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function joinNames(names: string[], max = 3): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

function lineCountOf(node: ArchNode): number {
  return node.data.lineCount ?? (node.data.code ? node.data.code.split("\n").length : 0);
}

/**
 * Strongly connected components (Tarjan, recursive: graphs here are capped at a few
 * hundred nodes). A component with more than one node, or a self-loop, is a cycle.
 */
export function findCycles(nodeIds: readonly string[], edges: readonly DependencyEdge[]): string[][] {
  const known = new Set(nodeIds);
  const out = new Map<string, string[]>();
  for (const e of edges) {
    if (!known.has(e.source) || !known.has(e.target)) continue;
    const list = out.get(e.source) ?? [];
    list.push(e.target);
    out.set(e.source, list);
  }

  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: string[][] = [];
  let counter = 0;

  const visit = (v: string): void => {
    index.set(v, counter);
    low.set(v, counter);
    counter++;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w);
        low.set(v, Math.min(low.get(v)!, low.get(w)!));
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!));
      }
    }
    if (low.get(v) === index.get(v)) {
      const group: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        group.push(w);
      } while (w !== v);
      const selfLoop = group.length === 1 && (out.get(v) ?? []).includes(v);
      if (group.length > 1 || selfLoop) cycles.push(group.reverse());
    }
  };

  for (const id of nodeIds) if (!index.has(id)) visit(id);
  return cycles;
}

/** UI talking straight to the database, or the database depending on the UI/API above it. */
function layeringProblem(source: NodeKind, target: NodeKind): string | null {
  if (source === "frontend" && target === "data") return "talks directly to the data layer, skipping the API/logic in between";
  if (source === "data" && (target === "frontend" || target === "api")) return "depends on a layer above it (data should not call UI or API code)";
  return null;
}

function levelFor(score: number): HealthLevel {
  return score >= RISKY_FROM ? "risky" : score >= WATCH_FROM ? "watch" : "healthy";
}

function gradeFor(overall: number): HealthGrade {
  if (overall >= 85) return "A";
  if (overall >= 70) return "B";
  if (overall >= 55) return "C";
  if (overall >= 40) return "D";
  return "F";
}

/**
 * Structural health of an architecture graph. Pure and deterministic; draft nodes and
 * edges from the builder are ignored because they are not part of the codebase yet.
 */
export function analyzeHealth(graph: ArchitectureGraph): HealthReport {
  const nodes = graph.nodes.filter((n) => !n.data.isDraft);
  const ids = new Set(nodes.map((n) => n.id));
  const allEdges = graph.edges.filter((e) => !e.isDraft && ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  // Type-only imports are erased at runtime: they do not make a hub, a cycle or a crossed layer.
  const edges = allEdges.filter((e) => !e.typeOnly);
  // Files in one Go package or Java package use each other freely, so a loop between them is not a cycle worth
  // reporting; their links still count for fan-in, hubs and risk.
  const cycleEdges = edges.filter((e) => !e.samePackage);
  const connected = new Set(allEdges.flatMap((e) => [e.source, e.target]));
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;

  const dependents = new Map<string, Set<string>>();
  const dependencies = new Map<string, Set<string>>();
  for (const e of edges) {
    (dependents.get(e.target) ?? dependents.set(e.target, new Set()).get(e.target)!).add(e.source);
    (dependencies.get(e.source) ?? dependencies.set(e.source, new Set()).get(e.source)!).add(e.target);
  }

  const cycles = findCycles([...ids], cycleEdges);
  const inCycle = new Set(cycles.flat());
  const cycleOf = new Map<string, number>();
  cycles.forEach((group, i) => group.forEach((id) => cycleOf.set(id, i)));
  const cycleEdgeIds = cycleEdges.filter((e) => cycleOf.has(e.source) && cycleOf.get(e.source) === cycleOf.get(e.target)).map((e) => e.id);

  const issues: HealthIssue[] = [];
  const layeringNodes = new Set<string>();
  const counts = { cycles: cycles.length, hubs: 0, orphans: 0, large: 0, layering: 0 };

  cycles.forEach((group, i) => {
    issues.push({
      id: `cycle-${i}`,
      kind: "cycle",
      severity: "high",
      title: `Circular dependency (${group.length} ${group.length === 1 ? "component" : "components"})`,
      detail: `${joinNames(group.map(label), 4)} depend on each other in a loop. Changing any of them can ripple back to itself, and they cannot be understood or tested separately.`,
      nodeIds: group,
    });
  });

  for (const e of edges) {
    const problem = layeringProblem(nodeById(nodes, e.source)!.data.kind, nodeById(nodes, e.target)!.data.kind);
    if (!problem) continue;
    counts.layering++;
    layeringNodes.add(e.source);
    layeringNodes.add(e.target);
    issues.push({
      id: `layering-${e.id}`,
      kind: "layering",
      severity: "medium",
      title: "Layers are crossed",
      detail: `${label(e.source)} ${problem} (${label(e.target)}).`,
      nodeIds: [e.source, e.target],
    });
  }

  const report: Record<string, NodeHealth> = {};
  for (const node of nodes) {
    const fanIn = dependents.get(node.id)?.size ?? 0;
    const fanOut = dependencies.get(node.id)?.size ?? 0;
    const lines = lineCountOf(node);
    const isOrphan = !connected.has(node.id) && !isLikelyEntryPoint(node.data.filePath);
    const cyc = inCycle.has(node.id);
    const reasons: string[] = [];

    let score = Math.min(SCORE_DEPENDENT_CAP, fanIn * SCORE_PER_DEPENDENT) + Math.min(SCORE_DEPENDENCY_CAP, fanOut * SCORE_PER_DEPENDENCY);
    score += Math.min(SCORE_SIZE_CAP, Math.floor(lines / SCORE_PER_LINES_UNIT));
    if (cyc) score += SCORE_IN_CYCLE;
    if (layeringNodes.has(node.id)) score += SCORE_LAYERING;
    score = Math.min(SCORE_MAX, score);

    if (fanIn > 0) reasons.push(`${plural(fanIn, "component")} depend${fanIn === 1 ? "s" : ""} on it`);
    if (cyc) reasons.push("part of a circular dependency");
    if (layeringNodes.has(node.id)) reasons.push("involved in a crossed layer");
    if (lines >= LARGE_FILE_LINES) reasons.push(`large (${lines.toLocaleString()} lines)`);
    if (fanOut >= 6) reasons.push(`depends on ${fanOut} other components`);
    if (isOrphan) reasons.push("not connected to anything");

    report[node.id] = { nodeId: node.id, fanIn, fanOut, lines, inCycle: cyc, isOrphan, score, level: levelFor(score), reasons };

    const hub = fanIn >= HUB_MIN_FAN_IN && nodes.length > 1 && fanIn / (nodes.length - 1) >= HUB_MIN_SHARE;
    if (hub) {
      counts.hubs++;
      issues.push({
        id: `hub-${node.id}`,
        kind: "hub",
        severity: "medium",
        title: `${node.data.label} is a hub`,
        detail: `${plural(fanIn, "component")} depend on it (${joinNames([...dependents.get(node.id)!].map(label))}). A change here has a wide blast radius; keep its interface small and stable.`,
        nodeIds: [node.id],
      });
    }
    if (lines >= LARGE_FILE_LINES) {
      counts.large++;
      issues.push({
        id: `large-${node.id}`,
        kind: "large",
        severity: lines >= HUGE_FILE_LINES ? "medium" : "low",
        title: `${node.data.label} is large`,
        detail: `${lines.toLocaleString()} lines in one file. Big files hide several responsibilities; consider splitting it so each part can change on its own.`,
        nodeIds: [node.id],
      });
    }
    if (isOrphan && nodes.length > 1) {
      counts.orphans++;
      issues.push({
        id: `orphan-${node.id}`,
        kind: "orphan",
        severity: "low",
        title: `${node.data.label} is not connected`,
        detail: "Nothing uses it and it uses nothing in this map. It may be dead code, an entry point the map cannot see, or a link the scanner missed.",
        nodeIds: [node.id],
      });
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.title.localeCompare(b.title));

  const penalty = counts.cycles * 12 + counts.layering * 8 + counts.hubs * 5 + counts.large * 4 + counts.orphans * 2;
  const overall = Math.max(0, SCORE_MAX - penalty);
  return { nodes: report, issues, cycleEdgeIds, overall, grade: gradeFor(overall), counts };
}

/** Stable identity of an issue across two analyses: cycles by their members, others by their (already stable) id. */
export function healthIssueKey(issue: HealthIssue): string {
  return issue.kind === "cycle" ? `cycle:${[...issue.nodeIds].sort().join(",")}` : issue.id;
}

/** The `limit` components most expensive to change, riskiest first. */
export function riskiestNodes(report: HealthReport, limit = 5): NodeHealth[] {
  return Object.values(report.nodes)
    .filter((n) => n.score > 0)
    .sort((a, b) => b.score - a.score || a.nodeId.localeCompare(b.nodeId))
    .slice(0, limit);
}
