"use client";

import clsx from "clsx";
import { AlertTriangle, CircleCheck, Info, ShieldAlert } from "lucide-react";
import { useState } from "react";
import { Glossary } from "@/components/Glossary";
import { riskiestNodes, type HealthIssue, type HealthReport, type HealthSeverity } from "@/lib/engines/health";
import { EXAMPLE_RULES_JSON, parseRulesJson } from "@/lib/rulesSchema";
import type { ArchRule, ArchitectureGraph, RuleViolation } from "@/lib/types";
import { HEALTH_META } from "@/lib/ui";

const SEVERITY_CHIP: Record<HealthSeverity, string> = {
  high: "bg-red-500/15 text-red-300 ring-red-500/40",
  medium: "bg-amber-500/15 text-amber-300 ring-amber-500/40",
  low: "bg-zinc-700/40 text-zinc-300 ring-zinc-600/60",
};

const GRADE_TONE: Record<HealthReport["grade"], string> = {
  A: "text-emerald-300 ring-emerald-500/50",
  B: "text-emerald-300 ring-emerald-500/40",
  C: "text-amber-300 ring-amber-500/50",
  D: "text-orange-300 ring-orange-500/50",
  F: "text-red-300 ring-red-500/60",
};

type Props = {
  graph: ArchitectureGraph;
  report: HealthReport;
  selectedNodeId: string | null;
  onSelectNode: (nodeId: string) => void;
  rules: ArchRule[] | undefined;
  violations: RuleViolation[];
  onSetRules: (rules: ArchRule[]) => void;
};

