"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, MousePointerClick, Zap } from "lucide-react";
import { Glossary } from "@/components/Glossary";
import { CodeBlock } from "@/components/inspector/CodeBlock";
import { ExportList } from "@/components/inspector/ExportList";
import { describeTrace, type Trace, type TraceMode, type TraceRole } from "@/lib/engines/provenance";
import { explainNode } from "@/lib/explain";
import type { NodeHealth } from "@/lib/engines/health";
import type { ArchitectureGraph, ArchNode } from "@/lib/types";
import { HEALTH_META, KIND_META, kindLabelFor } from "@/lib/ui";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{title}</h3>
      {children}
    </section>
  );
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <p className="text-xs text-zinc-600">{empty}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((item) => (
        <code key={item} className="rounded bg-zinc-800/80 px-1.5 py-0.5 font-mono text-[11px] text-zinc-300">
          {item}
        </code>
      ))}
    </div>
  );
}

const ROLE_LABEL: Record<TraceRole, string> = { input: "input file", produced: "intermediate", code: "code", target: "this component" };

/** Follow data flow: where this comes from, or what it affects, highlighted on the map. */
function TraceSection({ graph, nodeLabel, nodeId, trace, onTrace, onSelectNode }: { graph: ArchitectureGraph; nodeLabel: string; nodeId: string; trace: Trace | null; onTrace: (mode: TraceMode | null) => void; onSelectNode: (id: string) => void }) {
  const here = trace && trace.nodeId === nodeId ? trace : null;
  const elsewhere = trace && trace.nodeId !== nodeId ? trace : null;
  const description = here ? describeTrace(graph, here) : null;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;

  const button = (mode: TraceMode, text: string, hint: string) => (
    <button
      type="button"
      aria-pressed={here?.mode === mode}
      title={hint}
      onClick={() => onTrace(here?.mode === mode ? null : mode)}
      className={clsx(
        "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition",
        here?.mode === mode ? "border-cyan-400/70 bg-cyan-500/20 text-cyan-100" : "border-zinc-700 text-zinc-300 hover:border-cyan-500/50 hover:text-cyan-100",
      )}
    >
      {text}
    </button>
  );

  return (
    <section aria-label="Trace" className="space-y-2 rounded-lg border border-cyan-500/20 bg-cyan-500/5 p-3">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-cyan-300">Trace the data flow</h3>
      <div className="flex gap-2">
        {button("upstream", "Where it comes from", "Highlight the code and input files that produced this")}
        {button("downstream", "What it affects", "Highlight everything that uses this, and the results that would be out of date")}
      </div>

      {elsewhere && (
        <p className="text-[11px] text-zinc-400">
          The map is tracing <b className="text-zinc-200">{label(elsewhere.nodeId)}</b>.{" "}
          <button type="button" onClick={() => onTrace(null)} className="text-cyan-300 underline-offset-2 hover:underline">
            Clear trace (Esc)
          </button>
        </p>
      )}

      {here && description && (
        <div className="space-y-2">
          <p className="text-sm font-medium text-zinc-100">{description.headline}</p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">
            {description.lines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
          <ol className="divide-y divide-zinc-800/80 rounded-lg border border-zinc-800">
            {here.steps.map((step, i) => (
              <li key={step.nodeId}>
                <button type="button" onClick={() => onSelectNode(step.nodeId)} className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition hover:bg-zinc-800/40">
                  <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-cyan-500 text-[10px] font-bold text-zinc-950">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-xs text-zinc-200">{label(step.nodeId)}</span>
                  <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{ROLE_LABEL[step.role]}</span>
                </button>
              </li>
            ))}
          </ol>
          <button type="button" onClick={() => onTrace(null)} className="text-[11px] text-cyan-300 underline-offset-2 hover:underline">
            Clear trace (Esc)
          </button>
        </div>
      )}
      {!here && !elsewhere && <p className="text-[11px] leading-relaxed text-zinc-500">Pick a direction to highlight how {nodeLabel} fits into the pipeline, step by step.</p>}
    </section>
  );
}

type Props = {
  graph: ArchitectureGraph;
  node: ArchNode | undefined;
  health?: NodeHealth;
  /** The active provenance trace (for any component), and a way to start or clear one for this component. */
  trace: Trace | null;
  onTrace: (mode: TraceMode | null) => void;
  onSelectNode: (id: string) => void;
  onSimulate: (id: string, symbol?: string) => void;
};

export function NodeInspector({ graph, node, health, trace, onTrace, onSelectNode, onSimulate }: Props) {
  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-zinc-500">
        <MousePointerClick className="h-8 w-8 text-zinc-600" />
        <p className="text-sm">Select a component on the canvas to inspect its code, exports and dependencies.</p>
        <p className="text-xs text-zinc-600">Tip: drag from a node's bottom handle to another node to draft a new dependency.</p>
        <Glossary className="mt-3 w-full text-left" />
      </div>
    );
  }

  const { data } = node;
  const plain = explainNode(graph, node.id);
  // Per-export usage needs at least one importer whose symbols were read (TypeScript/JavaScript).
  const hasSymbolData = graph.edges.some((e) => e.target === node.id && e.symbols !== undefined);
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;
  const dependsOn = graph.edges.filter((e) => e.source === node.id);
  const usedBy = graph.edges.filter((e) => e.target === node.id);

  return (
    <div className="space-y-5">
      <header className="space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-zinc-50">{data.label}</h2>
            <p className="truncate font-mono text-[11px] text-zinc-500">{data.filePath}</p>
          </div>
          <span className={clsx("shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset", KIND_META[data.kind].chip)}>
            {kindLabelFor(graph, data.kind)}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-zinc-400">{data.description}</p>
        {health && (
          <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
            <span className={clsx("rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset", HEALTH_META[health.level].chip)} title="How costly and fragile this is to change (0-100). See the Health tab.">
              Change-risk {health.score}
            </span>
            {health.reasons.length > 0 ? health.reasons.join(" · ") : "Few connections, low risk."}
          </p>
        )}
        <button
          type="button"
          onClick={() => onSimulate(node.id)}
          className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/20"
        >
          <Zap className="h-3.5 w-3.5" /> Simulate a change here
        </button>
      </header>

      {plain && (
        <section aria-label="In plain words" className="space-y-1.5 rounded-lg border border-sky-500/20 bg-sky-500/5 p-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-sky-300">In plain words</h3>
          <p className="text-sm font-medium text-zinc-100">{plain.headline}</p>
          <ul className="list-disc space-y-1 pl-4 text-xs leading-relaxed text-zinc-300">
            {plain.bullets.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </section>
      )}

      <TraceSection graph={graph} nodeLabel={data.label} nodeId={node.id} trace={trace} onTrace={onTrace} onSelectNode={onSelectNode} />

      <Section title="Source">
        <CodeBlock code={data.code} title={`${data.filePath} · ${data.language}`} />
      </Section>

      <Section title="Exports">
        {data.exports.length > 0 && hasSymbolData ? (
          <ExportList graph={graph} nodeId={node.id} onSelectNode={onSelectNode} onSimulateSymbol={(symbol) => onSimulate(node.id, symbol)} />
        ) : (
          <Chips items={data.exports} empty="None detected" />
        )}
      </Section>
      <Section title="Imports">
        <Chips items={data.imports} empty="None detected" />
      </Section>

      <Section title="Parameters">
        {data.params.length === 0 ? (
          <p className="text-xs text-zinc-600">None</p>
        ) : (
          <table className="w-full text-left text-xs">
            <tbody>
              {data.params.map((p) => (
                <tr key={p.name} className="border-b border-zinc-800/70 last:border-0">
                  <td className="py-1 pr-2 font-mono text-zinc-200">{p.name}</td>
                  <td className="py-1 pr-2 font-mono text-violet-300">{p.type}</td>
                  <td className="py-1 text-zinc-500">{p.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Dependencies">
        <ul className="space-y-1 text-xs">
          {dependsOn.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => onSelectNode(e.target)} className="flex items-center gap-1.5 text-zinc-300 hover:text-white">
                <ArrowDownRight className="h-3.5 w-3.5 text-zinc-500" />
                {e.relation} <span className="font-medium">{label(e.target)}</span>
                {e.label && <span className="font-mono text-zinc-500">· {e.label}</span>}
              </button>
            </li>
          ))}
          {usedBy.map((e) => (
            <li key={e.id}>
              <button type="button" onClick={() => onSelectNode(e.source)} className="flex items-center gap-1.5 text-zinc-300 hover:text-white">
                <ArrowUpRight className="h-3.5 w-3.5 text-zinc-500" />
                used by <span className="font-medium">{label(e.source)}</span>
              </button>
            </li>
          ))}
          {dependsOn.length + usedBy.length === 0 && <li className="text-zinc-600">Isolated component</li>}
        </ul>
      </Section>
    </div>
  );
}
