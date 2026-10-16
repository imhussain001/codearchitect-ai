import "server-only";
import * as z from "zod/v4";
import { GraphSchema } from "@/lib/graphSchema";

/* ---------- Request validation (untrusted client input) ---------- */

export const MAX_PROMPT_CHARS = 2_000;
const id = z.string().min(1).max(200);
const shortText = z.string().max(500);

export const ImpactRequestSchema = z.object({
  graph: GraphSchema,
  prompt: z.string().trim().min(1).max(MAX_PROMPT_CHARS),
  selectedNodeId: id.nullable(),
});

export const StoryRequestSchema = z.object({ graph: GraphSchema });

export const ScaffoldRequestSchema = z.object({ graph: GraphSchema });

export const AnalyzeRepoRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github"), url: z.string().url().max(300) }),
  z.object({
    kind: z.literal("files"),
    name: shortText,
    files: z.array(z.object({ path: z.string().max(400), content: z.string().max(400_000) })).min(1).max(5_000),
  }),
]);

/* ---------- Model structured-output schemas (provider-neutral) ---------- */

export const AiImpactSchema = z.object({
  rootNodeId: z.string().describe("ID of the component where the change originates"),
  summary: z.string().describe("2-4 sentences: what changes, why dependents break, migration order"),
  riskScore: z.number().describe("0-100; breadth and depth of required changes"),
  impacts: z.array(
    z.object({
      nodeId: z.string(),
      severity: z.enum(["modified", "broken", "impacted"]),
      reason: z.string().describe("One sentence naming the concrete symbol/contract affected"),
    }),
  ),
  diffs: z.array(
    z.object({
      nodeId: z.string(),
      after: z.string().describe("The complete updated file content"),
      rationale: z.string(),
    }),
  ),
});

export const AiStorySchema = z.object({
  overview: z.string(),
  phases: z.array(z.object({ hash: z.string(), phase: z.string().describe("Short title, e.g. 'Phase 2 · Redis cache'"), narrative: z.string() })),
});

export const AiScaffoldSchema = z.object({
  summary: z.string(),
  files: z.array(z.object({ nodeId: z.string(), path: z.string(), content: z.string() })),
  edits: z.array(z.object({ nodeId: z.string(), after: z.string(), rationale: z.string() })),
});

export const AiIngestSchema = z.object({
  description: z.string(),
  components: z.array(
    z.object({
      id: z.string().describe("kebab-case unique id"),
      label: z.string(),
      kind: z.enum(["frontend", "api", "logic", "data"]),
      filePath: z.string().describe("Primary file path, exactly as given in the input"),
      description: z.string(),
      exports: z.array(z.string()),
      params: z.array(z.object({ name: z.string(), type: z.string() })),
      keywords: z.array(z.string()),
    }),
  ),
  edges: z.array(
    z.object({
      source: z.string(),
      target: z.string(),
      relation: z.enum(["calls", "reads", "writes", "imports", "publishes"]),
      label: z.string(),
    }),
  ),
});
