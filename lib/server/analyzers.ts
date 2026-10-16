import "server-only";
import { collectDependents, layoutByKind, nodeById } from "@/lib/graph";
import { computeRiskScore } from "@/lib/engines/localImpact";
import { selectGraphFiles, truncateCode } from "@/lib/engines/heuristicGraph";
import { generateStructured } from "@/lib/server/claude";
import { ClaudeImpactSchema, ClaudeIngestSchema, ClaudeScaffoldSchema, ClaudeStorySchema } from "@/lib/server/schemas";
import type {
  ArchitectureGraph,
  ArchNode,
  DependencyEdge,
  ImpactAnalysisResult,
  NodeImpact,
  ScaffoldResult,
  SourceFile,
  StoryNarrative,
} from "@/lib/types";

/** Keeps a single request comfortably inside the context window with room for output. */
const MAX_INGEST_SOURCE_CHARS = 600_000;
const RISK_SCORE_MAX = 100;

function serializeGraph(graph: ArchitectureGraph, includeCode: boolean): string {
  const nodes = graph.nodes.map((n) => {
    const head = `<component id="${n.id}" kind="${n.data.kind}" path="${n.data.filePath}"${n.data.isDraft ? ' draft="true"' : ""}>\n` +
      `label: ${n.data.label}\ndescription: ${n.data.description}\nexports: ${n.data.exports.join(", ") || "-"}`;
    return includeCode ? `${head}\n<code>\n${n.data.code}\n</code>\n</component>` : `${head}\n</component>`;
  });
  const edges = graph.edges.map((e) => `${e.source} -> ${e.target} (${e.relation}${e.label ? `: ${e.label}` : ""})${e.isDraft ? " [new]" : ""}`);
  return `<architecture name="${graph.name}">\n${nodes.join("\n")}\n<dependencies note="source depends on target">\n${edges.join("\n")}\n</dependencies>\n</architecture>`;
}

const SHARED_RULES =
  "Component IDs in your answer must be copied exactly from the input. Code you write must be complete files, not fragments, and must match the conventions already used in the codebase. Do not invent components that are not in the input.";

export async function analyzeImpactWithClaude(
  graph: ArchitectureGraph,
  prompt: string,
  selectedNodeId: string | null,
): Promise<ImpactAnalysisResult> {
  const result = await generateStructured({
    schema: ClaudeImpactSchema,
    effort: "high",
    system: `You are a principal engineer performing refactoring impact analysis on a dependency graph. Identify the component where the requested change originates, every component that must change or will break as a consequence (including non-obvious couplings such as serialized payloads, cache contents and token claims), and write the concrete updated code for each affected file. Severity: "modified" = origin, "broken" = will fail to compile or misbehave without edits, "impacted" = needs review or a smaller edit. ${SHARED_RULES}`,
    prompt: `${serializeGraph(graph, true)}\n\n<selected_component>${selectedNodeId ?? "none"}</selected_component>\n<change_request>${prompt}</change_request>`,
  });

  const rootNodeId = nodeById(graph.nodes, result.rootNodeId) ? result.rootNodeId : selectedNodeId;
  if (!rootNodeId) throw new Error("Claude did not identify a valid origin component.");

  const depths = collectDependents(rootNodeId, graph.edges);
  const seen = new Set<string>();
  const impacts: NodeImpact[] = result.impacts
    .filter((i) => nodeById(graph.nodes, i.nodeId) && !seen.has(i.nodeId) && seen.add(i.nodeId))
    .map((i) => ({ ...i, severity: i.nodeId === rootNodeId ? "modified" : i.severity, depth: depths.get(i.nodeId) ?? 1 }));
  if (!seen.has(rootNodeId)) impacts.unshift({ nodeId: rootNodeId, severity: "modified", depth: 0, reason: "Origin of the change." });
  impacts.sort((a, b) => a.depth - b.depth);

  return {
    prompt,
    rootNodeId,
    summary: result.summary,
    riskScore: Number.isFinite(result.riskScore)
      ? Math.max(0, Math.min(RISK_SCORE_MAX, Math.round(result.riskScore)))
      : computeRiskScore(impacts, graph.nodes.length),
    impacts,
    diffs: result.diffs.flatMap((d) => {
      const node = nodeById(graph.nodes, d.nodeId);
      return node ? [{ nodeId: d.nodeId, filePath: node.data.filePath, before: node.data.code, after: d.after, rationale: d.rationale }] : [];
    }),
    engine: "claude",
  };
}

