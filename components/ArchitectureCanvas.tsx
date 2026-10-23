"use client";

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type NodeTypes,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, type ReactNode } from "react";
import { CustomNode, NodeActionsContext, type NodeActions } from "@/components/CustomNode";
import { SearchBox } from "@/components/SearchBox";
import type { ArchitectureGraph, ArchNode, RenderEdge, RenderNode } from "@/lib/types";
import { HEALTH_META, KIND_META, STATUS_META } from "@/lib/ui";

const NODE_TYPES: NodeTypes = { component: CustomNode };

const MINIMAP_STATUS_COLORS: Partial<Record<RenderNode["data"]["status"], string>> = {
  broken: "#ef4444",
  impacted: "#f59e0b",
  modified: "#38bdf8",
  added: "#34d399",
  proposed: "#d946ef",
};

const CENTER_PADDING = 0.8;
const CENTER_MAX_ZOOM = 1.1;
const CENTER_DURATION_MS = 450;

export type CenterRequest = { nodeId: string; nonce: number };

/** Pans and zooms to a component whenever a new request (new nonce) arrives. */
function CenterController({ request }: { request: CenterRequest | null }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (!request) return;
    void fitView({ nodes: [{ id: request.nodeId }], padding: CENTER_PADDING, maxZoom: CENTER_MAX_ZOOM, duration: CENTER_DURATION_MS });
  }, [request, fitView]);
  return null;
}

type Props = {
  graphKey: string;
  kindLabels?: ArchitectureGraph["kindLabels"];
  centerRequest: CenterRequest | null;
  /** Source components the search box looks through. */
  searchNodes: ArchNode[];
  onSearchSelect: (nodeId: string) => void;
  focusEnabled: boolean;
  hasSelection: boolean;
  onToggleFocus: () => void;
  /** Shown under the legends in the top-left column (e.g. the active trace). */
  banner?: ReactNode;
  nodes: RenderNode[];
  edges: RenderEdge[];
  actions: NodeActions;
  onNodesChange: (changes: NodeChange<ArchNode>[]) => void;
  onSelectNode: (nodeId: string | null) => void;
  onConnect: (connection: Connection) => void;
  onRemoveDraftEdge: (edgeId: string) => void;
};

/** Above this many components the canvas renders only what is in view. */
const ONLY_RENDER_VISIBLE_ABOVE = 250;

export function ArchitectureCanvas({ graphKey, kindLabels, centerRequest, searchNodes, onSearchSelect, focusEnabled, hasSelection, onToggleFocus, banner, nodes, edges, actions, onNodesChange, onSelectNode, onConnect, onRemoveDraftEdge }: Props) {
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
          {kindLabels?.[kind] ?? KIND_META[kind].label}
        </span>
      )),
    [kindLabels],
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
        // Past a few hundred components only the ones on screen are drawn, which keeps big maps responsive.
        onlyRenderVisibleElements={nodes.length > ONLY_RENDER_VISIBLE_ABOVE}
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
          nodeColor={(n) => {
            const data = (n as RenderNode).data;
            return (data.heat ? HEALTH_META[data.heat.level].hex : undefined) ?? MINIMAP_STATUS_COLORS[data.status] ?? KIND_META[data.kind].hex;
          }}
          className="!hidden !rounded-lg !border !border-zinc-800 sm:!block"
        />
        <CenterController request={centerRequest} />
        <Panel position="top-left">
          <div className="flex max-w-[min(100%,38rem)] flex-col gap-1.5">
            <SearchBox nodes={searchNodes} onSelect={onSearchSelect} focusEnabled={focusEnabled} hasSelection={hasSelection} onToggleFocus={onToggleFocus} />
          </div>
          <div data-tour="legend" className="mt-1.5 flex max-w-[min(100%,38rem)] flex-col gap-1.5">
            <div className="flex max-w-full gap-x-3 gap-y-1 overflow-x-auto whitespace-nowrap rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur sm:flex-wrap sm:overflow-visible sm:whitespace-normal" title="Colour = what the component is for">
              {legend}
            </div>
            <div className="hidden flex-wrap gap-x-3 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-950/80 px-3 py-1.5 text-[11px] text-zinc-400 backdrop-blur sm:flex" title="Glow = what a simulated change does to it">
              {(["broken", "impacted", "modified", "proposed"] as const).map((s) => (
                <span key={s} className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${STATUS_META[s].dot}`} />
                  {STATUS_META[s].label}
                </span>
              ))}
            </div>
            {banner}
          </div>
        </Panel>
      </ReactFlow>
    </NodeActionsContext.Provider>
  );
}
