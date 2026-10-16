"use client";

import clsx from "clsx";
import { Bot, ChevronDown, Cpu, Download, FolderGit2, History, Loader2, Network, Radar } from "lucide-react";
import type { ArchitectureGraph, EngineKind } from "@/lib/types";

export const CUSTOM_UPLOAD_OPTION = "__custom_upload__";

type Props = {
  graph: ArchitectureGraph;
  samples: readonly ArchitectureGraph[];
  importedGraph: ArchitectureGraph | null;
  engine: { engine: EngineKind; model: string | null } | null;
  isStoryOn: boolean;
  isImpactActive: boolean;
  isExporting: boolean;
  onSelectRepository: (id: string) => void;
  onSimulate: () => void;
  onToggleStory: () => void;
  onExport: () => void;
};

function NavButton({ onClick, active, disabled, children, tone }: { onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode; tone: "red" | "violet" | "zinc" }) {
  const tones = {
    red: active ? "border-red-500/60 bg-red-500/15 text-red-200" : "border-zinc-700 text-zinc-300 hover:border-red-500/50 hover:text-red-200",
    violet: active ? "border-violet-500/60 bg-violet-500/15 text-violet-200" : "border-zinc-700 text-zinc-300 hover:border-violet-500/50 hover:text-violet-200",
    zinc: "border-zinc-700 text-zinc-300 hover:border-zinc-500 hover:text-white",
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={clsx("flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50", tones[tone])}
    >
      {children}
    </button>
  );
}

export function TopNav(props: Props) {
  const { graph, samples, importedGraph, engine } = props;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-3 border-b border-zinc-800/80 bg-zinc-950/80 px-4 py-2.5 backdrop-blur-xl">
      <div className="flex items-center gap-2.5">
        <div className="rounded-lg bg-gradient-to-br from-violet-500 to-sky-500 p-1.5 shadow-lg shadow-violet-900/40">
          <Network className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-50">CodeArchitect AI</h1>
          <p className="text-[10px] text-zinc-500">Dependency maps · blast radius · time machine</p>
        </div>
      </div>

      <div className="mx-1 hidden h-6 w-px bg-zinc-800 sm:block" />

      <label className="relative flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900/70 py-1 pl-2.5 pr-1 text-xs text-zinc-300">
        <FolderGit2 className="h-3.5 w-3.5 text-zinc-500" />
        <span className="sr-only">Active repository</span>
        <select
          value={graph.id}
          onChange={(e) => props.onSelectRepository(e.target.value)}
          className="max-w-[220px] cursor-pointer appearance-none bg-transparent pr-6 font-medium text-zinc-100 focus:outline-none"
        >
          {samples.map((s) => (
            <option key={s.id} value={s.id} className="bg-zinc-900">
              {s.name}
            </option>
          ))}
          {importedGraph && (
            <option value={importedGraph.id} className="bg-zinc-900">
              {importedGraph.name}
            </option>
          )}
          <option value={CUSTOM_UPLOAD_OPTION} className="bg-zinc-900">
            Custom Upload…
          </option>
        </select>
        <ChevronDown className="pointer-events-none absolute right-2 h-3.5 w-3.5 text-zinc-500" />
      </label>

      <span
        className={clsx(
          "flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ring-1 ring-inset",
          engine?.engine === "claude" ? "bg-violet-500/10 text-violet-300 ring-violet-500/30" : "bg-zinc-800 text-zinc-400 ring-zinc-700",
        )}
        title={engine?.engine === "claude" ? `Analysis by ${engine.model}` : "Deterministic local engine (set ANTHROPIC_API_KEY to enable Claude)"}
      >
        {engine?.engine === "claude" ? <Bot className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
        {engine ? (engine.engine === "claude" ? "Claude" : "Local engine") : "…"}
      </span>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <NavButton tone="red" active={props.isImpactActive} onClick={props.onSimulate}>
          <Radar className="h-3.5 w-3.5" /> Simulate Blast Radius
        </NavButton>
        <NavButton tone="violet" active={props.isStoryOn} onClick={props.onToggleStory}>
          <History className="h-3.5 w-3.5" /> Toggle Time-Machine Story
        </NavButton>
        <NavButton tone="zinc" onClick={props.onExport} disabled={props.isExporting}>
          {props.isExporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Export Code Base
        </NavButton>
      </div>
    </header>
  );
}
