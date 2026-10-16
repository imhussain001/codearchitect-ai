import { diffLines } from "@/lib/diff";
import { collectDependents, nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ImpactAnalysisResult, NodeKind } from "@/lib/types";

/** Everything here is deterministic text built from the graph; no AI is involved. */

export const GLOSSARY: ReadonlyArray<{ term: string; meaning: string }> = [
  { term: "Component", meaning: "One part of the codebase: a file or a group of files with a single job (a page, an API route, a service, a data store)." },
  { term: "Dependency", meaning: "An arrow from A to B means A uses B. If B changes, A may stop working." },
  { term: "Blast radius", meaning: "Everything a change could affect, directly or through other components." },
  { term: "Broken (red)", meaning: "Will fail or misbehave unless it is edited for the change." },
  { term: "Impacted (amber)", meaning: "Depends on something that changes. Review it; it may need no edit at all." },
  { term: "Origin (blue)", meaning: "Where the change starts." },
  { term: "Hop", meaning: "One step along the arrows. A component 2 hops away is affected indirectly, through another component." },
  { term: "Change-risk", meaning: "0–100 score of how costly and fragile a component is to change: many dependents, tangled links, big files." },
  { term: "Circular dependency", meaning: "A uses B and B uses A (possibly through others). Such a loop is hard to change or test in isolation." },
  { term: "Hub", meaning: "A component many others depend on. A change to it has a wide blast radius." },
];

const KIND_PHRASE: Record<NodeKind, string> = {
  frontend: "a user-facing part (a screen, page or output)",
  api: "an entry point that receives requests",
  logic: "business logic that does the actual work",
  data: "a place that stores or caches information",
};

/** "Wide" means a change can reach at least this many components and this share of the graph. */
const WIDE_MIN_COMPONENTS = 3;
const WIDE_MIN_SHARE = 0.5;

export type PlainExplanation = { headline: string; bullets: string[] };

function listNames(names: string[], max = 4): string {
  if (names.length <= max) return names.join(", ");
  return `${names.slice(0, max).join(", ")} and ${names.length - max} more`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "What is this component, and how much would changing it touch?" in everyday words. */
export function explainNode(graph: ArchitectureGraph, nodeId: string): PlainExplanation | null {
  const node = nodeById(graph.nodes, nodeId);
  if (!node) return null;
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
  const real = graph.edges.filter((e) => !e.isDraft);

  const direct = [...new Set(real.filter((e) => e.target === nodeId).map((e) => e.source))];
  const uses = [...new Set(real.filter((e) => e.source === nodeId).map((e) => e.target))];
  const reach = collectDependents(nodeId, real);
  const indirect = reach.size - 1;
  const customLayer = graph.kindLabels?.[node.data.kind];

  const bullets: string[] = [];
  bullets.push(
    direct.length === 0
      ? "Nothing else in this map uses it."
      : `${plural(direct.length, "component")} use${direct.length === 1 ? "s" : ""} it directly: ${listNames(direct.map(label))}.`,
  );
  bullets.push(uses.length === 0 ? "It does not rely on anything else." : `It relies on ${listNames(uses.map(label))}.`);

  const total = Math.max(1, graph.nodes.length - 1);
  if (indirect === 0) {
    bullets.push("Changing it affects only itself, so it is safe to change on its own.");
  } else if (indirect >= WIDE_MIN_COMPONENTS && indirect / total >= WIDE_MIN_SHARE) {
    bullets.push(`A change here can ripple to ${indirect} of the other ${total} components: a wide blast radius, so plan it carefully.`);
  } else {
    bullets.push(`A change here can ripple to ${plural(indirect, "other component")}${indirect > direct.length ? ", some of them indirectly" : ""}.`);
  }

  const kind = customLayer ? `part of “${customLayer}”` : KIND_PHRASE[node.data.kind];
  return { headline: `${node.data.label} is ${kind}.`, bullets };
}

export type Effort = "Small" | "Medium" | "Large";

export type ImpactExplanation = {
  headline: string;
  effort: Effort;
  effortWhy: string;
  /** Suggested order of work, one sentence per step. */
  order: string[];
};

const EFFORT_SMALL_LINES = 30;
const EFFORT_MEDIUM_LINES = 150;
const EFFORT_SMALL_BROKEN = 2;
const EFFORT_MEDIUM_BROKEN = 6;

/** A rough, explainable estimate of how much work a simulated change is, and in what order to do it. */
export function explainImpact(result: ImpactAnalysisResult, graph: ArchitectureGraph): ImpactExplanation {
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
  const broken = result.impacts.filter((i) => i.severity === "broken");
  const review = result.impacts.filter((i) => i.severity === "impacted");

  let changed = 0;
  for (const d of result.diffs) {
    const { stats } = diffLines(d.before, d.after);
    changed += stats.added + stats.removed;
  }
  const hasEdits = result.diffs.length > 0;
  const effort: Effort =
    broken.length <= EFFORT_SMALL_BROKEN && (!hasEdits || changed <= EFFORT_SMALL_LINES)
      ? "Small"
      : broken.length <= EFFORT_MEDIUM_BROKEN && (!hasEdits || changed <= EFFORT_MEDIUM_LINES)
        ? "Medium"
        : "Large";

  const mustChange = `${plural(broken.length, "file")} must change`;
  const toReview = review.length ? ` and ${plural(review.length, "other component")} should be reviewed` : "";
  const effortWhy = hasEdits
    ? `${mustChange}${toReview}; the proposed edits touch about ${changed} lines.`
    : `${mustChange}${toReview}. This estimate comes from the dependency map alone: no code edits were proposed.`;

  const parts = [
    broken.length ? `edits in ${plural(broken.length, "file")}` : null,
    review.length ? `a review of ${plural(review.length, "more component")}` : null,
  ].filter(Boolean);
  const headline = `Changing ${label(result.rootNodeId)} would need ${parts.length ? parts.join(" and ") : "no other changes"}.`;

  // Origin first, then outward: fix what you changed before the things that consume it.
  const ordered = [...result.impacts].sort((a, b) => a.depth - b.depth);
  const order = ordered
    .filter((i) => i.severity !== "impacted")
    .map((i, step) => (i.severity === "modified" ? `${step + 1}. Make the change in ${label(i.nodeId)}.` : `${step + 1}. Update ${label(i.nodeId)}: ${i.reason.replace(/\.$/, "")}.`));
  if (review.length) order.push(`${order.length + 1}. Skim ${listNames(review.map((i) => label(i.nodeId)))}; ${review.length === 1 ? "it" : "they"} may need no edit.`);

  return { headline, effort, effortWhy, order };
}
