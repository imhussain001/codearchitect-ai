import type * as z from "zod/v4";
import type { ProviderConfig } from "@/lib/server/ai/config";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export type GenerateOptions<Schema extends z.ZodType> = {
  schema: Schema;
  /** Short identifier for the output shape, e.g. "impact_analysis". */
  schemaName: string;
  system: string;
  prompt: string;
  /** How hard the model should think; adapters map it to what their API supports. */
  effort: Effort;
};

/** The single capability every analysis needs: return JSON that matches a schema. */
export interface StructuredGenerator {
  readonly config: ProviderConfig;
  generate<Schema extends z.ZodType>(options: GenerateOptions<Schema>): Promise<z.infer<Schema>>;
}

/** A provider answered, but not with something usable (refusal, truncation, invalid JSON). */
export class ModelResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelResponseError";
  }
}

export const MAX_OUTPUT_TOKENS = 16_000;
