import { collectDependents, exportedIdentifiers, nodeById } from "@/lib/graph";
import type {
  ArchitectureGraph,
  ArchNode,
  DiffItem,
  ImpactAnalysisResult,
  ImpactScenario,
  NodeImpact,
} from "@/lib/types";

export class ImpactRootNotFoundError extends Error {
  constructor(prompt: string) {
    super(
      `Could not map "${prompt}" to a component. Select a node on the canvas first, or mention a component by name (e.g. "Users Database").`,
    );
    this.name = "ImpactRootNotFoundError";
  }
}

const STOP_WORDS = new Set([
  "the", "and", "for", "from", "into", "with", "change", "changes", "refactor", "replace", "this",
  "that", "what", "will", "break", "use", "using", "instead", "make", "add", "remove", "update",
]);

const MIN_TOKEN_LENGTH = 3;

function tokenize(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= MIN_TOKEN_LENGTH && !STOP_WORDS.has(t));
}

export function matchScenario(prompt: string, scenarios: readonly ImpactScenario[]): ImpactScenario | undefined {
  return scenarios.find((s) => s.triggers.some((source) => new RegExp(source, "i").test(prompt)));
}

/** Score each node against the prompt; keyword hits weigh most, path hits least. */
export function rankNodesForPrompt(prompt: string, nodes: readonly ArchNode[]): Array<{ id: string; score: number }> {
  const tokens = new Set(tokenize(prompt));
  return nodes
    .map((node) => {
      const { keywords, label, filePath, exports } = node.data;
      let score = 0;
      for (const kw of keywords) if (tokens.has(kw.toLowerCase())) score += 3;
      for (const word of tokenize(label)) if (tokens.has(word)) score += 2;
      for (const ex of exports) for (const word of tokenize(ex)) if (tokens.has(word)) score += 2;
      for (const seg of tokenize(filePath)) if (tokens.has(seg)) score += 1;
      return { id: node.id, score };
    })
    .sort((a, b) => b.score - a.score);
}

/**
 * Choose the node the change originates from. A selected node wins unless the
 * prompt clearly names a different component (scores ≥ 2 points higher).
 */
export function resolveRootNode(prompt: string, graph: ArchitectureGraph, selectedNodeId: string | null): string {
  const ranked = rankNodesForPrompt(prompt, graph.nodes);
  const best = ranked[0];
  const selectedScore = ranked.find((r) => r.id === selectedNodeId)?.score ?? -Infinity;

  if (selectedNodeId && nodeById(graph.nodes, selectedNodeId)) {
    if (!best || best.score - selectedScore < 2) return selectedNodeId;
  }
  if (!best || best.score === 0) throw new ImpactRootNotFoundError(prompt);
  return best.id;
}

function severityForDepth(depth: number): NodeImpact["severity"] {
  if (depth === 0) return "modified";
  return depth === 1 ? "broken" : "impacted";
}

function reasonForDepth(depth: number, rootLabel: string): string {
  if (depth === 0) return "Origin of the change.";
  if (depth === 1) return `Directly consumes ${rootLabel}; its contract changes underneath this file.`;
  return `Transitively depends on ${rootLabel} (${depth} hops); payload or type changes propagate here.`;
}

const RISK_BREADTH_WEIGHT = 70;
const RISK_DEPTH_WEIGHT_PER_HOP = 10;
const RISK_MAX = 100;

export function computeRiskScore(impacts: readonly NodeImpact[], totalNodes: number): number {
  if (totalNodes === 0) return 0;
  const maxDepth = Math.max(0, ...impacts.map((i) => i.depth));
  const breadth = (impacts.length / totalNodes) * RISK_BREADTH_WEIGHT;
  return Math.min(RISK_MAX, Math.round(breadth + maxDepth * RISK_DEPTH_WEIGHT_PER_HOP));
}

/**
 * Heuristic edit when no authored scenario applies: annotate the lines that
 * touch the changed contract so the reviewer sees exactly where to look.
 */
