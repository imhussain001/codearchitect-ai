"use client";

import clsx from "clsx";
import { ArrowLeft, ArrowRight, Compass, ShieldAlert, Star } from "lucide-react";
import { useMemo } from "react";
import type { GuideRole } from "@/lib/engines/guide";
import { buildGuide } from "@/lib/engines/guide";
import type { ArchitectureGraph } from "@/lib/types";

const ROLE_STYLE: Record<GuideRole, { label: string; className: string }> = {
  entry: { label: "Start", className: "bg-emerald-500/15 text-emerald-300" },
  core: { label: "Core", className: "bg-violet-500/15 text-violet-300" },
  support: { label: "Supporting", className: "bg-zinc-700/50 text-zinc-300" },
  leaf: { label: "Detail", className: "bg-sky-500/15 text-sky-300" },
};

type Props = {
  graph: ArchitectureGraph;
  selectedNodeId: string | null;
  /** Select a component and pan/zoom the canvas to it. */
  onSelectAndCenter: (nodeId: string) => void;
};

/** A guided read of the codebase: the shape in a sentence, where to start, and a reading order. */
export function GuidePanel({ graph, selectedNodeId, onSelectAndCenter }: Props) {
  const guide = useMemo(() => buildGuide(graph), [graph]);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;
  const current = guide.path.findIndex((s) => s.nodeId === selectedNodeId);
  const go = (index: number) => {
    const step = guide.path[(index + guide.path.length) % guide.path.length];
    if (step) onSelectAndCenter(step.nodeId);
  };

  if (guide.path.length === 0) return <p className="text-sm text-zinc-500">Nothing to explain yet: the map has no components.</p>;

  return (
    <div className="space-y-4">
      <header className="space-y-2">
        <h2 className="flex items-center gap-1.5 text-sm font-semibold text-zinc-100">
          <Compass className="h-4 w-4 text-emerald-400" /> New here? Start with this map
        </h2>
        <p className="text-xs leading-relaxed text-zinc-300">{guide.headline}</p>
      </header>

      {guide.keyComponents.length > 0 && (
        <section aria-label="Most used components" className="space-y-1.5">
          <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <Star className="h-3 w-3" /> Most used
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {guide.keyComponents.map((k) => (
              <button key={k.nodeId} type="button" onClick={() => onSelectAndCenter(k.nodeId)} className="rounded-md border border-violet-500/30 bg-violet-500/10 px-2 py-1 text-[11px] text-violet-200 hover:bg-violet-500/20">
                {label(k.nodeId)} <span className="text-violet-400/80">· used by {k.usedBy}</span>
              </button>
            ))}
          </div>
        </section>
      )}

      {guide.handleWithCare.length > 0 && (
        <section aria-label="Handle with care" className="space-y-1.5">
          <h3 className="flex items-center gap-1 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
            <ShieldAlert className="h-3 w-3" /> Read carefully before changing
          </h3>
          <div className="flex flex-wrap gap-1.5">
            {guide.handleWithCare.map((id) => (
              <button key={id} type="button" onClick={() => onSelectAndCenter(id)} className="rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-200 hover:bg-amber-500/20">
                {label(id)}
              </button>
            ))}
          </div>
        </section>
      )}

      <section aria-label="Reading order" className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Suggested reading order</h3>
          <div className="flex items-center gap-1">
            <button type="button" onClick={() => go(current < 0 ? 0 : current - 1)} aria-label="Previous step" className="rounded border border-zinc-700 p-1 text-zinc-300 hover:border-zinc-500 hover:text-white">
              <ArrowLeft className="h-3 w-3" />
            </button>
            <button type="button" onClick={() => go(current + 1)} className="flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-200 hover:bg-emerald-500/20">
              {current < 0 ? "Start" : "Next"} <ArrowRight className="h-3 w-3" />
            </button>
          </div>
        </div>
        <ol className="space-y-1.5">
          {guide.path.map((step, i) => (
            <li key={step.nodeId}>
              <button
                type="button"
                onClick={() => onSelectAndCenter(step.nodeId)}
                aria-current={i === current ? "step" : undefined}
                className={clsx("w-full rounded-lg border px-2.5 py-2 text-left transition", i === current ? "border-emerald-500/50 bg-emerald-500/10" : "border-zinc-800/80 bg-zinc-900/40 hover:border-zinc-600")}
              >
                <span className="flex items-center gap-2">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-[10px] font-semibold text-zinc-300">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs font-medium text-zinc-100">{step.label}</span>
                  <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium", ROLE_STYLE[step.role].className)}>{ROLE_STYLE[step.role].label}</span>
                </span>
                <span className="mt-1 block pl-7 text-[11px] leading-relaxed text-zinc-400">{step.why}</span>
              </button>
            </li>
          ))}
        </ol>
        {guide.omitted > 0 && <p className="text-[11px] text-zinc-500">…and {guide.omitted} more component{guide.omitted === 1 ? "" : "s"} not in this path. Use search (/) to find them.</p>}
      </section>
    </div>
  );
}
