"use client";

import clsx from "clsx";
import { CheckCheck, FilePlus2, Loader2, Plus, Trash2, Wand2 } from "lucide-react";
import { useState } from "react";
import { CodeBlock } from "@/components/inspector/CodeBlock";
import { DiffViewer } from "@/components/inspector/DiffViewer";
import type { AsyncStatus } from "@/hooks/useWorkspace";
import { suggestFilePath } from "@/lib/engines/localScaffold";
import type { ArchitectureGraph, NodeKind, ScaffoldResult } from "@/lib/types";
import { KIND_META } from "@/lib/ui";

type Props = {
  graph: ArchitectureGraph;
  status: AsyncStatus;
  error?: string;
  result: ScaffoldResult | null;
  onAddComponent: (input: { label: string; kind: NodeKind; filePath: string; description: string }) => void;
  onRemoveDraft: (nodeId: string) => void;
  onRemoveEdge: (edgeId: string) => void;
  onGenerate: () => void;
  onApply: () => void;
};

const KINDS = Object.keys(KIND_META) as NodeKind[];

export function BuilderPanel({ graph, status, error, result, ...actions }: Props) {
  const [label, setLabel] = useState("");
  const [kind, setKind] = useState<NodeKind>("frontend");
  const [description, setDescription] = useState("");
  const [customPath, setCustomPath] = useState<string | null>(null);

  const filePath = customPath ?? (label.trim() ? suggestFilePath(label, kind) : "");
  const drafts = graph.nodes.filter((n) => n.data.isDraft);
  const draftEdges = graph.edges.filter((e) => e.isDraft);
  const name = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;
  const hasWork = drafts.length > 0 || draftEdges.length > 0;

  return (
    <div className="space-y-5">
      <form
        className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (!label.trim()) return;
          actions.onAddComponent({ label: label.trim(), kind, filePath, description: description.trim() || `New ${KIND_META[kind].label.toLowerCase()} component.` });
          setLabel("");
          setDescription("");
          setCustomPath(null);
        }}
      >
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Add component</h3>
        <div className="grid grid-cols-4 gap-1">
          {KINDS.map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
              className={clsx("rounded-md border px-1.5 py-1 text-[10px] font-medium transition", kind === k ? `${KIND_META[k].border} ${KIND_META[k].text} bg-zinc-800` : "border-zinc-800 text-zinc-500 hover:text-zinc-300")}
            >
              {KIND_META[k].label}
            </button>
          ))}
        </div>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder='Name, e.g. "Export PDF Button"'
          maxLength={80}
          className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none"
        />
        <input
          value={filePath}
          onChange={(e) => setCustomPath(e.target.value)}
          placeholder="File path"
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1 font-mono text-[11px] text-zinc-400 placeholder:text-zinc-700 focus:border-violet-500 focus:outline-none"
        />
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What should it do? (helps the AI model)"
          maxLength={300}
          className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-2.5 py-1 text-xs text-zinc-300 placeholder:text-zinc-700 focus:border-violet-500 focus:outline-none"
        />
        <button type="submit" disabled={!label.trim()} className="flex items-center gap-1.5 rounded-md bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-900 hover:bg-white disabled:opacity-40">
          <Plus className="h-3.5 w-3.5" /> Add to canvas
        </button>
        <p className="text-[11px] text-zinc-500">Then drag from a node&apos;s bottom handle to another node&apos;s top handle: the source will depend on the target.</p>
      </form>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Draft changes</h3>
        {!hasWork && <p className="text-xs text-zinc-600">Nothing drafted yet.</p>}
        <ul className="space-y-1">
          {drafts.map((n) => (
            <li key={n.id} className="flex items-center justify-between rounded-md border border-dashed border-fuchsia-500/40 bg-fuchsia-500/5 px-2.5 py-1.5 text-xs">
              <span className="flex items-center gap-1.5 text-fuchsia-200">
                <FilePlus2 className="h-3.5 w-3.5" /> {n.data.label}
                <span className="font-mono text-[10px] text-zinc-500">{n.data.filePath}</span>
              </span>
              <button type="button" aria-label={`Remove ${n.data.label}`} onClick={() => actions.onRemoveDraft(n.id)} className="text-zinc-500 hover:text-red-400">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
          {draftEdges.map((e) => (
            <li key={e.id} className="flex items-center justify-between rounded-md border border-zinc-800 px-2.5 py-1.5 text-xs text-zinc-300">
              <span>
                {name(e.source)} <span className="text-fuchsia-400">→</span> {name(e.target)}
              </span>
              <button type="button" aria-label="Remove connection" onClick={() => actions.onRemoveEdge(e.id)} className="text-zinc-500 hover:text-red-400">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          onClick={actions.onGenerate}
          disabled={!hasWork || status === "running"}
          className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-lg bg-fuchsia-600 px-3 py-1.5 text-sm font-medium text-white shadow-lg shadow-fuchsia-900/30 hover:bg-fuchsia-500 disabled:opacity-40"
        >
          {status === "running" ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
          {status === "running" ? "Generating…" : "Generate glue code"}
        </button>
        {status === "error" && error && <p className="text-xs text-red-300">{error}</p>}
      </section>

      {result && (
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-zinc-400">
              {result.summary} <span className="text-zinc-600">({result.engine === "ai" ? result.engineLabel ?? "AI" : "templates"})</span>
            </p>
            <button type="button" onClick={actions.onApply} className="flex shrink-0 items-center gap-1 rounded-md bg-emerald-600/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500">
              <CheckCheck className="h-3.5 w-3.5" /> Apply
            </button>
          </div>
          {result.files.map((f) => (
            <CodeBlock key={f.path} code={f.content} title={`new · ${f.path}`} />
          ))}
          {result.diffs.length > 0 && <DiffViewer items={result.diffs} />}
        </section>
      )}
    </div>
  );
}
