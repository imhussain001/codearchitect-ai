import * as z from "zod/v4";
import { RulesSchema } from "@/lib/rulesSchema";

/** Shape of an architecture graph; shared by API validation and client-side JSON import. */

const MAX_NODES = 200;
const MAX_EDGES = 1_000;
const MAX_CODE_CHARS = 60_000;

const id = z.string().min(1).max(200);
const shortText = z.string().max(500);

const NodeDataSchema = z.object({
  label: shortText,
  kind: z.enum(["frontend", "api", "logic", "data"]),
  filePath: shortText,
  description: z.string().max(2_000),
  language: z.string().max(20),
  code: z.string().max(MAX_CODE_CHARS),
  exports: z.array(shortText).max(100),
  imports: z.array(shortText).max(200),
  params: z.array(z.object({ name: shortText, type: shortText, description: shortText.optional() })).max(50),
  keywords: z.array(z.string().max(60)).max(50),
  isDraft: z.boolean().optional(),
  lineCount: z.number().int().nonnegative().optional(),
});

const NodeSchema = z.object({
  id,
  type: z.literal("component"),
  position: z.object({ x: z.number(), y: z.number() }),
  data: NodeDataSchema,
});

const EdgeSchema = z.object({
  id,
  source: id,
  target: id,
  relation: z.enum(["calls", "reads", "writes", "imports", "publishes"]),
  label: shortText.optional(),
  isDraft: z.boolean().optional(),
  typeOnly: z.boolean().optional(),
  symbols: z.array(z.string()).optional(),
});

const CommitSchema = z.object({
  hash: z.string().max(40),
  message: z.string().max(1_000),
  author: shortText,
  date: shortText,
  phase: shortText,
  narrative: z.string().max(4_000),
  addedNodeIds: z.array(id).max(MAX_NODES),
  modifiedNodeIds: z.array(id).max(MAX_NODES),
});

const ScenarioSchema = z.object({
  id,
  title: shortText,
  triggers: z.array(z.string().max(200)).max(20),
  rootNodeId: id,
  summary: z.string().max(4_000),
  extraImpacts: z.array(z.object({ nodeId: id, reason: shortText })).max(MAX_NODES),
  diffs: z.array(z.object({ nodeId: id, after: z.string().max(MAX_CODE_CHARS), rationale: shortText })).max(MAX_NODES),
});

const MAX_DRIFT_POINTS = 200;

const DriftPointSchema = z.object({
  hash: z.string().max(64),
  message: z.string().max(500),
  author: z.string().max(200),
  date: z.string().max(40),
  components: z.number().int().min(0),
  dependencies: z.number().int().min(0),
  score: z.number().min(0).max(100),
  grade: z.string().max(2),
  cycles: z.number().int().min(0),
  violations: z.number().int().min(0),
});

export const GraphSchema = z.object({
  id,
  name: shortText,
  description: z.string().max(2_000),
  nodes: z.array(NodeSchema).max(MAX_NODES),
  edges: z.array(EdgeSchema).max(MAX_EDGES),
  commits: z.array(CommitSchema).max(500),
  scenarios: z.array(ScenarioSchema).max(50),
  rules: RulesSchema.optional(),
  kindLabels: z.record(z.enum(["frontend", "api", "logic", "data"]), z.string().max(60)).optional(),
  warnings: z.array(z.string()).optional(),
  drift: z.array(DriftPointSchema).max(MAX_DRIFT_POINTS).optional(),
});