/** Rules editor: what this architecture must never do, checked live against the map. */
function RulesSection({ graph, rules, violations, onSelectNode, onSetRules }: Pick<Props, "graph" | "rules" | "violations" | "onSelectNode" | "onSetRules">) {
  const [text, setText] = useState(() => (rules && rules.length ? JSON.stringify(rules, null, 2) : ""));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const errors = violations.filter((v) => v.severity === "error").length;

  const apply = () => {
    const parsed = text.trim() === "" ? { ok: true as const, rules: [] as ArchRule[] } : parseRulesJson(text);
    if (!parsed.ok) {
      setError(parsed.error);
      setSaved(false);
      return;
    }
    setError(null);
    setSaved(true);
    onSetRules(parsed.rules);
  };

  return (
    <section className="space-y-1.5" aria-label="Architecture rules">
      <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        <ShieldAlert className="h-3.5 w-3.5" /> Rules {rules?.length ? `(${rules.length})` : ""}
        {errors > 0 && <span className="rounded bg-orange-500/20 px-1.5 text-[10px] font-semibold normal-case text-orange-300">{errors} broken</span>}
      </h3>

      {rules?.length ? (
        violations.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
            <CircleCheck className="h-4 w-4" /> All {rules.length} rule{rules.length === 1 ? "" : "s"} satisfied.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800/80 rounded-lg border border-orange-500/30">
            {violations.map((v, i) => (
              <li key={`${v.ruleId}-${i}`}>
                <button type="button" onClick={() => v.nodeIds[0] && onSelectNode(v.nodeIds[0])} className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-zinc-800/40">
                  <span className={clsx("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset", v.severity === "error" ? "bg-orange-500/15 text-orange-300 ring-orange-500/40" : "bg-zinc-700/40 text-zinc-300 ring-zinc-600/60")}>
                    {v.severity}
                  </span>
                  <span className="min-w-0">
                    <span className="block text-xs font-medium text-zinc-200">{v.message}</span>
                    <span className="block font-mono text-[10px] text-zinc-500">rule: {v.ruleId}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )
      ) : (
        <p className="rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-xs leading-relaxed text-zinc-400">
          Rules state what this architecture must <b className="text-zinc-200">never</b> do, for example “the UI must not touch the database directly”. Broken rules are
          highlighted on the map and listed here. Add some below.
        </p>
      )}

      <details className="rounded-lg border border-zinc-800 bg-zinc-900/30 text-xs text-zinc-400" open={!rules?.length}>
        <summary className="cursor-pointer px-3 py-2 text-zinc-300">Edit rules</summary>
        <div className="space-y-2 border-t border-zinc-800 p-3">
          <textarea
            value={text}
            onChange={(e) => {
              setText(e.target.value);
              setSaved(false);
            }}
            rows={9}
            spellCheck={false}
            aria-label="Rules as JSON"
            placeholder={EXAMPLE_RULES_JSON}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-700 focus:border-violet-500 focus:outline-none"
          />
          {error && <p role="alert" className="rounded border border-red-500/30 bg-red-500/10 px-2 py-1 text-red-300">{error}</p>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={apply} className="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500">
              Apply rules
            </button>
            <button type="button" onClick={() => { setText(EXAMPLE_RULES_JSON); setError(null); setSaved(false); }} className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800">
              Insert example
            </button>
            {saved && <span className="text-emerald-300">Applied</span>}
          </div>
          <p className="leading-relaxed">
            Types: <code className="text-zinc-300">forbid</code> (from → to), <code className="text-zinc-300">no-cycles</code>, <code className="text-zinc-300">max-dependents</code>,{" "}
            <code className="text-zinc-300">max-lines</code>. Selectors: <code className="text-zinc-300">kind:frontend</code>, <code className="text-zinc-300">path:src/ui/**</code>,{" "}
            <code className="text-zinc-300">label:Users*</code>, <code className="text-zinc-300">id:…</code>, <code className="text-zinc-300">*</code>; join alternatives with{" "}
            <code className="text-zinc-300">|</code>. Add <code className="text-zinc-300">&quot;severity&quot;: &quot;warn&quot;</code> for advice instead of an error. The same rules can live in a{" "}
            <code className="text-zinc-300">.codearchitect.json</code> file for the command-line check.
          </p>
          <p className="text-zinc-600">Graph: {graph.name}</p>
        </div>
      </details>
    </section>
  );
}

function summarize(report: HealthReport): string {
  const { cycles, hubs, layering, large, orphans } = report.counts;
  const parts = [
    cycles && `${cycles} circular ${cycles === 1 ? "dependency" : "dependencies"}`,
    layering && `${layering} crossed ${layering === 1 ? "layer" : "layers"}`,
    hubs && `${hubs} ${hubs === 1 ? "hub" : "hubs"}`,
    large && `${large} large ${large === 1 ? "file" : "files"}`,
    orphans && `${orphans} unconnected ${orphans === 1 ? "component" : "components"}`,
  ].filter(Boolean);
  return parts.length ? `Found ${parts.join(", ")}.` : "No structural problems found.";
}

function IssueRow({ issue, onSelectNode }: { issue: HealthIssue; onSelectNode: (id: string) => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={() => issue.nodeIds[0] && onSelectNode(issue.nodeIds[0])}
        className="flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-zinc-800/40"
      >
        <span className={clsx("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase ring-1 ring-inset", SEVERITY_CHIP[issue.severity])}>{issue.severity}</span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-zinc-200">{issue.title}</span>
          <span className="block text-xs leading-relaxed text-zinc-500">{issue.detail}</span>
        </span>
      </button>
    </li>
  );
}

export function HealthPanel({ graph, report, selectedNodeId, onSelectNode, rules, violations, onSetRules }: Props) {
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;
  const risky = riskiestNodes(report, 5);

  return (
    <div className="space-y-5">
      <div className="flex items-center gap-4 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div
          className={clsx("flex h-16 w-16 shrink-0 flex-col items-center justify-center rounded-full bg-zinc-950 ring-4", GRADE_TONE[report.grade])}
          role="img"
          aria-label={`Architecture health grade ${report.grade}, ${report.overall} out of 100`}
        >
          <span className="text-2xl font-bold leading-none">{report.grade}</span>
          <span className="text-[10px] text-zinc-500">{report.overall}/100</span>
        </div>
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-semibold text-zinc-100">Architecture health</h2>
          <p className="text-xs leading-relaxed text-zinc-400">{summarize(report)}</p>
        </div>
      </div>

      <p className="flex items-start gap-2 rounded-lg border border-zinc-800 bg-zinc-900/30 px-3 py-2 text-[11px] leading-relaxed text-zinc-500">
        <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>
          The canvas now shows each component&apos;s <b className="text-zinc-300">change-risk</b>: how costly and fragile it is to change, judged only from structure
          (who depends on whom, file size). It does not judge code quality.
        </span>
      </p>

      <div className="flex flex-wrap gap-3 text-[11px] text-zinc-400">
        {(Object.keys(HEALTH_META) as Array<keyof typeof HEALTH_META>).map((level) => (
          <span key={level} className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: HEALTH_META[level].hex }} />
            {HEALTH_META[level].label}
          </span>
        ))}
        <span className="flex items-center gap-1.5">
          <span className="h-0.5 w-4 bg-rose-500" /> Circular dependency
        </span>
      </div>

      <section className="space-y-1.5">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Riskiest components</h3>
        {risky.length === 0 ? (
          <p className="text-xs text-zinc-600">Nothing stands out.</p>
        ) : (
          <ul className="divide-y divide-zinc-800/80 rounded-lg border border-zinc-800">
            {risky.map((n) => (
              <li key={n.nodeId}>
                <button
                  type="button"
                  onClick={() => onSelectNode(n.nodeId)}
                  aria-current={selectedNodeId === n.nodeId}
                  className={clsx("flex w-full items-start gap-2 px-3 py-2 text-left transition hover:bg-zinc-800/40", selectedNodeId === n.nodeId && "bg-zinc-800/50")}
                >
                  <span className={clsx("mt-0.5 shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold ring-1 ring-inset", HEALTH_META[n.level].chip)}>{n.score}</span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-zinc-200">{label(n.nodeId)}</span>
                    <span className="block text-xs text-zinc-500">{n.reasons.join(" · ") || "Connected to a few components"}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-1.5">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
          Things to look at ({report.issues.length})
        </h3>
        {report.issues.length === 0 ? (
          <p className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-300">
            <CircleCheck className="h-4 w-4" /> No circular dependencies, crossed layers, hubs or oversized files.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-800/80 rounded-lg border border-zinc-800">
            {report.issues.map((issue) => (
              <IssueRow key={issue.id} issue={issue} onSelectNode={onSelectNode} />
            ))}
          </ul>
        )}
      </section>

      <RulesSection key={graph.id} graph={graph} rules={rules} violations={violations} onSelectNode={onSelectNode} onSetRules={onSetRules} />

      <details className="rounded-lg border border-zinc-800 bg-zinc-900/30 text-xs text-zinc-400">
        <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-zinc-300">
          <AlertTriangle className="h-3.5 w-3.5" /> How are these numbers calculated?
        </summary>
        <div className="space-y-2 border-t border-zinc-800 px-3 py-2 leading-relaxed">
          <p>
            <b className="text-zinc-300">Risk (0–100)</b> per component = 8 per component that depends on it (up to 40) + 3 per thing it depends on (up to 15) + 1 per 20 lines
            (up to 20) + 30 if it is in a circular dependency + 15 if it crosses layers. Under 35 is healthy, 35–64 watch, 65+ risky.
          </p>
          <p>
            <b className="text-zinc-300">Overall</b> starts at 100 and loses 12 per cycle, 8 per crossed layer, 5 per hub, 4 per large file and 2 per unconnected component.
            A ≥ 85, B ≥ 70, C ≥ 55, D ≥ 40, otherwise F.
          </p>
          <p>These are heuristics for finding where to look first, not a verdict.</p>
        </div>
      </details>

      <Glossary />
    </div>
  );
}
