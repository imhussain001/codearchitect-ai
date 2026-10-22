import type { Edge, Node, XYPosition } from "@xyflow/react";

/** Architectural layer of a component. Drives node colour and layout row. */
export type NodeKind = "frontend" | "api" | "logic" | "data";

/**
 * Visual state of a node on the canvas. Derived from the active analysis,
 * story frame or builder draft — never persisted on the node itself.
 */
export type NodeStatus = "normal" | "modified" | "added" | "impacted" | "broken" | "proposed";

/** Structural risk of one component, from `analyzeHealth`. */
export type HealthLevel = "healthy" | "watch" | "risky";

export type EngineKind = "ai" | "local";

/** What `/api/health` reports: which engine analysis routes try first. */
export type EngineInfo = {
  engine: EngineKind;
  /** e.g. "llama3.1 · Ollama"; null for the local engine. */
  label: string | null;
  provider: string | null;
  model: string | null;
  /** Set when an AI provider was requested but its configuration is incomplete. */
  error?: string;
};

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
  /** Real size of the source file; `code` may be truncated for display. */
  lineCount?: number;
};

/** Render-time data handed to `CustomNode`: static facts plus derived state. */
export type RenderNodeData = NodeData & {
  status: NodeStatus;
  /** Human label for `kind` in this graph (script graphs rename the layers). */
  kindLabel: string;
  impactReason?: string;
  impactDepth?: number;
  /** Set only while the Health overlay is on. */
  heat?: { level: HealthLevel; score: number };
  /** True when focus mode is on and this node is outside the focused neighbourhood. */
  dimmed?: boolean;
  /** Number of architecture-rule violations involving this node (shown in the Health view). */
  violations?: number;
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
  /** Only `import type`: erased at runtime. Health ignores it; blast radius and rules still count it. */
  typeOnly?: boolean;
};

export type EdgeRenderData = {
  relation: EdgeRelation;
  isImpactPath: boolean;
  isDraft: boolean;
  /** Part of a circular dependency (Health overlay). */
  isCycle: boolean;
  /** Breaks an architecture rule (Health overlay). */
  isViolation: boolean;
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
  /** Which model produced an AI result, e.g. "llama3.1 · Ollama". */
  engineLabel?: string;
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

export type RuleSeverity = "error" | "warn";

/**
 * An architecture constraint. Selectors are `|`-separated alternatives of `kind:<layer>`,
 * `path:<glob>`, `id:<node id>`, `label:<glob>`, or `*`; a bare word matches a label or a path.
 */
export type ArchRule =
  | { id: string; type: "forbid"; from: string; to: string; message?: string; severity?: RuleSeverity }
  | { id: string; type: "no-cycles"; message?: string; severity?: RuleSeverity }
  | { id: string; type: "max-dependents"; limit: number; selector?: string; message?: string; severity?: RuleSeverity }
  | { id: string; type: "max-lines"; limit: number; selector?: string; message?: string; severity?: RuleSeverity };

export type RuleViolation = {
  ruleId: string;
  ruleType: ArchRule["type"];
  severity: RuleSeverity;
  message: string;
  nodeIds: string[];
  /** Edges that break the rule (forbidden dependencies, cycle edges); empty for node-level rules. */
  edgeIds: string[];
};

export type ArchitectureGraph = {
  id: string;
  name: string;
  description: string;
  nodes: ArchNode[];
  edges: DependencyEdge[];
  commits: CommitSnapshot[];
  scenarios: ImpactScenario[];
  /** Constraints this architecture must satisfy; evaluated by `evaluateRules`. */
  rules?: ArchRule[];
  /** Overrides for the four layer names, e.g. MATLAB graphs call `data` "Data files". */
  kindLabels?: Partial<Record<NodeKind, string>>;
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
  engineLabel?: string;
};

export type SourceFile = { path: string; content: string };

export type StoryNarrative = {
  overview: string;
  phases: Array<{ hash: string; phase: string; narrative: string }>;
  engine: EngineKind;
  engineLabel?: string;
};

export type { XYPosition };
