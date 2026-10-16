import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type * as z from "zod/v4";
import type { ProviderConfig } from "@/lib/server/ai/config";
import { MAX_OUTPUT_TOKENS, ModelResponseError, type GenerateOptions, type StructuredGenerator } from "@/lib/server/ai/types";

/** Re-run a policy decline on Anthropic's recommended fallback model, server-side. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicGenerator implements StructuredGenerator {
  private readonly client: Anthropic;

  constructor(readonly config: ProviderConfig) {
    // Without an explicit key the SDK resolves ANTHROPIC_AUTH_TOKEN or an `ant auth login` profile.
    this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey }) : new Anthropic();
  }

  async generate<Schema extends z.ZodType>(options: GenerateOptions<Schema>): Promise<z.infer<Schema>> {
    const response = await this.client.beta.messages.parse({
      model: this.config.model,
      max_tokens: MAX_OUTPUT_TOKENS,
      betas: [FALLBACK_BETA],
      fallbacks: "default",
      system: options.system,
      output_config: { effort: options.effort, format: betaZodOutputFormat(options.schema) },
      messages: [{ role: "user", content: options.prompt }],
    });

    if (response.stop_reason === "refusal") {
      throw new ModelResponseError(`The model declined this request (category: ${response.stop_details?.category ?? "unspecified"}).`);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ModelResponseError("The answer exceeded the output limit; try a smaller scope.");
    }
    if (!response.parsed_output) {
      throw new ModelResponseError("The model returned output that did not match the expected schema.");
    }
    return response.parsed_output as z.infer<Schema>;
  }
}

export function describeAnthropicError(error: unknown): string | null {
  if (error instanceof Anthropic.AuthenticationError) return "Anthropic rejected the configured credentials.";
  if (error instanceof Anthropic.RateLimitError) return "Anthropic rate limit reached; retry shortly.";
  if (error instanceof Anthropic.BadRequestError) return `Anthropic rejected the request: ${error.message}`;
  if (error instanceof Anthropic.APIConnectionError) return "Could not reach the Anthropic API.";
  if (error instanceof Anthropic.APIError) return `Anthropic API error (${error.status ?? "unknown"}).`;
  return null;
}
