"use client";

import clsx from "clsx";
import { Bot, CheckCheck, Cpu, Loader2, Radar, X } from "lucide-react";
import { DiffViewer } from "@/components/inspector/DiffViewer";
import type { AsyncStatus } from "@/hooks/useWorkspace";
import type { ArchitectureGraph, ImpactAnalysisResult } from "@/lib/types";
import { SEVERITY_META } from "@/lib/ui";

type Props = {
  graph: ArchitectureGraph;
  selectedNodeId: string | null;
  prompt: string;
  samplePrompts: string[];
  status: AsyncStatus;
  error?: string;
  result: ImpactAnalysisResult | null;
  onPromptChange: (prompt: string) => void;
  onRun: () => void;
  onClear: () => void;
  onApply: () => void;
  onSelectNode: (id: string) => void;
};

const RISK_BANDS = [
  { max: 34, label: "Low", bar: "bg-emerald-500", text: "text-emerald-300" },
  { max: 67, label: "Medium", bar: "bg-amber-500", text: "text-amber-300" },
  { max: 100, label: "High", bar: "bg-red-500", text: "text-red-300" },
];

function RiskMeter({ score }: { score: number }) {
  const band = RISK_BANDS.find((b) => score <= b.max) ?? RISK_BANDS[2]!;
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between text-xs">
        <span className="text-zinc-400">Blast-radius risk</span>
        <span className={clsx("font-semibold", band.text)}>
          {band.label} · {score}/100
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800" role="meter" aria-valuenow={score} aria-valuemin={0} aria-valuemax={100} aria-label="Risk score">
        <div className={clsx("h-full rounded-full transition-all", band.bar)} style={{ width: `${score}%` }} />
      </div>
    </div>
  );
}

export function BlastRadiusPanel(props: Props) {
  const { graph, selectedNodeId, prompt, samplePrompts, status, error, result } = props;
  const isRunning = status === "running";
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;

  return (
    <div className="space-y-5">
      <form
        className="space-y-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (!isRunning) props.onRun();
        }}
      >
        <label htmlFor="impact-prompt" className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Proposed modification
        </label>
        <textarea
          id="impact-prompt"
          value={prompt}
          onChange={(e) => props.onPromptChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
          }}
          rows={3}
          maxLength={2000}
          placeholder='e.g. "Change `userId` from integer to UUID v4"'
          className="w-full resize-none rounded-lg border border-zinc-700 bg-zinc-950/80 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-violet-500 focus:outline-none focus:ring-2 focus:ring-violet-500/30"
        />
        <div className="flex flex-wrap gap-1.5">
          {samplePrompts.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => props.onPromptChange(s)}
              className="rounded-full border border-zinc-700 px-2.5 py-0.5 text-[11px] text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-200"
            >
              {s}
            </button>
          ))}
        </div>
        <div className="flex items-center justify-between gap-2 pt-1">
          <span className="truncate text-[11px] text-zinc-500">
            Origin hint: {selectedNodeId ? <span className="text-zinc-300">{label(selectedNodeId)}</span> : "auto-detect from prompt"}
          </span>
          <button
            type="submit"
            disabled={isRunning || !prompt.trim()}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white shadow-lg shadow-red-900/30 transition hover:bg-red-500 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radar className="h-4 w-4" />}
            {isRunning ? "Analyzing…" : "Run Impact Analysis"}
          </button>
        </div>
      </form>

      {status === "error" && error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}

      {result && (
        <div className="space-y-4">
          <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                {result.engine === "claude" ? <Bot className="h-3.5 w-3.5 text-violet-400" /> : <Cpu className="h-3.5 w-3.5" />}
                {result.engine === "claude" ? "Claude analysis" : result.scenarioId ? "Local engine · authored scenario" : "Local engine · graph heuristics"}
              </span>
              <button type="button" onClick={props.onClear} className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-200">
                <X className="h-3 w-3" /> Clear
              </button>
            </div>
            <RiskMeter score={result.riskScore} />
            <p className="text-sm leading-relaxed text-zinc-300">{result.summary}</p>
          </div>

          <section className="space-y-1.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Affected components ({result.impacts.length})</h3>
            <ul className="divide-y divide-zinc-800/80 rounded-lg border border-zinc-800">
              {result.impacts.map((impact) => (
                <li key={impact.nodeId}>
                  <button type="button" onClick={() => props.onSelectNode(impact.nodeId)} className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-zinc-800/40">
                    <span className={clsx("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset", SEVERITY_META[impact.severity].chip)}>
                      {SEVERITY_META[impact.severity].label}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-zinc-200">{label(impact.nodeId)}</span>
                      <span className="block text-xs text-zinc-500">{impact.reason}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>

          <section className="space-y-1.5">
            <div className="flex items-center justify-between">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Required changes ({result.diffs.length} files)</h3>
              {result.diffs.length > 0 && (
                <button type="button" onClick={props.onApply} className="flex items-center gap-1 rounded-md bg-emerald-600/90 px-2 py-1 text-[11px] font-medium text-white hover:bg-emerald-500">
                  <CheckCheck className="h-3.5 w-3.5" /> Apply to model
                </button>
              )}
            </div>
            <DiffViewer items={result.diffs} />
          </section>
        </div>
      )}
    </div>
  );
}
