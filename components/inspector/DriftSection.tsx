"use client";

import clsx from "clsx";
import { TrendingDown, TrendingUp, Minus } from "lucide-react";
import { useMemo } from "react";
import { analyzeDrift, REGRESSION_MIN_DROP, type DriftStep } from "@/lib/engines/drift";
import type { DriftPoint } from "@/lib/types";

const W = 320;
const H = 110;
const PAD = { left: 28, right: 8, top: 8, bottom: 16 };
const MIN_Y_SPAN = 10;

const signed = (n: number) => (n === 0 ? "±0" : n > 0 ? `+${n}` : `−${Math.abs(n)}`);
const day = (iso: string) => iso.slice(0, 10);

function Chart({ steps }: { steps: DriftStep[] }) {
  const scores = steps.map((s) => s.score);
  const lo = Math.max(0, Math.floor(Math.min(...scores) / 5) * 5 - 5);
  const hi = Math.min(100, Math.max(Math.ceil(Math.max(...scores) / 5) * 5 + 5, lo + MIN_Y_SPAN));
  const x = (i: number) => PAD.left + (steps.length === 1 ? (W - PAD.left - PAD.right) / 2 : (i / (steps.length - 1)) * (W - PAD.left - PAD.right));
  const y = (score: number) => PAD.top + (1 - (score - lo) / (hi - lo)) * (H - PAD.top - PAD.bottom);
  const line = steps.map((s, i) => `${i === 0 ? "M" : "L"} ${x(i).toFixed(1)} ${y(s.score).toFixed(1)}`).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Health score from ${scores[0]} to ${scores.at(-1)} over ${steps.length} commits`} className="w-full">
      {[lo, (lo + hi) / 2, hi].map((tick) => (
        <g key={tick}>
          <line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="#27272a" strokeDasharray="3 3" />
          <text x={PAD.left - 4} y={y(tick) + 3} textAnchor="end" fontSize="9" fill="#71717a">
            {Math.round(tick)}
          </text>
        </g>
      ))}
      <path d={line} fill="none" stroke="#a78bfa" strokeWidth="1.8" strokeLinejoin="round" />
      {steps.map((s, i) => {
        const bad = i > 0 && (s.scoreDelta <= -REGRESSION_MIN_DROP || s.cyclesDelta > 0 || s.violationsDelta > 0);
        return (
          <circle key={s.hash} cx={x(i)} cy={y(s.score)} r={bad ? 4 : 2.5} fill={bad ? "#ef4444" : "#a78bfa"} stroke="#09090b" strokeWidth="1">
            <title>{`${s.hash.slice(0, 7)} · ${day(s.date)}\n${s.message}\nhealth ${s.score} (${signed(s.scoreDelta)}), ${s.cycles} cycles, ${s.violations} violations`}</title>
          </circle>
        );
      })}
      <text x={PAD.left} y={H - 3} fontSize="9" fill="#71717a">
        {day(steps[0]!.date)}
      </text>
      <text x={W - PAD.right} y={H - 3} textAnchor="end" fontSize="9" fill="#71717a">
        {day(steps.at(-1)!.date)}
      </text>
    </svg>
  );
}

/** Health over time, with the commits that made it worse. Shown when the graph carries `drift`. */
export function DriftSection({ drift }: { drift: DriftPoint[] }) {
  const report = useMemo(() => analyzeDrift(drift), [drift]);
  if (report.steps.length === 0 || !report.first || !report.last) return null;
  const Icon = report.trend === "improving" ? TrendingUp : report.trend === "declining" ? TrendingDown : Minus;
  const tone = report.trend === "improving" ? "text-emerald-300" : report.trend === "declining" ? "text-red-300" : "text-zinc-300";

  return (
    <section aria-label="Architecture drift" className="space-y-2 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
      <h3 className="flex items-center justify-between text-[11px] font-semibold uppercase tracking-wider text-zinc-500">
        Health over time
        <span className={clsx("flex items-center gap-1 text-xs normal-case tracking-normal", tone)}>
          <Icon className="h-3.5 w-3.5" /> {report.first.grade} · {report.first.score} → {report.last.grade} · {report.last.score} ({signed(report.netScoreDelta)})
        </span>
      </h3>
      <Chart steps={report.steps} />
      {report.regressions.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[11px] text-zinc-500">Commits that made it worse</p>
          <ul className="space-y-1">
            {report.regressions.map((s) => (
              <li key={s.hash} className="text-[11px] leading-snug text-zinc-300">
                <code className="mr-1 rounded bg-zinc-800 px-1 font-mono text-red-300">{s.hash.slice(0, 7)}</code>
                {s.message}
                <span className="text-zinc-500">
                  {" "}
                  · health {signed(s.scoreDelta)}
                  {s.cyclesDelta > 0 ? `, +${s.cyclesDelta} cycle${s.cyclesDelta === 1 ? "" : "s"}` : ""}
                  {s.violationsDelta > 0 ? `, +${s.violationsDelta} rule violation${s.violationsDelta === 1 ? "" : "s"}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="text-[11px] text-zinc-500">No commit made the architecture noticeably worse.</p>
      )}
    </section>
  );
}
