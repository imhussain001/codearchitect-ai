"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import { Copy, Database, Eye, Layers, Monitor, Network, Zap } from "lucide-react";
import { createContext, memo, useContext, type ComponentType } from "react";
import type { NodeKind, RenderNode } from "@/lib/types";
import { KIND_META, STATUS_META } from "@/lib/ui";

export type NodeActions = {
  inspect: (nodeId: string) => void;
  simulateFrom: (nodeId: string) => void;
  copyPath: (filePath: string) => void;
};

/** Quick actions are injected via context so node data stays serializable. */
export const NodeActionsContext = createContext<NodeActions | null>(null);

const KIND_ICON: Record<NodeKind, ComponentType<{ className?: string }>> = {
  frontend: Monitor,
  api: Network,
  logic: Layers,
  data: Database,
};

function QuickAction({ label, onClick, icon: Icon }: { label: string; onClick: () => void; icon: ComponentType<{ className?: string }> }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      className="nodrag rounded-md p-1 text-zinc-400 transition hover:bg-zinc-700/70 hover:text-zinc-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-violet-400"
    >
      <Icon className="h-3.5 w-3.5" />
    </button>
  );
}

function CustomNodeComponent({ id, data, selected }: NodeProps<RenderNode>) {
  const actions = useContext(NodeActionsContext);
  const kind = KIND_META[data.kind];
  const status = STATUS_META[data.status];
  const Icon = KIND_ICON[data.kind];

  return (
    <div
      className={clsx(
        "group w-[220px] rounded-xl border-2 bg-zinc-900/80 shadow-lg shadow-black/40 backdrop-blur-md transition-[transform,border-color] duration-150 hover:-translate-y-0.5",
        kind.border,
        status.glow,
        data.status === "proposed" && "border-dashed",
        selected && "ring-2 ring-white/70 ring-offset-2 ring-offset-zinc-950",
      )}
    >
      <Handle type="target" position={Position.Top} />

      <div className="flex items-start gap-2 px-3 pt-2.5">
        <div className={clsx("mt-0.5 rounded-md bg-zinc-800/80 p-1.5", kind.text)}>
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13px] font-semibold leading-tight text-zinc-50" title={data.label}>
            {data.label}
          </div>
          <div className="truncate font-mono text-[10px] text-zinc-500" title={data.filePath}>
            {data.filePath}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-2">
        <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", kind.chip)}>{kind.label}</span>
        <span className={clsx("flex items-center gap-1 text-[10px] font-medium", status.text)}>
          <span className={clsx("h-1.5 w-1.5 rounded-full", status.dot, data.status !== "normal" && "animate-pulse")} />
          {status.label}
          {data.impactDepth !== undefined && data.impactDepth > 0 && <span className="text-zinc-500">· {data.impactDepth} hop</span>}
        </span>
      </div>

      {actions && (
        <div className="flex items-center justify-end gap-0.5 border-t border-zinc-800/80 px-2 py-1 opacity-60 transition group-hover:opacity-100">
          <QuickAction label="Inspect code" icon={Eye} onClick={() => actions.inspect(id)} />
          <QuickAction label="Simulate change from here" icon={Zap} onClick={() => actions.simulateFrom(id)} />
          <QuickAction label="Copy file path" icon={Copy} onClick={() => actions.copyPath(data.filePath)} />
        </div>
      )}

      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}

export const CustomNode = memo(CustomNodeComponent);
