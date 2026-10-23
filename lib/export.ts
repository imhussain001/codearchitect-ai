import { buildGuide } from "@/lib/engines/guide";
import { analyzeHealth } from "@/lib/engines/health";
import { describeTrace, type Trace } from "@/lib/engines/provenance";
import { evaluateRules } from "@/lib/engines/rules";
import { explainImpact } from "@/lib/explain";
import { SCRIPT_LAYER_ORDER, WEB_LAYER_ORDER } from "@/lib/graph";
import { HEALTH_META, KIND_META, STATUS_META, kindLabelFor } from "@/lib/ui";
import type { ArchitectureGraph, ArchNode, ImpactAnalysisResult, NodeKind, NodeStatus, RenderEdge, RenderNode } from "@/lib/types";

/** Everything here is pure: it turns a graph (or what is on the canvas) into text. */

const layerOrder = (graph: ArchitectureGraph): readonly NodeKind[] => (graph.kindLabels ? SCRIPT_LAYER_ORDER : WEB_LAYER_ORDER);

/* ---------- Mermaid ---------- */

/** Quote text for a Mermaid label: it breaks on quotes, brackets and newlines. */
function mermaidText(text: string): string {
  return text.replace(/"/g, "&quot;").replace(/[\r\n]+/g, " ").replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

/**
 * A Mermaid `flowchart` of the architecture, grouped by layer. Dotted arrows are writes
 * (producer → product) and type-only imports. Builder drafts are left out. GitHub, GitLab,
 * Notion and most Markdown tools render it directly.
 */
export function toMermaid(graph: ArchitectureGraph): string {
  const nodes = graph.nodes.filter((n) => !n.data.isDraft);
  const ids = new Map(nodes.map((n, i) => [n.id, `n${i + 1}`]));
  const lines = ["flowchart TD"];

  for (const kind of layerOrder(graph)) {
    const group = nodes.filter((n) => n.data.kind === kind);
    if (group.length === 0) continue;
    lines.push(`  subgraph L_${kind}["${mermaidText(kindLabelFor(graph, kind))}"]`);
    for (const n of group) lines.push(`    ${ids.get(n.id)}["${mermaidText(n.data.label)}"]`);
    lines.push("  end");
  }

  for (const e of graph.edges) {
    const from = ids.get(e.source);
    const to = ids.get(e.target);
    if (e.isDraft || !from || !to) continue;
    const dotted = e.relation === "writes" || e.typeOnly;
    const label = e.label ?? (e.relation === "writes" || e.relation === "reads" ? e.relation : undefined);
    const arrow = dotted ? "-.->" : "-->";
    lines.push(label ? `  ${from} ${arrow}|"${mermaidText(label)}"| ${to}` : `  ${from} ${arrow} ${to}`);
  }

  for (const kind of Object.keys(KIND_META) as NodeKind[]) {
    const members = nodes.filter((n) => n.data.kind === kind).map((n) => ids.get(n.id));
    if (members.length === 0) continue;
    lines.push(`  classDef ${kind} fill:#ffffff,stroke:${KIND_META[kind].hex},stroke-width:2px,color:#18181b`);
    lines.push(`  class ${members.join(",")} ${kind}`);
  }
  return `${lines.join("\n")}\n`;
}

/* ---------- Markdown report ---------- */

export type ReportOptions = {
  impact?: ImpactAnalysisResult | null;
  trace?: Trace | null;
  /** Shown in the header; omitted when not given so the output stays deterministic. */
  generatedOn?: string;
};

const MAX_LISTED_DEPENDENCIES = 150;

const cell = (text: string) => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** A readable architecture document: diagram, components by layer, dependencies, health, rules, and any active analysis. */
export function buildMarkdownReport(graph: ArchitectureGraph, options: ReportOptions = {}): string {
  const nodes = graph.nodes.filter((n) => !n.data.isDraft);
  const edges = graph.edges.filter((e) => !e.isDraft);
  const label = (id: string) => nodes.find((n) => n.id === id)?.data.label ?? id;
  const health = analyzeHealth(graph);
  const violations = evaluateRules(graph);
  const lines: string[] = [`# Architecture: ${graph.name}`, ""];

  if (graph.description) lines.push(graph.description, "");
  lines.push(
    `**${nodes.length}** components · **${edges.length}** dependencies · health **${health.grade}** (${health.overall}/100)` +
      (graph.rules?.length ? ` · ${violations.length === 0 ? `all ${graph.rules.length} rules satisfied` : `${violations.length} rule violation${violations.length === 1 ? "" : "s"}`}` : "") +
      (options.generatedOn ? ` · generated ${options.generatedOn}` : ""),
    "",
  );

  lines.push("## Diagram", "", "```mermaid", toMermaid(graph).trimEnd(), "```", "");

  const guide = buildGuide(graph);
  if (guide.path.length > 0) {
    lines.push("## Where to start", "", guide.headline, "");
    guide.path.forEach((s, i) => lines.push(`${i + 1}. **${cell(s.label)}**: ${cell(s.why)}`));
    if (guide.omitted > 0) lines.push(`
…and ${guide.omitted} more component${guide.omitted === 1 ? "" : "s"} listed below.`);
    lines.push("");
  }

  lines.push("## Components");
  for (const kind of layerOrder(graph)) {
    const group = nodes.filter((n) => n.data.kind === kind);
    if (group.length === 0) continue;
    lines.push("", `### ${kindLabelFor(graph, kind)}`, "", "| Component | File | What it does |", "|---|---|---|");
    for (const n of group) lines.push(`| ${cell(n.data.label)} | \`${cell(n.data.filePath)}\` | ${cell(n.data.description)} |`);
  }
  lines.push("");

  lines.push("## Dependencies", "", "An arrow means *uses*; `writes` means *produces*.", "");
  for (const e of edges.slice(0, MAX_LISTED_DEPENDENCIES)) {
    const note = e.relation === "calls" ? "" : ` _(${e.relation}${e.typeOnly ? ", type only" : ""})_`;
    lines.push(`- ${label(e.source)} → ${label(e.target)}${note}`);
  }
  if (edges.length > MAX_LISTED_DEPENDENCIES) lines.push(`- …and ${edges.length - MAX_LISTED_DEPENDENCIES} more`);
  lines.push("");

  lines.push("## Health", "");
  if (health.issues.length === 0) lines.push("No circular dependencies, crossed layers, hubs, oversized files or unconnected components.");
  for (const issue of health.issues) lines.push(`- **${cell(issue.title)}** (${issue.severity}): ${cell(issue.detail)}`);
  lines.push("");

  if (graph.rules?.length) {
    lines.push("## Rules", "");
    if (violations.length === 0) lines.push(`All ${graph.rules.length} rules are satisfied.`);
    for (const v of violations) lines.push(`- ${v.severity === "error" ? "**error**" : "warn"} \`${v.ruleId}\`: ${cell(v.message)}`);
    lines.push("");
  }

  if (options.impact) {
    const impact = options.impact;
    const plain = explainImpact(impact, graph);
    lines.push("## Change analysis", "", `> ${cell(impact.prompt)}`, "", `**${plain.headline}** Effort: ${plain.effort}. Blast-radius risk: ${impact.riskScore}/100.`, "", impact.summary, "", "Suggested order:", "");
    for (const step of plain.order) lines.push(`${step}`);
    lines.push("");
  }

  if (options.trace) {
    const d = describeTrace(graph, options.trace);
    lines.push(`## Data-flow trace (${options.trace.mode === "upstream" ? "where it comes from" : "what it affects"})`, "", `**${d.headline}**`, "");
    for (const l of d.lines) lines.push(`- ${l}`);
    lines.push("", "Steps:", "");
    options.trace.steps.forEach((s, i) => lines.push(`${i + 1}. ${label(s.nodeId)} _(${s.role})_`));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

/* ---------- SVG diagram ---------- */

export const SVG_NODE_WIDTH = 220;
export const SVG_NODE_HEIGHT = 100;
const MARGIN = 48;
const TITLE_HEIGHT = 40;
const LEGEND_HEIGHT = 40;
const MAX_LABEL_CHARS = 26;
const MAX_PATH_CHARS = 34;

const STATUS_COLOR: Partial<Record<NodeStatus, string>> = { broken: "#ef4444", impacted: "#f59e0b", modified: "#38bdf8", added: "#34d399", proposed: "#d946ef" };
const SANS = "Inter, system-ui, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, 'Cascadia Code', Consolas, monospace";

const xml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const clipStart = (text: string, max: number) => (text.length > max ? `…${text.slice(text.length - max + 1)}` : text);

export type SvgOptions = { title?: string; kindLabels?: ArchitectureGraph["kindLabels"]; legend?: boolean };
export type SvgResult = { svg: string; width: number; height: number };

function edgePath(source: RenderNode, target: RenderNode, dx: number, dy: number): { d: string; mid: { x: number; y: number } } {
  const sx = source.position.x + SVG_NODE_WIDTH / 2 - dx;
  const sy = source.position.y + SVG_NODE_HEIGHT - dy;
  const tx = target.position.x + SVG_NODE_WIDTH / 2 - dx;
  const ty = target.position.y - dy;
  const bend = Math.max(40, Math.abs(ty - sy) / 2);
  // Cubic Bézier from the bottom of the source to the top of the target; its midpoint (t = 0.5) carries the label.
  const c1 = { x: sx, y: sy + bend };
  const c2 = { x: tx, y: ty - bend };
  return {
    d: `M ${sx} ${sy} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${tx} ${ty}`,
    mid: { x: (sx + 3 * c1.x + 3 * c2.x + tx) / 8, y: (sy + 3 * c1.y + 3 * c2.y + ty) / 8 },
  };
}

/**
 * A standalone SVG of the canvas as it looks right now: node colours, status glows,
 * health rings, trace numbers and dimming all carry over. Vector, so it stays sharp in
 * slides and papers; the app also rasterises it to PNG.
 */
export function renderSvg(nodes: readonly RenderNode[], edges: readonly RenderEdge[], options: SvgOptions = {}): SvgResult {
  const visible = nodes.filter((n) => !n.hidden);
  const byId = new Map(visible.map((n) => [n.id, n]));
  const shown = edges.filter((e) => !e.hidden && byId.has(e.source) && byId.has(e.target));
  const { title, kindLabels, legend = true } = options;

  if (visible.length === 0) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="120" viewBox="0 0 400 120"><rect width="400" height="120" fill="#09090b"/><text x="200" y="64" fill="#a1a1aa" font-family="${SANS}" font-size="14" text-anchor="middle">Nothing to draw</text></svg>`;
    return { svg, width: 400, height: 120 };
  }

  const minX = Math.min(...visible.map((n) => n.position.x));
  const minY = Math.min(...visible.map((n) => n.position.y));
  const maxX = Math.max(...visible.map((n) => n.position.x + SVG_NODE_WIDTH));
  const maxY = Math.max(...visible.map((n) => n.position.y + SVG_NODE_HEIGHT));
  const top = title ? TITLE_HEIGHT : 0;
  const bottom = legend ? LEGEND_HEIGHT : 0;
  const width = Math.round(maxX - minX + 2 * MARGIN);
  const height = Math.round(maxY - minY + 2 * MARGIN + top + bottom);
  // Shift so the drawing starts at (MARGIN, MARGIN + title).
  const dx = minX - MARGIN;
  const dy = minY - MARGIN - top;

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="${width}" height="${height}" fill="#09090b"/>`,
  ];

  const strokes = new Map<string, string>();
  for (const e of shown) strokes.set(String(e.style?.stroke ?? "#52525b"), `m${strokes.size}`);
  out.push("<defs>");
  for (const [color, id] of strokes) {
    out.push(`<marker id="${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="${xml(color)}"/></marker>`);
  }
  out.push("</defs>");

  if (title) out.push(`<text x="${MARGIN}" y="${MARGIN - 8}" fill="#f4f4f5" font-family="${SANS}" font-size="18" font-weight="600">${xml(title)}</text>`);

  for (const e of shown) {
    const { d, mid } = edgePath(byId.get(e.source)!, byId.get(e.target)!, dx, dy);
    const stroke = String(e.style?.stroke ?? "#52525b");
    const opacity = e.style?.opacity ?? 1;
    const dash = e.style?.strokeDasharray ? ` stroke-dasharray="${xml(String(e.style.strokeDasharray))}"` : "";
    out.push(`<path d="${d}" fill="none" stroke="${xml(stroke)}" stroke-width="${e.style?.strokeWidth ?? 1.5}"${dash} opacity="${opacity}" marker-end="url(#${strokes.get(stroke)})"/>`);
    if (typeof e.label === "string" && e.label) {
      const w = e.label.length * 5.6 + 10;
      out.push(`<g opacity="${opacity}"><rect x="${mid.x - w / 2}" y="${mid.y - 8}" width="${w}" height="16" rx="4" fill="#18181b" stroke="#27272a"/><text x="${mid.x}" y="${mid.y + 3.5}" fill="#a1a1aa" font-family="${MONO}" font-size="10" text-anchor="middle">${xml(e.label)}</text></g>`);
    }
  }

  for (const n of visible) {
    const x = n.position.x - dx;
    const y = n.position.y - dy;
    const d = n.data;
    const kind = KIND_META[d.kind];
    const ring = d.heat ? HEALTH_META[d.heat.level].hex : (STATUS_COLOR[d.status] ?? (d.traced ? "#22d3ee" : undefined));
    const status = d.status !== "normal" && !d.heat ? STATUS_META[d.status].label : undefined;
    out.push(`<g class="node" data-id="${xml(n.id)}" opacity="${d.dimmed ? 0.25 : 1}">`);
    if (ring) out.push(`<rect x="${x - 4}" y="${y - 4}" width="${SVG_NODE_WIDTH + 8}" height="${SVG_NODE_HEIGHT + 8}" rx="16" fill="none" stroke="${ring}" stroke-width="3" opacity="0.85"/>`);
    out.push(`<rect x="${x}" y="${y}" width="${SVG_NODE_WIDTH}" height="${SVG_NODE_HEIGHT}" rx="12" fill="#18181b" stroke="${kind.hex}" stroke-width="2"${d.status === "proposed" ? ' stroke-dasharray="6 4"' : ""}/>`);
    out.push(`<text x="${x + 14}" y="${y + 26}" fill="#fafafa" font-family="${SANS}" font-size="13" font-weight="600">${xml(clip(d.label, MAX_LABEL_CHARS))}</text>`);
    out.push(`<text x="${x + 14}" y="${y + 43}" fill="#71717a" font-family="${MONO}" font-size="10">${xml(clipStart(d.filePath, MAX_PATH_CHARS))}</text>`);
    out.push(`<text x="${x + 14}" y="${y + 70}" fill="${kind.hex}" font-family="${SANS}" font-size="11" font-weight="500">${xml(clip(d.kindLabel, 20))}</text>`);
    const right = d.heat ? `Risk ${d.heat.score}` : status;
    if (right) out.push(`<text x="${x + SVG_NODE_WIDTH - 14}" y="${y + 70}" fill="${ring ?? "#a1a1aa"}" font-family="${SANS}" font-size="11" font-weight="600" text-anchor="end">${xml(right)}</text>`);
    if (d.traceStep) out.push(`<circle cx="${x}" cy="${y}" r="11" fill="#06b6d4"/><text x="${x}" y="${y + 4}" fill="#09090b" font-family="${SANS}" font-size="11" font-weight="700" text-anchor="middle">${d.traceStep}</text>`);
    if (d.violations) out.push(`<rect x="${x + SVG_NODE_WIDTH - 30}" y="${y - 10}" width="38" height="20" rx="10" fill="#ea580c"/><text x="${x + SVG_NODE_WIDTH - 11}" y="${y + 4}" fill="#fff" font-family="${SANS}" font-size="11" font-weight="700" text-anchor="middle">✕ ${d.violations}</text>`);
    out.push("</g>");
  }

  if (legend) {
    const kinds = (Object.keys(KIND_META) as NodeKind[]).filter((k) => visible.some((n) => n.data.kind === k));
    let lx = MARGIN;
    const ly = height - LEGEND_HEIGHT + 14;
    for (const k of kinds) {
      const text = kindLabels?.[k] ?? KIND_META[k].label;
      out.push(`<rect x="${lx}" y="${ly - 9}" width="10" height="10" rx="2" fill="${KIND_META[k].hex}"/><text x="${lx + 16}" y="${ly}" fill="#a1a1aa" font-family="${SANS}" font-size="11">${xml(text)}</text>`);
      lx += 16 + text.length * 6.4 + 22;
    }
  }

  out.push("</svg>");
  return { svg: `${out.join("\n")}\n`, width, height };
}

export type { ArchNode };
