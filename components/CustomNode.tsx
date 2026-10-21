"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";
import clsx from "clsx";
import { Copy, Database, Eye, Layers, Monitor, Network, Zap } from "lucide-react";
import { createContext, memo, useContext, type ComponentType } from "react";
import type { NodeKind, RenderNode } from "@/lib/types";
import { HEALTH_META, KIND_META, STATUS_META } from "@/lib/ui";

export type NodeActions = {
  inspect: (nodeId: string) => void;
  simulateFrom: (nodeId: string) => void;
  copyPath: (filePath: string) => void;
};

/** Quick actions are injected via context so node data stays serializable. */
export const NodeActionsContext = createContext<NodeActions | null>(null);

const STATUS_HELP: Record<RenderNode["data"]["status"], string> = {
  normal: "No change is being simulated for this component.",
  modified: "This is where the change starts.",
  added: "Introduced by the commit you are viewing.",
  impacted: "Depends on the changed component; review it, it may need a smaller edit.",
  broken: "Will fail or misbehave unless it is edited for this change.",
  proposed: "A draft component from the Builder; it does not exist in the code yet.",
};

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
  const heat = data.heat ? HEALTH_META[data.heat.level] : null;

  return (
    <div
      className={clsx(
        "group w-[220px] rounded-xl border-2 bg-zinc-900/80 shadow-lg shadow-black/40 backdrop-blur-md transition-[transform,border-color,opacity] duration-150 hover:-translate-y-0.5",
        kind.border,
        status.glow,
        data.status === "proposed" && "border-dashed",
        heat && !selected && heat.ring,
        data.dimmed && "opacity-25 saturate-50",
        selected && "ring-2 ring-white/70 ring-offset-2 ring-offset-zinc-950",
      )}
    >
      <Handle type="target" position={Position.Top} />

      {data.violations ? (
        <span
          className="absolute -right-2 -top-2 z-10 rounded-full bg-orange-600 px-1.5 py-0.5 text-[10px] font-bold text-white shadow"
          title={`${data.violations} architecture rule violation${data.violations === 1 ? "" : "s"} involve this component`}
        >
          ✕ {data.violations}
        </span>
      ) : null}

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
        <span className={clsx("truncate rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", kind.chip)} title={kind.label}>
          {data.kindLabel}
        </span>
        {heat && data.heat ? (
          <span
            className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset", heat.chip)}
            title={`Change-risk ${data.heat.score}/100 (${heat.label}). Higher means more things depend on it or it is structurally tangled.`}
          >
            Risk {data.heat.score}
          </span>
        ) : (
          <span className={clsx("flex shrink-0 items-center gap-1 text-[10px] font-medium", status.text)} title={STATUS_HELP[data.status]}>
            <span className={clsx("h-1.5 w-1.5 rounded-full", status.dot, data.status !== "normal" && "animate-pulse")} />
            {status.label}
            {data.impactDepth !== undefined && data.impactDepth > 0 && <span className="text-zinc-500">· {data.impactDepth} hop</span>}
          </span>
        )}
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
