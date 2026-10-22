import type { ArchitectureGraph, HealthLevel, ImpactSeverity, NodeKind, NodeStatus } from "@/lib/types";

export const KIND_META: Record<NodeKind, { label: string; border: string; text: string; chip: string; hex: string }> = {
  frontend: { label: "Frontend / UI", border: "border-sky-500/70", text: "text-sky-300", chip: "bg-sky-500/10 text-sky-300 ring-sky-500/30", hex: "#0ea5e9" },
  api: { label: "API Route", border: "border-emerald-500/70", text: "text-emerald-300", chip: "bg-emerald-500/10 text-emerald-300 ring-emerald-500/30", hex: "#10b981" },
  logic: { label: "Business Logic", border: "border-violet-500/70", text: "text-violet-300", chip: "bg-violet-500/10 text-violet-300 ring-violet-500/30", hex: "#8b5cf6" },
  data: { label: "Database / Cache", border: "border-amber-500/70", text: "text-amber-300", chip: "bg-amber-500/10 text-amber-300 ring-amber-500/30", hex: "#f59e0b" },
};

export const STATUS_META: Record<NodeStatus, { label: string; dot: string; glow: string; text: string }> = {
  normal: { label: "Normal", dot: "bg-emerald-400", glow: "", text: "text-zinc-400" },
  modified: { label: "Modified", dot: "bg-sky-400", glow: "glow-modified", text: "text-sky-300" },
  added: { label: "New in commit", dot: "bg-emerald-400", glow: "glow-modified", text: "text-emerald-300" },
  impacted: { label: "Impacted", dot: "bg-amber-400", glow: "glow-impacted", text: "text-amber-300" },
  broken: { label: "Broken", dot: "bg-red-500", glow: "glow-broken", text: "text-red-300" },
  proposed: { label: "Proposed", dot: "bg-fuchsia-400", glow: "", text: "text-fuchsia-300" },
};

export const SEVERITY_META: Record<ImpactSeverity, { label: string; chip: string }> = {
  modified: { label: "Origin", chip: "bg-sky-500/15 text-sky-300 ring-sky-500/40" },
  broken: { label: "Breaks", chip: "bg-red-500/15 text-red-300 ring-red-500/40" },
  impacted: { label: "Review", chip: "bg-amber-500/15 text-amber-300 ring-amber-500/40" },
};

export const EDGE_COLORS = { default: "#52525b", impact: "#ef4444", draft: "#d946ef", cycle: "#f43f5e", violation: "#fb923c", trace: "#22d3ee" } as const;

/** Health-overlay styling: a coloured ring plus a "Risk N" chip. */
export const HEALTH_META: Record<HealthLevel, { label: string; ring: string; chip: string; hex: string; text: string }> = {
  healthy: { label: "Healthy", ring: "ring-2 ring-emerald-500/60", chip: "bg-emerald-500/15 text-emerald-300 ring-emerald-500/40", hex: "#10b981", text: "text-emerald-300" },
  watch: { label: "Watch", ring: "ring-2 ring-amber-500/70", chip: "bg-amber-500/15 text-amber-300 ring-amber-500/40", hex: "#f59e0b", text: "text-amber-300" },
  risky: { label: "Risky", ring: "ring-2 ring-red-500/80", chip: "bg-red-500/15 text-red-300 ring-red-500/40", hex: "#ef4444", text: "text-red-300" },
};

/** The display name of a layer in this graph. */
export function kindLabelFor(graph: Pick<ArchitectureGraph, "kindLabels">, kind: NodeKind): string {
  return graph.kindLabels?.[kind] ?? KIND_META[kind].label;
}
