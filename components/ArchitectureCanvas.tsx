"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { useCallback, useMemo } from "react";
import { CustomNode, NodeActionsContext, type NodeActions } from "@/components/CustomNode";
import type { ArchNode, RenderEdge, RenderNode } from "@/lib/types";
import { KIND_META, STATUS_META } from "@/lib/ui";

const NODE_TYPES: NodeTypes = { component: CustomNode };

const MINIMAP_STATUS_COLORS: Partial<Record<RenderNode["data"]["status"], string>> = {
  broken: "#ef4444",
  impacted: "#f59e0b",
  modified: "#38bdf8",
  added: "#34d399",
  proposed: "#d946ef",
};

type Props = {
  graphKey: string;
  nodes: RenderNode[];
  edges: RenderEdge[];
  actions: NodeActions;
  onNodesChange: (changes: NodeChange<ArchNode>[]) => void;
  onSelectNode: (nodeId: string | null) => void;
  onConnect: (connection: Connection) => void;
  onRemoveDraftEdge: (edgeId: string) => void;
};

export function ArchitectureCanvas({ graphKey, nodes, edges, actions, onNodesChange, onSelectNode, onConnect, onRemoveDraftEdge }: Props) {
  const handleEdgesChange = useCallback(
    (changes: EdgeChange<RenderEdge>[]) => {
      for (const change of changes) if (change.type === "remove") onRemoveDraftEdge(change.id);
    },
    [onRemoveDraftEdge],
  );

  const isValidConnection = useCallback((c: Connection | RenderEdge) => c.source !== c.target, []);

  const legend = useMemo(
    () =>
      (Object.keys(KIND_META) as Array<keyof typeof KIND_META>).map((kind) => (
        <span key={kind} className="flex items-center gap-1.5">
          <span className="h-2 w-2 rounded-sm" style={{ background: KIND_META[kind].hex }} />
          {KIND_META[kind].label}
        </span>
      )),
    [],
  );

  return (
    <NodeActionsContext.Provider value={actions}>
      <ReactFlow<RenderNode, RenderEdge>
        key={graphKey}
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        // RenderNode is ArchNode plus derived fields; position/dimension changes apply to the source nodes.
        onNodesChange={onNodesChange as unknown as (changes: NodeChange<RenderNode>[]) => void}
        onEdgesChange={handleEdgesChange}
        onNodeClick={(_, node) => onSelectNode(node.id)}
        onPaneClick={() => onSelectNode(null)}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        colorMode="dark"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#3f3f46" />
        <Controls position="bottom-left" showInteractive={false} />
        <MiniMap
          position="bottom-right"
          pannable
          zoomable
          nodeBorderRadius={6}
          nodeColor={(n) => MINIMAP_STATUS_COLORS[(n as RenderNode).data.status] ?? KIND_META[(n as RenderNode).data.kind].hex}
          className="!rounded-lg !border !border-zinc-800"
        />
        <Panel position="top-left">
          <div className="flex flex-wrap gap-3 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur">
            {legend}
          </div>
        </Panel>
        <Panel position="top-right">
          <div className="flex gap-3 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur">
            {(["broken", "impacted", "modified", "proposed"] as const).map((s) => (
              <span key={s} className="flex items-center gap-1.5">
                <span className={`h-2 w-2 rounded-full ${STATUS_META[s].dot}`} />
                {STATUS_META[s].label}
              </span>
            ))}
          </div>
        </Panel>
      </ReactFlow>
    </NodeActionsContext.Provider>
  );
}
