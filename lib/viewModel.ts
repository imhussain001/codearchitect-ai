import { MarkerType } from "@xyflow/react";
import type { HealthReport } from "@/lib/engines/health";
import { visibleNodeIdsAt } from "@/lib/engines/story";
import { impactPathEdgeIds } from "@/lib/graph";
import { EDGE_COLORS, kindLabelFor } from "@/lib/ui";
import type { ArchitectureGraph, ImpactAnalysisResult, NodeStatus, RenderEdge, RenderNode } from "@/lib/types";

export type ViewInputs = {
  graph: ArchitectureGraph;
  impact: ImpactAnalysisResult | null;
  story: { enabled: boolean; index: number };
  /** When set, the canvas shows structural health instead of impact/story state. */
  health?: HealthReport | null;
  /** When set, everything outside this node's direct neighbourhood is dimmed. */
  focusNodeId?: string | null;
  /** The app's selection, which wins over React Flow's own (it can be set from the side panels). */
  selectedNodeId?: string | null;
};

const DIMMED_EDGE_OPACITY = 0.12;

/**
 * Overlay transient state onto the static graph. Modes, by precedence:
 * health overlay > story frame > impact analysis > draft > normal. Focus dimming
 * is independent and composes with any of them.
 */
export function buildRenderGraph({ graph, impact, story, health = null, focusNodeId = null, selectedNodeId = null }: ViewInputs): { nodes: RenderNode[]; edges: RenderEdge[] } {
  const healthMode = health !== null;
  const commit = !healthMode && story.enabled ? graph.commits[story.index] : undefined;
  const visible = commit ? visibleNodeIdsAt(graph.nodes, graph.commits, story.index) : null;
  const impactById = new Map(!healthMode ? (impact?.impacts.map((i) => [i.nodeId, i] as const) ?? []) : []);

  // Direct neighbours (either direction) of the focused node stay fully visible.
  let keep: Set<string> | null = null;
  if (focusNodeId && graph.nodes.some((n) => n.id === focusNodeId)) {
    keep = new Set([focusNodeId]);
    for (const e of graph.edges) {
      if (e.source === focusNodeId) keep.add(e.target);
      if (e.target === focusNodeId) keep.add(e.source);
    }
  }

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
      },
    };
  });

  const pathEdges = impact && !commit && !healthMode ? impactPathEdgeIds(graph.edges, new Set(impactById.keys())) : new Set<string>();
  const cycleEdges = new Set(health?.cycleEdgeIds ?? []);
  const edges: RenderEdge[] = graph.edges.map((edge) => {
    const isImpactPath = pathEdges.has(edge.id);
    const isCycle = cycleEdges.has(edge.id);
    const isDraft = Boolean(edge.isDraft);
    const color = isCycle ? EDGE_COLORS.cycle : isImpactPath ? EDGE_COLORS.impact : isDraft ? EDGE_COLORS.draft : EDGE_COLORS.default;
    const dimmed = keep ? !(keep.has(edge.source) && keep.has(edge.target)) : false;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: isCycle ? `${edge.label ?? ""} ↻`.trim() : edge.label,
      animated: true,
      hidden: visible ? !(visible.has(edge.source) && visible.has(edge.target)) : false,
      deletable: isDraft,
      data: { relation: edge.relation, isImpactPath, isDraft, isCycle },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      style: {
        stroke: color,
        strokeWidth: isImpactPath || isCycle ? 2.5 : 1.5,
        strokeDasharray: isDraft ? "6 4" : undefined,
        opacity: dimmed ? DIMMED_EDGE_OPACITY : 1,
      },
      labelStyle: { fill: isImpactPath || isCycle ? "#fca5a5" : "#a1a1aa", fontSize: 10, fontFamily: "var(--font-mono)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: "#18181b", stroke: "#27272a" },
    };
  });

  return { nodes, edges };
}
