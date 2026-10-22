"use client";

import clsx from "clsx";
import { ChevronDown, Download, FileArchive, FileJson, FileText, Image as ImageIcon, Loader2, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ExportKind } from "@/hooks/useExport";

const ITEMS: ReadonlyArray<{ kind: ExportKind; label: string; hint: string; icon: typeof Download }> = [
  { kind: "png", label: "Diagram (PNG)", hint: "Image of the canvas as shown", icon: ImageIcon },
  { kind: "svg", label: "Diagram (SVG)", hint: "Vector, for slides and papers", icon: ImageIcon },
  { kind: "mermaid", label: "Mermaid (.mmd)", hint: "Paste into GitHub or Notion", icon: Workflow },
  { kind: "markdown", label: "Architecture report (.md)", hint: "Diagram, components, health, rules", icon: FileText },
  { kind: "zip", label: "Code base (.zip)", hint: "Every file, plus a restorable manifest", icon: FileArchive },
  { kind: "json", label: "Graph (.json)", hint: "Re-import into CodeArchitect", icon: FileJson },
];

export function ExportMenu({ busy, onExport }: { busy: ExportKind | null; onExport: (kind: ExportKind) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={busy !== null}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 whitespace-nowrap rounded-lg border border-zinc-700 px-2.5 py-1.5 text-xs font-medium text-zinc-300 transition hover:border-zinc-500 hover:text-white disabled:opacity-50"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export
        <ChevronDown className={clsx("h-3 w-3 transition", open && "rotate-180")} />
      </button>
      {open && (
        <div role="menu" aria-label="Export" className="absolute right-0 z-30 mt-1.5 w-64 rounded-xl border border-zinc-700 bg-zinc-900 p-1 shadow-2xl shadow-black/50">
          {ITEMS.map(({ kind, label, hint, icon: Icon }) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                onExport(kind);
              }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left hover:bg-zinc-800 focus-visible:bg-zinc-800 focus-visible:outline-none"
            >
              <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0 text-zinc-400" />
              <span className="min-w-0">
                <span className="block text-xs font-medium text-zinc-100">{label}</span>
                <span className="block text-[11px] text-zinc-500">{hint}</span>
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
