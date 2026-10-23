import { analyzeHealth } from "@/lib/engines/health";
import { SCRIPT_LAYER_ORDER, WEB_LAYER_ORDER } from "@/lib/graph";
import { kindLabelFor } from "@/lib/ui";
import type { ArchitectureGraph, ArchNode, NodeKind } from "@/lib/types";

/**
 * "Explain this repo": where a newcomer should start and in what order to read. Everything
 * is derived from the graph (who calls whom, how widely a component is used), so it is
 * deterministic and identical in the app, the CLI and exported reports.
 */

export type GuideRole = "entry" | "core" | "support" | "leaf";

export type GuideStep = {
  nodeId: string;
  label: string;
  role: GuideRole;
  /** One sentence on why to read this now, from graph facts. */
  why: string;
};

export type RepoGuide = {
  headline: string;
  layers: Array<{ kind: NodeKind; label: string; count: number }>;
  /** Components nothing else uses: where execution or a request begins. */
  entryPoints: string[];
  /** The most widely used components: what breaks the most if changed. */
  keyComponents: Array<{ nodeId: string; usedBy: number }>;
  /** Suggested reading order, at most MAX_PATH_STEPS long. */
  path: GuideStep[];
  /** Components in the map that the path does not show. */
  omitted: number;
  /** Components to read carefully before changing: highest change-risk. */
  handleWithCare: string[];
};

export const MAX_PATH_STEPS = 12;
const MAX_KEY_COMPONENTS = 4;
const MAX_CARE = 3;
const CORE_MIN_FAN_IN = 3;
const CARE_MIN_SCORE = 35; // "watch" level and above (see health.ts)

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function list(names: string[], max = 3): string {
  return names.length <= max ? names.join(", ") : `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

const isAuthoredDescription = (node: ArchNode) => node.data.description.trim() !== "" && !/detected by path heuristics/.test(node.data.description);

/** The first sentence of an authored description; heuristic placeholders ("120 lines · detected…") are not worth repeating. */
function summaryOf(node: ArchNode): string {
  if (!isAuthoredDescription(node)) return "";
  const first = node.data.description.split(/(?<=[.!?])\s/)[0]!.trim();
  return first.length > 140 ? `${first.slice(0, 137)}…` : first;
}

export function buildGuide(graph: ArchitectureGraph): RepoGuide {
  const nodes = graph.nodes.filter((n) => !n.data.isDraft);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => !e.isDraft && ids.has(e.source) && ids.has(e.target) && e.source !== e.target);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const label = (id: string) => byId.get(id)!.data.label;

  const fanIn = new Map<string, Set<string>>();
  const out = new Map<string, string[]>();
  for (const n of nodes) {
    fanIn.set(n.id, new Set());
    out.set(n.id, []);
  }
  for (const e of edges) {
    // A `writes` edge points from producer to product: the product is *produced by* the source, not used by it.
    if (e.relation === "writes") {
      out.get(e.source)!.push(e.target);
      continue;
    }
    fanIn.get(e.target)!.add(e.source);
    out.get(e.source)!.push(e.target);
  }
  const usedBy = (id: string) => fanIn.get(id)!.size;
  const importance = (id: string) => usedBy(id) * 3 + (out.get(id)!.length > 0 ? 1 : 0);

  const health = analyzeHealth(graph);
  const hasIncoming = (id: string) => edges.some((e) => e.target === id);

  // Entry points: nothing uses them, they use something, and they are not just data files. (A route that
  // another component calls over HTTP is not an entry point: the flow starts at its caller.)
  const entryPoints = nodes
    .filter((n) => n.data.kind !== "data" && !hasIncoming(n.id))
    .filter((n) => out.get(n.id)!.length > 0 || nodes.length === 1)
    .sort((a, b) => out.get(b.id)!.length - out.get(a.id)!.length || a.data.label.localeCompare(b.data.label))
    .map((n) => n.id);

  const keyComponents = nodes
    .filter((n) => usedBy(n.id) >= 2)
    .sort((a, b) => usedBy(b.id) - usedBy(a.id) || a.data.label.localeCompare(b.data.label))
    .slice(0, MAX_KEY_COMPONENTS)
    .map((n) => ({ nodeId: n.id, usedBy: usedBy(n.id) }));

  // Reading order: from each entry point follow its dependencies depth-first, most important first,
  // so one flow is read top to bottom before the next begins.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    order.push(id);
    const next = [...new Set(out.get(id)!)].sort((a, b) => importance(b) - importance(a) || label(a).localeCompare(label(b)));
    for (const child of next) visit(child);
  };
  for (const id of entryPoints) visit(id);
  // Anything unreachable from an entry point (cycles with no entry, isolated parts): most important first.
  for (const n of [...nodes].sort((a, b) => importance(b.id) - importance(a.id) || a.data.label.localeCompare(b.data.label))) visit(n.id);

  const entrySet = new Set(entryPoints);
  const roleOf = (id: string): GuideRole => (entrySet.has(id) ? "entry" : usedBy(id) >= CORE_MIN_FAN_IN ? "core" : out.get(id)!.length === 0 ? "leaf" : "support");

  const whyFor = (id: string, role: GuideRole): string => {
    const uses = [...new Set(out.get(id)!)];
    const users = [...fanIn.get(id)!];
    const lead =
      role === "entry"
        ? `Start here: nothing else calls it, so this is where ${byId.get(id)!.data.kind === "api" ? "a request" : "the flow"} begins${uses.length ? `, and it uses ${list(uses.map(label))}` : ""}.`
        : role === "core"
          ? `Used by ${plural(users.length, "component")} (${list(users.map(label))}): a shared building block, so understanding it unlocks many files.`
          : role === "leaf"
            ? `Depends on nothing else here${users.length ? `; used by ${list(users.map(label))}` : ""}. It holds lower-level detail.`
            : `Uses ${list(uses.map(label))}${users.length ? `; used by ${list(users.map(label))}` : ""}.`;
    const about = summaryOf(byId.get(id)!);
    return about ? `${lead} ${about}` : lead;
  };

  const path: GuideStep[] = order.slice(0, MAX_PATH_STEPS).map((id) => {
    const role = roleOf(id);
    return { nodeId: id, label: label(id), role, why: whyFor(id, role) };
  });

  const layerOrder = graph.kindLabels ? SCRIPT_LAYER_ORDER : WEB_LAYER_ORDER;
  const layers = (layerOrder as readonly NodeKind[])
    .map((kind) => ({ kind, label: kindLabelFor(graph, kind), count: nodes.filter((n) => n.data.kind === kind).length }))
    .filter((l) => l.count > 0);

  const handleWithCare = Object.values(health.nodes)
    .filter((n) => ids.has(n.nodeId) && n.score >= CARE_MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_CARE)
    .map((n) => n.nodeId);

  const layerText = layers.map((l) => `${l.count} ${l.label.toLowerCase()}`).join(", ");
  const headline = `${graph.name} has ${plural(nodes.length, "component")}${layerText ? ` (${layerText})` : ""}. ${
    entryPoints.length ? `Execution starts at ${list(entryPoints.map(label))}.` : "No clear entry point was found; start with the most widely used components."
  }`;

  return { headline, layers, entryPoints, keyComponents, path, omitted: Math.max(0, nodes.length - path.length), handleWithCare };
}
