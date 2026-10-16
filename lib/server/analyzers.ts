import "server-only";
import { collectDependents, layoutByKind, nodeById } from "@/lib/graph";
import { computeRiskScore } from "@/lib/engines/localImpact";
import { selectGraphFiles, truncateCode } from "@/lib/engines/heuristicGraph";
import { getGenerator } from "@/lib/server/ai";
import { describeProvider as describeGenerator } from "@/lib/server/ai/config";
import { AiImpactSchema, AiIngestSchema, AiScaffoldSchema, AiStorySchema } from "@/lib/server/schemas";
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

const RISK_SCORE_MAX = 100;
const TRUNCATION_MARKER = "\n// … truncated to fit the model's context window";

/**
 * Cap each node's code so the whole graph fits the provider's input budget (small
 * local models have small windows). Returns the IDs whose code was cut, so callers
 * can refuse model-written "after" files that were based on partial code.
 */
function codeWithinBudget(graph: ArchitectureGraph, budgetChars: number): { code: Map<string, string>; truncated: Set<string> } {
  const total = graph.nodes.reduce((sum, n) => sum + n.data.code.length, 0);
  const perNode = total <= budgetChars ? Infinity : Math.floor(budgetChars / Math.max(1, graph.nodes.length));
  const code = new Map<string, string>();
  const truncated = new Set<string>();
  for (const n of graph.nodes) {
    if (n.data.code.length <= perNode) {
      code.set(n.id, n.data.code);
    } else {
      code.set(n.id, n.data.code.slice(0, perNode) + TRUNCATION_MARKER);
      truncated.add(n.id);
    }
  }
  return { code, truncated };
}

function serializeGraph(graph: ArchitectureGraph, code: ReadonlyMap<string, string> | null): string {
  const nodes = graph.nodes.map((n) => {
    const head = `<component id="${n.id}" kind="${n.data.kind}" path="${n.data.filePath}"${n.data.isDraft ? ' draft="true"' : ""}>\n` +
      `label: ${n.data.label}\ndescription: ${n.data.description}\nexports: ${n.data.exports.join(", ") || "-"}`;
    return code ? `${head}\n<code>\n${code.get(n.id) ?? ""}\n</code>\n</component>` : `${head}\n</component>`;
  });
  const edges = graph.edges.map((e) => `${e.source} -> ${e.target} (${e.relation}${e.label ? `: ${e.label}` : ""})${e.isDraft ? " [new]" : ""}`);
  return `<architecture name="${graph.name}">\n${nodes.join("\n")}\n<dependencies note="source depends on target">\n${edges.join("\n")}\n</dependencies>\n</architecture>`;
}

const SHARED_RULES =
  "Component IDs in your answer must be copied exactly from the input. Code you write must be complete files, not fragments, and must match the conventions already used in the codebase. Do not invent components that are not in the input.";

export async function analyzeImpactWithAi(
  graph: ArchitectureGraph,
  prompt: string,
  selectedNodeId: string | null,
): Promise<ImpactAnalysisResult> {
  const generator = getGenerator();
  const { code, truncated } = codeWithinBudget(graph, generator.config.maxInputChars);
  const result = await generator.generate({
    schema: AiImpactSchema,
    schemaName: "impact_analysis",
    effort: "high",
    system: `You are a principal engineer performing refactoring impact analysis on a dependency graph. Identify the component where the requested change originates, every component that must change or will break as a consequence (including non-obvious couplings such as serialized payloads, cache contents and token claims), and write the concrete updated code for each affected file. Severity: "modified" = origin, "broken" = will fail to compile or misbehave without edits, "impacted" = needs review or a smaller edit. ${SHARED_RULES}`,
    prompt: `${serializeGraph(graph, code)}\n\n<selected_component>${selectedNodeId ?? "none"}</selected_component>\n<change_request>${prompt}</change_request>`,
  });

  const rootNodeId = nodeById(graph.nodes, result.rootNodeId) ? result.rootNodeId : selectedNodeId;
  if (!rootNodeId) throw new Error(`${generator.config.model} did not identify a valid origin component.`);

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
    // An "after" written from truncated code would silently delete the unseen remainder.
    diffs: result.diffs.flatMap((d) => {
      const node = nodeById(graph.nodes, d.nodeId);
      return node && !truncated.has(d.nodeId)
        ? [{ nodeId: d.nodeId, filePath: node.data.filePath, before: node.data.code, after: d.after, rationale: d.rationale }]
        : [];
    }),
    engine: "ai",
    engineLabel: describeGenerator(generator.config),
  };
}

