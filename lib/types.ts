import type { Edge, Node, XYPosition } from "@xyflow/react";

/** Architectural layer of a component. Drives node colour and layout row. */
export type NodeKind = "frontend" | "api" | "logic" | "data";

/**
 * Visual state of a node on the canvas. Derived from the active analysis,
 * story frame or builder draft — never persisted on the node itself.
 */
export type NodeStatus = "normal" | "modified" | "added" | "impacted" | "broken" | "proposed";

export type EngineKind = "claude" | "local";

export type CodeParam = {
  name: string;
  type: string;
  description?: string;
};

/**
 * Static facts about one software component. `type` (not `interface`) so it
 * satisfies React Flow's `Record<string, unknown>` data constraint.
 */
export type NodeData = {
  label: string;
  kind: NodeKind;
  filePath: string;
  description: string;
  language: string;
  code: string;
  exports: string[];
  imports: string[];
  params: CodeParam[];
  /** Extra search terms the local impact engine uses to match prompts to nodes. */
  keywords: string[];
  /** True for nodes drawn in the builder that do not exist in the codebase yet. */
  isDraft?: boolean;
};

/** Render-time data handed to `CustomNode`: static facts plus derived state. */
export type RenderNodeData = NodeData & {
  status: NodeStatus;
  impactReason?: string;
  impactDepth?: number;
};

export type ArchNode = Node<NodeData, "component">;
export type RenderNode = Node<RenderNodeData, "component">;

export type EdgeRelation = "calls" | "reads" | "writes" | "imports" | "publishes";

/**
 * Directed dependency: `source` depends on `target` (source calls/reads target).
 * Data-flow arrows are drawn source → target.
 */
export type DependencyEdge = {
  id: string;
  source: string;
  target: string;
  relation: EdgeRelation;
  label?: string;
  isDraft?: boolean;
};

export type EdgeRenderData = {
  relation: EdgeRelation;
  isImpactPath: boolean;
  isDraft: boolean;
};
export type RenderEdge = Edge<EdgeRenderData>;

/** One frame of the time machine: what a commit added/changed, plus its story. */
export type CommitSnapshot = {
  hash: string;
  message: string;
  author: string;
  date: string;
  phase: string;
  narrative: string;
  addedNodeIds: string[];
  modifiedNodeIds: string[];
};

/** A file-level change proposed for one node. `before` is the node's current code. */
export type DiffItem = {
  nodeId: string;
  filePath: string;
  before: string;
  after: string;
  rationale: string;
};

export type ImpactSeverity = "modified" | "broken" | "impacted";

export type NodeImpact = {
  nodeId: string;
  severity: ImpactSeverity;
  /** Hops from the root along reverse dependencies; 0 for the root itself. */
  depth: number;
  reason: string;
};

export type ImpactAnalysisResult = {
  prompt: string;
  rootNodeId: string;
  summary: string;
  /** 0–100 heuristic; higher means a wider or deeper blast radius. */
  riskScore: number;
  impacts: NodeImpact[];
  diffs: DiffItem[];
  engine: EngineKind;
  /** Name of the authored scenario the local engine matched, if any. */
  scenarioId?: string;
};

/** Hand-authored analysis used by the local engine for well-known prompts. */
export type ImpactScenario = {
  id: string;
  title: string;
  /** Case-insensitive regex sources; any match selects this scenario. */
  triggers: string[];
  rootNodeId: string;
  summary: string;
  /** Impacts the graph traversal cannot see (e.g. a value carried in a JWT claim). */
  extraImpacts: Array<{ nodeId: string; reason: string }>;
  diffs: Array<{ nodeId: string; after: string; rationale: string }>;
};

export type ArchitectureGraph = {
  id: string;
  name: string;
  description: string;
  nodes: ArchNode[];
  edges: DependencyEdge[];
  commits: CommitSnapshot[];
  scenarios: ImpactScenario[];
  /** Notes produced during ingestion (skipped files, truncation, heuristics used). */
  warnings?: string[];
};

export type ScaffoldFile = {
  path: string;
  content: string;
  nodeId: string;
};

export type ScaffoldResult = {
  files: ScaffoldFile[];
  /** Edits to existing nodes required to wire the new components in. */
  diffs: DiffItem[];
  summary: string;
  engine: EngineKind;
};

export type SourceFile = { path: string; content: string };

export type StoryNarrative = {
  overview: string;
  phases: Array<{ hash: string; phase: string; narrative: string }>;
  engine: EngineKind;
};

export type { XYPosition };