function heuristicDiff(node: ArchNode, root: ArchNode, prompt: string, isRoot: boolean): DiffItem {
  const lines = node.data.code.split("\n");
  const marker = isRoot ? `// CHANGE: ${prompt}` : `// REVIEW: ${root.data.label} contract changes — "${prompt}"`;
  const identifiers = isRoot ? tokenize(prompt) : exportedIdentifiers(root);

  let flagged = 0;
  const annotated = lines.map((line) => {
    const hits = isRoot
      ? identifiers.some((t) => line.toLowerCase().includes(t))
      : identifiers.some((id) => new RegExp(`\\b${id}\\b`).test(line));
    if (!hits || line.trim().startsWith("//") || line.trim() === "") return line;
    flagged++;
    return `${line} // ⚠ affected`;
  });

  const lastImport = annotated.reduce((acc, line, i) => (/^\s*(import|from)\b/.test(line) ? i : acc), -1);
  annotated.splice(lastImport + 1, 0, ...(lastImport >= 0 ? ["", marker] : [marker]));

  return {
    nodeId: node.id,
    filePath: node.data.filePath,
    before: node.data.code,
    after: annotated.join("\n"),
    rationale:
      flagged > 0
        ? `Heuristic: ${flagged} line(s) reference ${isRoot ? "terms from the change request" : `exports of ${root.data.label}`}.`
        : `Heuristic: no direct references found; review the call path through ${root.data.label}.`,
  };
}

export function analyzeImpactLocally(
  graph: ArchitectureGraph,
  prompt: string,
  selectedNodeId: string | null,
): ImpactAnalysisResult {
  const trimmed = prompt.trim();
  if (!trimmed) throw new Error("Describe the change you want to simulate.");

  const scenario = matchScenario(trimmed, graph.scenarios);
  const rootNodeId = scenario?.rootNodeId ?? resolveRootNode(trimmed, graph, selectedNodeId);
  const root = nodeById(graph.nodes, rootNodeId);
  if (!root) throw new ImpactRootNotFoundError(trimmed);

  // With an authored scenario we know which files need edits: only those are "broken";
  // other graph dependents are review-only. Without one, fall back to depth-based severity.
  const authoredEdits = new Map(scenario?.diffs.map((d) => [d.nodeId, d.rationale]) ?? []);
  const depths = collectDependents(rootNodeId, graph.edges);
  const impacts: NodeImpact[] = [...depths.entries()].map(([nodeId, depth]) => {
    if (!scenario || depth === 0) {
      return { nodeId, depth, severity: severityForDepth(depth), reason: reasonForDepth(depth, root.data.label) };
    }
    const rationale = authoredEdits.get(nodeId);
    return rationale
      ? { nodeId, depth, severity: "broken", reason: rationale }
      : { nodeId, depth, severity: "impacted", reason: `Depends on ${root.data.label} (${depth} hop${depth > 1 ? "s" : ""}) but needs no edit for this change; review only.` };
  });

  for (const extra of scenario?.extraImpacts ?? []) {
    if (depths.has(extra.nodeId) || !nodeById(graph.nodes, extra.nodeId)) continue;
    impacts.push({ nodeId: extra.nodeId, depth: 1, severity: authoredEdits.has(extra.nodeId) ? "broken" : "impacted", reason: extra.reason });
  }
  impacts.sort((a, b) => a.depth - b.depth);

  const diffs: DiffItem[] = scenario
    ? scenario.diffs.flatMap((d) => {
        const node = nodeById(graph.nodes, d.nodeId);
        return node ? [{ nodeId: d.nodeId, filePath: node.data.filePath, before: node.data.code, after: d.after, rationale: d.rationale }] : [];
      })
    : impacts.flatMap((impact) => {
        const node = nodeById(graph.nodes, impact.nodeId);
        return node ? [heuristicDiff(node, root, trimmed, impact.depth === 0)] : [];
      });

  const brokenCount = impacts.filter((i) => i.severity === "broken").length;
  return {
    prompt: trimmed,
    rootNodeId,
    summary:
      scenario?.summary ??
      `"${root.data.label}" is the origin. ${brokenCount} component(s) consume it directly and ${impacts.length - brokenCount - 1} more are reached transitively. Edits below are heuristic markers — connect an AI model for concrete code changes.`,
    riskScore: computeRiskScore(impacts, graph.nodes.length),
    impacts,
    diffs,
    engine: "local",
    scenarioId: scenario?.id,
  };
}
