"use client";

import clsx from "clsx";
import { ArrowDownRight, ArrowUpRight, MousePointerClick, Zap } from "lucide-react";
import { CodeBlock } from "@/components/inspector/CodeBlock";
import type { ArchitectureGraph, ArchNode } from "@/lib/types";
import { KIND_META } from "@/lib/ui";

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

type Props = {
  graph: ArchitectureGraph;
  node: ArchNode | undefined;
  onSelectNode: (id: string) => void;
  onSimulate: (id: string) => void;
};

export function NodeInspector({ graph, node, onSelectNode, onSimulate }: Props) {
  if (!node) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-zinc-500">
        <MousePointerClick className="h-8 w-8 text-zinc-600" />
        <p className="text-sm">Select a component on the canvas to inspect its code, exports and dependencies.</p>
        <p className="text-xs text-zinc-600">Tip: drag from a node's bottom handle to another node to draft a new dependency.</p>
      </div>
    );
  }

  const { data } = node;
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
            {KIND_META[data.kind].label}
          </span>
        </div>
        <p className="text-sm leading-relaxed text-zinc-400">{data.description}</p>
        <button
          type="button"
          onClick={() => onSimulate(node.id)}
          className="flex items-center gap-1.5 rounded-md border border-red-500/30 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/20"
        >
          <Zap className="h-3.5 w-3.5" /> Simulate a change here
        </button>
      </header>

      <Section title="Source">
        <CodeBlock code={data.code} title={`${data.filePath} · ${data.language}`} />
      </Section>

      <div className="grid grid-cols-2 gap-4">
        <Section title="Exports">
          <Chips items={data.exports} empty="None detected" />
        </Section>
        <Section title="Imports">
          <Chips items={data.imports} empty="None detected" />
        </Section>
      </div>

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
