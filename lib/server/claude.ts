import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z from "zod/v4";

export const CLAUDE_MODEL = "claude-opus-5-5";
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
const MAX_OUTPUT_TOKENS = 16_000;

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export class ClaudeUnavailableError extends Error {
  constructor() {
    super("Claude is not configured (set ANTHROPIC_API_KEY, or CODEARCHITECT_ENGINE=claude with an `ant auth login` profile).");
    this.name = "ClaudeUnavailableError";
  }
}

export class ClaudeResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeResponseError";
  }
}

/**
 * `CODEARCHITECT_ENGINE`: "local" forces the deterministic engine, "claude"
 * forces Claude (credentials may come from an `ant` profile), "auto" (default)
 * uses Claude only when an API key/token is present in the environment.
 */
export function isClaudeEnabled(): boolean {
  const mode = (process.env.CODEARCHITECT_ENGINE ?? "auto").toLowerCase();
  if (mode === "local") return false;
  if (mode === "claude") return true;
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

let client: Anthropic | null = null;
function getClient(): Anthropic {
  if (!isClaudeEnabled()) throw new ClaudeUnavailableError();
  client ??= new Anthropic();
  return client;
}

/**
 * One structured-output call. The response is schema-validated by the SDK;
 * callers still validate cross-references (node IDs) against their graph.
 */
export async function generateStructured<Schema extends z.ZodType>(options: {
  schema: Schema;
  system: string;
  prompt: string;
  effort: Effort;
}): Promise<z.infer<Schema>> {
  const response = await getClient().beta.messages.parse({
    model: CLAUDE_MODEL,
    max_tokens: MAX_OUTPUT_TOKENS,
    betas: [FALLBACK_BETA],
    fallbacks: "default",
    system: options.system,
    output_config: { effort: options.effort, format: betaZodOutputFormat(options.schema) },
    messages: [{ role: "user", content: options.prompt }],
  });

  if (response.stop_reason === "refusal") {
    const category = response.stop_details?.category ?? "unspecified";
    throw new ClaudeResponseError(`Claude declined this request (category: ${category}).`);
  }
  if (response.stop_reason === "max_tokens") {
    throw new ClaudeResponseError("Claude's answer exceeded the output limit; try a smaller scope.");
  }
  if (!response.parsed_output) {
    throw new ClaudeResponseError("Claude returned output that did not match the expected schema.");
  }
  return response.parsed_output as z.infer<Schema>;
}

/** Map SDK errors to a short, user-safe message (never echo keys or raw payloads). */
export function describeClaudeError(error: unknown): string {
  if (error instanceof ClaudeUnavailableError || error instanceof ClaudeResponseError) return error.message;
  if (error instanceof Anthropic.AuthenticationError) return "Claude rejected the configured credentials.";
  if (error instanceof Anthropic.RateLimitError) return "Claude rate limit reached; retry shortly.";
  if (error instanceof Anthropic.BadRequestError) return `Claude rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return "Could not reach the Claude API.";
  if (error instanceof Anthropic.APIError) return `Claude API error (${error.status ?? "unknown"}).`;
  return error instanceof Error ? error.message : "Unknown error while calling Claude.";
}
