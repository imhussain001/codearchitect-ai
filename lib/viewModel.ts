import { MarkerType } from "@xyflow/react";
import { visibleNodeIdsAt } from "@/lib/engines/story";
import { impactPathEdgeIds } from "@/lib/graph";
import { EDGE_COLORS } from "@/lib/ui";
import type { ArchitectureGraph, ImpactAnalysisResult, NodeStatus, RenderEdge, RenderNode } from "@/lib/types";

export type ViewInputs = {
  graph: ArchitectureGraph;
  impact: ImpactAnalysisResult | null;
  story: { enabled: boolean; index: number };
};

/**
 * Overlay transient state (impact, story frame, drafts) onto the static graph.
 * Precedence: story frame > impact analysis > draft > normal.
 */
export function buildRenderGraph({ graph, impact, story }: ViewInputs): { nodes: RenderNode[]; edges: RenderEdge[] } {
  const commit = story.enabled ? graph.commits[story.index] : undefined;
  const visible = commit ? visibleNodeIdsAt(graph.nodes, graph.commits, story.index) : null;
  const impactById = new Map(impact?.impacts.map((i) => [i.nodeId, i]) ?? []);

  const nodes: RenderNode[] = graph.nodes.map((node) => {
    let status: NodeStatus = node.data.isDraft ? "proposed" : "normal";
    const hit = impactById.get(node.id);
    if (commit) {
      if (commit.addedNodeIds.includes(node.id)) status = "added";
      else if (commit.modifiedNodeIds.includes(node.id)) status = "modified";
      else status = node.data.isDraft ? "proposed" : "normal";
    } else if (hit) {
      status = hit.severity;
    }
    return {
      ...node,
      hidden: visible ? !visible.has(node.id) : false,
      data: { ...node.data, status, impactReason: commit ? undefined : hit?.reason, impactDepth: commit ? undefined : hit?.depth },
    };
  });

  const pathEdges = impact && !commit ? impactPathEdgeIds(graph.edges, new Set(impactById.keys())) : new Set<string>();
  const edges: RenderEdge[] = graph.edges.map((edge) => {
    const isImpactPath = pathEdges.has(edge.id);
    const isDraft = Boolean(edge.isDraft);
    const color = isImpactPath ? EDGE_COLORS.impact : isDraft ? EDGE_COLORS.draft : EDGE_COLORS.default;
    return {
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      label: edge.label,
      animated: true,
      hidden: visible ? !(visible.has(edge.source) && visible.has(edge.target)) : false,
      deletable: isDraft,
      data: { relation: edge.relation, isImpactPath, isDraft },
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 18, height: 18 },
      style: { stroke: color, strokeWidth: isImpactPath ? 2.5 : 1.5, strokeDasharray: isDraft ? "6 4" : undefined },
      labelStyle: { fill: isImpactPath ? "#fca5a5" : "#a1a1aa", fontSize: 10, fontFamily: "var(--font-mono)" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      labelBgStyle: { fill: "#18181b", stroke: "#27272a" },
    };
  });

  return { nodes, edges };
}
