"use client";

import clsx from "clsx";
import { ChevronDown, FileCode2 } from "lucide-react";
import { useMemo, useState } from "react";
import { highlightLine, CopyButton } from "@/components/inspector/CodeBlock";
import { diffLines, type DiffLine, type DiffRow } from "@/lib/diff";
import type { DiffItem } from "@/lib/types";

const CELL_TONE: Record<DiffRow["type"], { left: string; right: string }> = {
  same: { left: "", right: "" },
  removed: { left: "bg-red-500/15", right: "bg-zinc-900/60" },
  added: { left: "bg-zinc-900/60", right: "bg-emerald-500/15" },
  changed: { left: "bg-red-500/15", right: "bg-emerald-500/15" },
};

function Cell({ line, tone, sign }: { line?: DiffLine; tone: string; sign: string }) {
  return (
    <div className={clsx("grid min-w-0 grid-cols-[2.25rem_0.75rem_1fr]", tone)}>
      <span className="select-none pr-1 text-right text-zinc-600">{line?.lineNo ?? ""}</span>
      <span className="select-none text-zinc-500">{line && tone ? sign : ""}</span>
      <span className="whitespace-pre pr-3 text-zinc-200">{line ? highlightLine(line.text) : ""}</span>
    </div>
  );
}

function DiffCard({ item, defaultOpen }: { item: DiffItem; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const { rows, stats } = useMemo(() => diffLines(item.before, item.after), [item.before, item.after]);

  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/70">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 bg-zinc-900/70 px-3 py-2 text-left transition hover:bg-zinc-800/70"
      >
        <ChevronDown className={clsx("h-3.5 w-3.5 shrink-0 text-zinc-500 transition", !open && "-rotate-90")} />
        <FileCode2 className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-zinc-200">{item.filePath}</span>
        <span className="font-mono text-[11px] text-emerald-400">+{stats.added}</span>
        <span className="font-mono text-[11px] text-red-400">−{stats.removed}</span>
      </button>
      {open && (
        <>
          <div className="flex items-start justify-between gap-2 border-y border-zinc-800 px-3 py-1.5 text-[11px] text-zinc-400">
            <span>{item.rationale}</span>
            <CopyButton text={item.after} label="Copy new" />
          </div>
          <div className="grid grid-cols-2 border-b border-zinc-800 bg-zinc-900/40 text-[10px] uppercase tracking-wider text-zinc-500">
            <span className="px-3 py-1">Before</span>
            <span className="border-l border-zinc-800 px-3 py-1">After</span>
          </div>
          <div className="scrollbar-thin max-h-[360px] overflow-auto font-mono text-[11px] leading-5">
            {rows.map((row, i) => (
              <div key={i} className="grid grid-cols-2">
                <Cell line={row.left} tone={CELL_TONE[row.type].left} sign="−" />
                <div className="border-l border-zinc-800">
                  <Cell line={row.right} tone={CELL_TONE[row.type].right} sign="+" />
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export function DiffViewer({ items }: { items: DiffItem[] }) {
  if (items.length === 0) return <p className="text-xs text-zinc-500">No file changes proposed.</p>;
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <DiffCard key={`${item.nodeId}-${item.filePath}`} item={item} defaultOpen={i === 0} />
      ))}
    </div>
  );
}
