import { nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ArchNode, DependencyEdge } from "@/lib/types";

/**
 * Provenance: follow data flow through the map.
 *
 * Edges point from a thing to what it depends on (`reads`, `calls`, `imports`), except
 * `writes`, which points from a producer to what it produces. So:
 *
 * - **upstream** ("where does this come from?"): from a produced file, go to the code that
 *   writes it; from code, go to what it reads and calls; repeat. A file nothing writes is a raw input.
 * - **downstream** ("what does this affect?"): from a file or function, go to the code that
 *   reads or calls it, then to everything that code writes; repeat.
 */

export type TraceMode = "upstream" | "downstream";

export type TraceRequest = { nodeId: string; mode: TraceMode };

export type TraceRole = "target" | "input" | "produced" | "code";

export type TraceStep = { nodeId: string; depth: number; role: TraceRole };

export type Trace = TraceRequest & {
  nodeIds: string[];
  edgeIds: string[];
  /** Upstream: raw inputs first, the target last. Downstream: the source first, then what it reaches. */
  steps: TraceStep[];
  /** Upstream: data nodes that no code in the map writes. */
  rawInputs: string[];
  /** Downstream: data nodes (outputs) that would be affected. */
  results: string[];
};

const isData = (node: ArchNode) => node.data.kind === "data";

export function traceProvenance(graph: ArchitectureGraph, request: TraceRequest): Trace | null {
  const root = nodeById(graph.nodes, request.nodeId);
  if (!root) return null;

  const nodes = graph.nodes.filter((n) => !n.data.isDraft);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => !e.isDraft && byId.has(e.source) && byId.has(e.target));
  const outgoing = new Map<string, DependencyEdge[]>();
  const incoming = new Map<string, DependencyEdge[]>();
  for (const e of edges) {
    (outgoing.get(e.source) ?? outgoing.set(e.source, []).get(e.source)!).push(e);
    (incoming.get(e.target) ?? incoming.set(e.target, []).get(e.target)!).push(e);
  }

  const depth = new Map<string, number>([[root.id, 0]]);
  const used = new Set<string>();
  const queue = [root.id];

  const visit = (from: string, to: string, edge: DependencyEdge) => {
    used.add(edge.id);
    if (depth.has(to)) return;
    depth.set(to, depth.get(from)! + 1);
    queue.push(to);
  };

  for (let head = 0; head < queue.length; head++) {
    const id = queue[head]!;
    const node = byId.get(id)!;
    if (request.mode === "upstream") {
      if (isData(node)) for (const e of incoming.get(id) ?? []) if (e.relation === "writes") visit(id, e.source, e);
      if (!isData(node)) for (const e of outgoing.get(id) ?? []) if (e.relation !== "writes") visit(id, e.target, e);
    } else {
      for (const e of incoming.get(id) ?? []) if (e.relation !== "writes") visit(id, e.source, e);
      if (!isData(node)) for (const e of outgoing.get(id) ?? []) if (e.relation === "writes") visit(id, e.target, e);
    }
  }

  const hasWriter = (id: string) => (incoming.get(id) ?? []).some((e) => e.relation === "writes");
  const label = (id: string) => byId.get(id)!.data.label;

  const roleOf = (id: string): TraceRole => {
    if (id === root.id) return "target";
    const node = byId.get(id)!;
    if (!isData(node)) return "code";
    return hasWriter(id) ? "produced" : "input";
  };

  // Same depth: raw inputs, then code, then intermediate files, then the target, so it reads as a pipeline.
  const ROLE_RANK: Record<TraceRole, number> = { input: 0, code: 1, produced: 2, target: 3 };
  const steps: TraceStep[] = [...depth.entries()]
    .map(([nodeId, d]) => ({ nodeId, depth: d, role: roleOf(nodeId) }))
    .sort(
      (a, b) =>
        (request.mode === "upstream" ? b.depth - a.depth : a.depth - b.depth) ||
        ROLE_RANK[a.role] - ROLE_RANK[b.role] ||
        label(a.nodeId).localeCompare(label(b.nodeId)),
    );

  const others = steps.filter((s) => s.nodeId !== root.id);
  return {
    ...request,
    nodeIds: steps.map((s) => s.nodeId),
    edgeIds: [...used],
    steps,
    rawInputs: request.mode === "upstream" ? others.filter((s) => s.role === "input").map((s) => s.nodeId) : [],
    results: request.mode === "downstream" ? others.filter((s) => isData(byId.get(s.nodeId)!)).map((s) => s.nodeId) : [],
  };
}

/* ---------- Plain language ---------- */

export type TraceDescription = { headline: string; lines: string[] };

const MAX_NAMED = 6;

function names(labels: string[], max = MAX_NAMED): string {
  return labels.length <= max ? labels.join(", ") : `${labels.slice(0, max).join(", ")} and ${labels.length - max} more`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Everyday-language summary of a trace. Deterministic; no AI. */
export function describeTrace(graph: ArchitectureGraph, trace: Trace): TraceDescription {
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
  const root = nodeById(graph.nodes, trace.nodeId)!;
  const others = trace.steps.filter((s) => s.nodeId !== trace.nodeId);
  const edges = graph.edges.filter((e) => !e.isDraft);

  if (trace.mode === "upstream") {
    if (others.length === 0) {
      return { headline: `${root.data.label} does not come from anything else in this map.`, lines: ["It has no inputs and no producing code here; it may be a raw input itself."] };
    }
    const writers = edges.filter((e) => e.target === trace.nodeId && e.relation === "writes").map((e) => label(e.source));
    const code = others.filter((s) => s.role === "code" && !writers.includes(label(s.nodeId))).map((s) => label(s.nodeId));
    const produced = others.filter((s) => s.role === "produced").map((s) => label(s.nodeId));
    const lines: string[] = [];
    if (code.length) lines.push(`Along the way it uses ${names(code)}.`);
    if (produced.length) lines.push(`It passes through ${plural(produced.length, "intermediate file")}: ${names(produced)}.`);
    if (trace.rawInputs.length) lines.push(`It starts from ${plural(trace.rawInputs.length, "input file")}: ${names(trace.rawInputs.map(label))}.`);
    else lines.push("No raw input files were found upstream.");
    return {
      headline: writers.length ? `${root.data.label} is produced by ${names(writers)}.` : `${root.data.label} draws on ${plural(others.length, "other component")}.`,
      lines,
    };
  }

  if (others.length === 0) {
    return { headline: `Nothing else in this map uses ${root.data.label} or anything derived from it.`, lines: ["Changing it affects only itself."] };
  }
  const code = others.filter((s) => !isDataNode(graph, s.nodeId)).map((s) => label(s.nodeId));
  const lines: string[] = [];
  if (code.length) lines.push(`Code that uses it, directly or indirectly: ${names(code)}.`);
  if (trace.results.length) lines.push(`Results that would be out of date: ${names(trace.results.map(label))}.`);
  else lines.push("It produces no output files in this map.");
  return { headline: `Changing ${root.data.label} can affect ${plural(others.length, "other component")}.`, lines };
}

function isDataNode(graph: ArchitectureGraph, id: string): boolean {
  return nodeById(graph.nodes, id)?.data.kind === "data";
}
