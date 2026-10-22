import { MarkerType } from "@xyflow/react";
import type { HealthReport } from "@/lib/engines/health";
import type { Trace } from "@/lib/engines/provenance";
import { visibleNodeIdsAt } from "@/lib/engines/story";
import { impactPathEdgeIds } from "@/lib/graph";
import { EDGE_COLORS, kindLabelFor } from "@/lib/ui";
import type { ArchitectureGraph, ImpactAnalysisResult, NodeStatus, RenderEdge, RenderNode, RuleViolation } from "@/lib/types";

export type ViewInputs = {
  graph: ArchitectureGraph;
  impact: ImpactAnalysisResult | null;
  story: { enabled: boolean; index: number };
  /** When set, the canvas shows structural health instead of impact/story state. */
  health?: HealthReport | null;
  /** When set, everything outside this node's direct neighbourhood is dimmed. */
  focusNodeId?: string | null;
  /** A provenance trace to highlight; everything outside it is dimmed. Health view wins over it. */
  trace?: Trace | null;
  /** Architecture-rule violations to draw (only passed in the Health view). */
  violations?: readonly RuleViolation[];
  /** The app's selection, which wins over React Flow's own (it can be set from the side panels). */
  selectedNodeId?: string | null;
};

const DIMMED_EDGE_OPACITY = 0.12;

/**
 * Overlay transient state onto the static graph. Modes, by precedence:
 * health overlay > story frame > impact analysis > draft > normal. Focus dimming
 * is independent and composes with any of them.
 */
export function buildRenderGraph({ graph, impact, story, health = null, focusNodeId = null, selectedNodeId = null, violations = [], trace = null }: ViewInputs): { nodes: RenderNode[]; edges: RenderEdge[] } {
  const healthMode = health !== null;
  const tracing = !healthMode ? trace : null;
  const overlaysOff = healthMode || tracing !== null;
  const commit = !overlaysOff && story.enabled ? graph.commits[story.index] : undefined;
  const visible = commit ? visibleNodeIdsAt(graph.nodes, graph.commits, story.index) : null;
  const impactById = new Map(!overlaysOff ? (impact?.impacts.map((i) => [i.nodeId, i] as const) ?? []) : []);

  // Direct neighbours (either direction) of the focused node stay fully visible.
  let keep: Set<string> | null = null;
  const traceStepOf = new Map(tracing ? tracing.steps.map((s, i) => [s.nodeId, i + 1] as const) : []);
  if (tracing) {
    keep = new Set(tracing.nodeIds); // a trace takes over from focus mode
  } else if (focusNodeId && graph.nodes.some((n) => n.id === focusNodeId)) {
    keep = new Set([focusNodeId]);
    for (const e of graph.edges) {
      if (e.source === focusNodeId) keep.add(e.target);
      if (e.target === focusNodeId) keep.add(e.source);
    }
  }

  const violationEdges = new Set(violations.flatMap((v) => v.edgeIds));
  const violationsByNode = new Map<string, number>();
  for (const v of violations) for (const id of new Set(v.nodeIds)) violationsByNode.set(id, (violationsByNode.get(id) ?? 0) + 1);

  const nodes: RenderNode[] = graph.nodes.map((node) => {
    let status: NodeStatus = node.data.isDraft ? "proposed" : "normal";
    const hit = impactById.get(node.id);
    if (commit) {
      if (commit.addedNodeIds.includes(node.id)) status = "added";
      else if (commit.modifiedNodeIds.includes(node.id)) status = "modified";
    } else if (hit) {
      status = hit.severity;
    }
    const nodeHealth = health?.nodes[node.id];
    return {
      ...node,
      selected: node.id === selectedNodeId,
      hidden: visible ? !visible.has(node.id) : false,
      data: {
        ...node.data,
        status,
        kindLabel: kindLabelFor(graph, node.data.kind),
        impactReason: commit ? undefined : hit?.reason,
        impactDepth: commit ? undefined : hit?.depth,
        heat: nodeHealth ? { level: nodeHealth.level, score: nodeHealth.score } : undefined,
        dimmed: keep ? !keep.has(node.id) : undefined,
        violations: violationsByNode.get(node.id),
        traced: tracing ? traceStepOf.has(node.id) : undefined,
        traceStep: traceStepOf.get(node.id),
      },
    };
  });

  const traceEdges = new Set(tracing?.edgeIds ?? []);
  const pathEdges = impact && !commit && !overlaysOff ? impactPathEdgeIds(graph.edges, new Set(impactById.keys())) : new Set<string>();
  const cycleEdges = new Set(health?.cycleEdgeIds ?? []);
  const edges: RenderEdge[] = graph.edges.map((edge) => {
    const isImpactPath = pathEdges.has(edge.id);
    const isCycle = cycleEdges.has(edge.id);
    const isViolation = violationEdges.has(edge.id);
    const isTrace = traceEdges.has(edge.id);
    const isDraft = Boolean(edge.isDraft);
    const color = isTrace ? EDGE_COLORS.trace : isViolation ? EDGE_COLORS.violation : isCycle ? EDGE_COLORS.cycle : isImpactPath ? EDGE_COLORS.impact : isDraft ? EDGE_COLORS.draft : EDGE_COLORS.default;
    const dimmed = tracing ? !isTrace : keep ? !(keep.has(edge.source) && keep.has(edge.target)) : false;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: isViolation ? `${edge.label ?? ""} ✕ rule`.trim() : isCycle ? `${edge.label ?? ""} ↻`.trim() : edge.label,
      animated: true,
      hidden: visible ? !(visible.has(edge.source) && visible.has(edge.target)) : false,
      deletable: isDraft,
      data: { relation: edge.relation, isImpactPath, isDraft, isCycle, isViolation, isTrace },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      style: {
        stroke: color,
        strokeWidth: isImpactPath || isCycle || isViolation || isTrace ? 2.5 : 1.5,
        strokeDasharray: isDraft ? "6 4" : isViolation ? "3 3" : undefined,
        opacity: dimmed ? DIMMED_EDGE_OPACITY : 1,
      },
      labelStyle: { fill: isTrace ? "#67e8f9" : isImpactPath || isCycle || isViolation ? "#fca5a5" : "#a1a1aa", fontSize: 10, fontFamily: "var(--font-mono)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: "#18181b", stroke: "#27272a" },
    };
  });

  return { nodes, edges };
}
