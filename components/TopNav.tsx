"use client";

import clsx from "clsx";
import { Bot, ChevronDown, Cpu, FolderGit2, HelpCircle, History, Network, Radar, RotateCcw } from "lucide-react";
import { ExportMenu } from "@/components/ExportMenu";
import type { SaveStatus } from "@/hooks/useAutosave";
import type { ExportKind } from "@/hooks/useExport";
import type { ArchitectureGraph, EngineInfo } from "@/lib/types";

export const CUSTOM_UPLOAD_OPTION = "__custom_upload__";

type Props = {
  graph: ArchitectureGraph;
  samples: readonly ArchitectureGraph[];
  importedGraph: ArchitectureGraph | null;
  engine: EngineInfo | null;
  isStoryOn: boolean;
  isImpactActive: boolean;
  exporting: ExportKind | null;
  saveStatus: SaveStatus;
  /** True when the graph differs from its original (so Reset has something to undo). */
  isEdited: boolean;
  onReset: () => void;
  onSelectRepository: (id: string) => void;
  onSimulate: () => void;
  onToggleStory: () => void;
  onExport: (kind: ExportKind) => void;
  onHelp: () => void;
};

function NavButton({ onClick, active, disabled, children, tone, tour, title }: { onClick: () => void; active?: boolean; disabled?: boolean; children: React.ReactNode; tone: "red" | "violet" | "zinc"; tour?: string; title?: string }) {
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
      data-tour={tour}
      title={title}
      className={clsx("flex items-center gap-1.5 whitespace-nowrap rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50", tones[tone])}
    >
      {children}
    </button>
  );
}

export function TopNav(props: Props) {
  const { graph, samples, importedGraph, engine } = props;

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-zinc-800/80 bg-zinc-950/80 px-3 py-2 backdrop-blur-xl sm:gap-3 sm:px-4 sm:py-2.5">
      <div className="flex items-center gap-2.5">
        <div className="rounded-lg bg-gradient-to-br from-violet-500 to-sky-500 p-1.5 shadow-lg shadow-violet-900/40">
          <Network className="h-4 w-4 text-white" />
        </div>
        <div className="leading-tight">
          <h1 className="text-sm font-semibold tracking-tight text-zinc-50">CodeArchitect AI</h1>
          <p className="hidden text-[10px] text-zinc-500 sm:block">Dependency maps · blast radius · time machine</p>
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
          engine?.engine === "ai" ? "bg-violet-500/10 text-violet-300 ring-violet-500/30" : "bg-zinc-800 text-zinc-400 ring-zinc-700",
        )}
        title={
          engine?.engine === "ai"
            ? `AI analysis by ${engine.label}`
            : engine?.error
              ? `AI provider misconfigured: ${engine.error}`
              : "Deterministic local engine — set AI_PROVIDER (e.g. ollama) or a provider API key to enable AI"
        }
      >
        {engine?.engine === "ai" ? <Bot className="h-3 w-3" /> : <Cpu className="h-3 w-3" />}
        <span className="max-w-[180px] truncate">{engine ? (engine.engine === "ai" ? engine.label : "Local engine") : "…"}</span>
      </span>

      <div className="flex items-center gap-2 text-[11px] text-zinc-500" aria-live="polite">
        {props.saveStatus === "saving" && <span className="hidden sm:inline">Saving…</span>}
        {props.saveStatus === "saved" && <span className="hidden sm:inline" title="Your edits are stored in this browser only">Saved in this browser</span>}
        {props.saveStatus === "unavailable" && <span className="text-amber-400/80" title="Browser storage is unavailable, so edits will not survive a reload">Not saving</span>}
        {props.isEdited && (
          <button type="button" onClick={props.onReset} title="Discard your edits and return to the original" className="flex items-center gap-1 rounded-md border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:border-zinc-500 hover:text-white">
            <RotateCcw className="h-3 w-3" /> Reset
          </button>
        )}
      </div>

      <div className="ml-auto flex flex-wrap items-center gap-2">
        <NavButton tone="red" tour="simulate" title="Describe a change and see what it would break" active={props.isImpactActive} onClick={props.onSimulate}>
          <Radar className="h-3.5 w-3.5" /> <span className="sm:hidden">Simulate</span>
          <span className="hidden sm:inline">Simulate Blast Radius</span>
        </NavButton>
        <NavButton tone="violet" tour="story" title="Replay how the architecture evolved, commit by commit" active={props.isStoryOn} onClick={props.onToggleStory}>
          <History className="h-3.5 w-3.5" /> <span className="sm:hidden">Story</span>
          <span className="hidden sm:inline">Toggle Time-Machine Story</span>
        </NavButton>
        <ExportMenu busy={props.exporting} onExport={props.onExport} />
        <NavButton tone="zinc" tour="help" title="Show the guided tour (?)" onClick={props.onHelp}>
          <HelpCircle className="h-3.5 w-3.5" />
          <span className="sr-only">Show the guided tour</span>
        </NavButton>
      </div>
    </header>
  );
}