export async function narrateStoryWithAi(graph: ArchitectureGraph): Promise<StoryNarrative> {
  if (graph.commits.length === 0) throw new Error("This repository has no commit history to narrate.");
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
  const history = graph.commits
    .map((c) => `<commit hash="${c.hash}" date="${c.date}" author="${c.author}">\nmessage: ${c.message}\nadded: ${c.addedNodeIds.map(label).join(", ") || "-"}\nmodified: ${c.modifiedNodeIds.map(label).join(", ") || "-"}\n</commit>`)
    .join("\n");

  const generator = getGenerator();
  const result = await generator.generate({
    schema: AiStorySchema,
    schemaName: "story_narrative",
    effort: "medium",
    system:
      "You are a software archaeologist. Explain how this architecture evolved as a short narrative: for each commit, one titled phase that says what structurally changed and the most plausible engineering reason, and flag couplings or regressions a future maintainer should know. Ground every claim in the commit messages and component changes provided; say when a motive is inferred. Return one phase per commit, using the given hashes.",
    prompt: `${serializeGraph(graph, null)}\n\n<history order="oldest first">\n${history}\n</history>`,
  });

  const known = new Set(graph.commits.map((c) => c.hash));
  return { overview: result.overview, phases: result.phases.filter((p) => known.has(p.hash)), engine: "ai", engineLabel: describeGenerator(generator.config) };
}

export async function scaffoldWithAi(graph: ArchitectureGraph): Promise<ScaffoldResult> {
  const generator = getGenerator();
  const { code, truncated } = codeWithinBudget(graph, generator.config.maxInputChars);
  const result = await generator.generate({
    schema: AiScaffoldSchema,
    schemaName: "scaffold",
    effort: "high",
    system: `You generate production-quality scaffolding for new components drawn on an architecture diagram. Components marked draft="true" do not exist yet: write one complete file for each at its given path. Dependencies marked [new] must be wired: edit every existing (non-draft) source file of a [new] dependency so it actually uses the new target. Handle errors explicitly and keep each file focused. ${SHARED_RULES}`,
    prompt: serializeGraph(graph, code),
  });

  const drafts = new Set(graph.nodes.filter((n) => n.data.isDraft).map((n) => n.id));
  return {
    summary: result.summary,
    files: result.files.filter((f) => drafts.has(f.nodeId)),
    diffs: result.edits.flatMap((e) => {
      const node = nodeById(graph.nodes, e.nodeId);
      return node && !drafts.has(e.nodeId) && !truncated.has(e.nodeId)
        ? [{ nodeId: e.nodeId, filePath: node.data.filePath, before: node.data.code, after: e.after, rationale: e.rationale }]
        : [];
    }),
    engine: "ai",
    engineLabel: describeGenerator(generator.config),
  };
}

/** Pack as many whole files as fit the budget; report exactly what was left out. */
function packSources(files: readonly SourceFile[], budgetChars: number): { packed: SourceFile[]; omitted: number } {
  const packed: SourceFile[] = [];
  let budget = budgetChars;
  for (const file of files) {
    if (file.content.length > budget) continue;
    packed.push(file);
    budget -= file.content.length;
  }
  return { packed, omitted: files.length - packed.length };
}

export async function ingestWithAi(name: string, files: readonly SourceFile[]): Promise<ArchitectureGraph> {
  const generator = getGenerator();
  const { selected, warnings } = selectGraphFiles(files);
  const { packed, omitted } = packSources(selected, generator.config.maxInputChars);
  if (omitted > 0) {
    warnings.push(
      `${omitted} file(s) did not fit ${generator.config.model}'s input budget (${generator.config.maxInputChars.toLocaleString()} chars); raise AI_MAX_INPUT_CHARS if the model's context allows.`,
    );
  }

  const result = await generator.generate({
    schema: AiIngestSchema,
    schemaName: "architecture_graph",
    effort: "medium",
    system:
      "You map a codebase into an architecture graph of 4-25 components. A component is an architectural unit (a page, an API route, a service/controller, a datastore or cache) anchored to one primary file. Edges point from the dependent to its dependency. Prefer meaningful units over one-node-per-file; use only file paths that appear in the input.",
    prompt: packed.map((f) => `<file path="${f.path}">\n${f.content}\n</file>`).join("\n"),
  });

  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const seenIds = new Set<string>();
  const nodes: ArchNode[] = result.components
    .filter((c) => byPath.has(c.filePath) && !seenIds.has(c.id) && Boolean(seenIds.add(c.id)))
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
    description: `${result.description} (mapped by ${describeGenerator(generator.config)})`,
    nodes: layoutByKind(nodes),
    edges,
    commits: [],
    scenarios: [],
    warnings,
  };
}