export async function narrateStoryWithClaude(graph: ArchitectureGraph): Promise<StoryNarrative> {
  if (graph.commits.length === 0) throw new Error("This repository has no commit history to narrate.");
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
  const history = graph.commits
    .map((c) => `<commit hash="${c.hash}" date="${c.date}" author="${c.author}">\nmessage: ${c.message}\nadded: ${c.addedNodeIds.map(label).join(", ") || "-"}\nmodified: ${c.modifiedNodeIds.map(label).join(", ") || "-"}\n</commit>`)
    .join("\n");

  const result = await generateStructured({
    schema: ClaudeStorySchema,
    effort: "medium",
    system:
      "You are a software archaeologist. Explain how this architecture evolved as a short narrative: for each commit, one titled phase that says what structurally changed and the most plausible engineering reason, and flag couplings or regressions a future maintainer should know. Ground every claim in the commit messages and component changes provided; say when a motive is inferred. Return one phase per commit, using the given hashes.",
    prompt: `${serializeGraph(graph, false)}\n\n<history order="oldest first">\n${history}\n</history>`,
  });

  const known = new Set(graph.commits.map((c) => c.hash));
  return { overview: result.overview, phases: result.phases.filter((p) => known.has(p.hash)), engine: "claude" };
}

export async function scaffoldWithClaude(graph: ArchitectureGraph): Promise<ScaffoldResult> {
  const result = await generateStructured({
    schema: ClaudeScaffoldSchema,
    effort: "high",
    system: `You generate production-quality scaffolding for new components drawn on an architecture diagram. Components marked draft="true" do not exist yet: write one complete file for each at its given path. Dependencies marked [new] must be wired: edit every existing (non-draft) source file of a [new] dependency so it actually uses the new target. Handle errors explicitly and keep each file focused. ${SHARED_RULES}`,
    prompt: serializeGraph(graph, true),
  });

  const drafts = new Set(graph.nodes.filter((n) => n.data.isDraft).map((n) => n.id));
  return {
    summary: result.summary,
    files: result.files.filter((f) => drafts.has(f.nodeId)),
    diffs: result.edits.flatMap((e) => {
      const node = nodeById(graph.nodes, e.nodeId);
      return node && !drafts.has(e.nodeId)
        ? [{ nodeId: e.nodeId, filePath: node.data.filePath, before: node.data.code, after: e.after, rationale: e.rationale }]
        : [];
    }),
    engine: "claude",
  };
}

/** Pack as many whole files as fit the budget; report exactly what was left out. */
function packSources(files: readonly SourceFile[]): { packed: SourceFile[]; omitted: number } {
  const packed: SourceFile[] = [];
  let budget = MAX_INGEST_SOURCE_CHARS;
  for (const file of files) {
    if (file.content.length > budget) continue;
    packed.push(file);
    budget -= file.content.length;
  }
  return { packed, omitted: files.length - packed.length };
}

export async function ingestWithClaude(name: string, files: readonly SourceFile[]): Promise<ArchitectureGraph> {
  const { selected, warnings } = selectGraphFiles(files);
  const { packed, omitted } = packSources(selected);
  if (omitted > 0) warnings.push(`${omitted} large file(s) were not sent to Claude (context budget); they appear only if referenced.`);

  const result = await generateStructured({
    schema: ClaudeIngestSchema,
    effort: "medium",
    system:
      "You map a codebase into an architecture graph of 4-25 components. A component is an architectural unit (a page, an API route, a service/controller, a datastore or cache) anchored to one primary file. Edges point from the dependent to its dependency. Prefer meaningful units over one-node-per-file; use only file paths that appear in the input.",
    prompt: packed.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n"),
  });

  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const nodes: ArchNode[] = result.components
    .filter((c) => byPath.has(c.filePath))
    .map((c) => ({
      id: c.id,
      type: "component",
      position: { x: 0, y: 0 },
      data: {
        label: c.label,
        kind: c.kind,
        filePath: c.filePath,
        description: c.description,
        language: c.filePath.split(".").pop() ?? "text",
        code: truncateCode(byPath.get(c.filePath) ?? ""),
        exports: c.exports,
        imports: [],
        params: c.params,
        keywords: c.keywords,
      },
    }));
  const ids = new Set(nodes.map((n) => n.id));
  const edges: DependencyEdge[] = result.edges
    .filter((e) => ids.has(e.source) && ids.has(e.target) && e.source !== e.target)
    .map((e, i) => ({ id: `e-${i}-${e.source}--${e.target}`, ...e }));

  return {
    id: `import-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${Date.now().toString(36)}`,
    name,
    description: result.description,
    nodes: layoutByKind(nodes),
    edges,
    commits: [],
    scenarios: [],
    warnings,
  };
}
