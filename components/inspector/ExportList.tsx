"use client";

import { Zap } from "lucide-react";
import { exportUsage } from "@/lib/engines/symbols";
import type { ArchitectureGraph } from "@/lib/types";

type Props = {
  graph: ArchitectureGraph;
  nodeId: string;
  onSelectNode: (id: string) => void;
  /** Start a blast-radius simulation for one export. */
  onSimulateSymbol: (symbol: string) => void;
};

/** Each export with who uses it. Exports nothing in the map uses are flagged. */
export function ExportList({ graph, nodeId, onSelectNode, onSimulateSymbol }: Props) {
  const usage = exportUsage(graph, nodeId);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;
  const hasImporters = graph.edges.some((e) => !e.isDraft && e.target === nodeId && e.relation === "imports");

  return (
    <ul className="space-y-1.5">
      {usage.map(({ name, users, uncertain }) => {
        const bare = name.replace(/^default\s+/, "");
        return (
          <li key={name} className="rounded-md border border-zinc-800/80 bg-zinc-900/40 px-2 py-1.5">
            <div className="flex items-center justify-between gap-2">
              <code className="truncate font-mono text-[11px] text-zinc-200">{name}</code>
              <button
                type="button"
                onClick={() => onSimulateSymbol(bare)}
                title={`Simulate changing ${bare}: only the files that use it are affected`}
                className="flex shrink-0 items-center gap-1 rounded border border-red-500/30 px-1.5 py-0.5 text-[10px] text-red-300 hover:bg-red-500/15"
              >
                <Zap className="h-3 w-3" /> Simulate
              </button>
            </div>
            {users.length === 0 ? (
              <p className="mt-0.5 text-[11px] text-amber-400/90">{hasImporters ? "No mapped file uses this (tests and scripts are not mapped, so check them before deleting)." : "Not imported by any mapped file."}</p>
            ) : (
              <details className="mt-0.5">
                <summary className="cursor-pointer text-[11px] text-zinc-500 hover:text-zinc-300">
                  {uncertain ? "may be used by" : "used by"} {users.length} component{users.length === 1 ? "" : "s"}
                </summary>
                <div className="mt-1 flex flex-wrap gap-1">
                  {users.map((id) => (
                    <button key={id} type="button" onClick={() => onSelectNode(id)} className="rounded bg-zinc-800 px-1.5 py-0.5 text-[11px] text-sky-300 hover:bg-zinc-700">
                      {label(id)}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </li>
        );
      })}
    </ul>
  );
}
