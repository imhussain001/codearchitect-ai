import OpenAI from "openai";
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam } from "openai/resources/chat/completions";
import type * as z from "zod/v4";
import type { ProviderConfig } from "@/lib/server/ai/config";
import { jsonSchemaFor, parseStructured } from "@/lib/server/ai/json";
import { MAX_OUTPUT_TOKENS, ModelResponseError, type Effort, type GenerateOptions, type StructuredGenerator } from "@/lib/server/ai/types";

/** Local servers ignore the key, but the SDK refuses to start without one. */
const PLACEHOLDER_API_KEY = "not-needed";
/** One corrective round-trip when the reply is not valid JSON for the schema. */
const MAX_REPAIR_ATTEMPTS = 1;

/**
 * Structured-output support varies by server, so degrade step by step:
 * strict JSON Schema → generic JSON mode → plain text. The schema is always
 * in the system prompt too, and every reply is validated with Zod regardless.
 */
type FormatMode = "json_schema" | "json_object" | "none";
const FORMAT_MODES: FormatMode[] = ["json_schema", "json_object", "none"];

function reasoningEffort(effort: Effort): "low" | "medium" | "high" {
  return effort === "xhigh" || effort === "max" ? "high" : effort;
}

export class OpenAICompatibleGenerator implements StructuredGenerator {
  private readonly client: OpenAI;
  /** Remember the best format a server accepted so later calls skip known failures. */
  private formatIndex = 0;

  constructor(readonly config: ProviderConfig) {
    this.client = new OpenAI({ apiKey: config.apiKey ?? PLACEHOLDER_API_KEY, baseURL: config.baseURL });
  }

  async generate<Schema extends z.ZodType>(options: GenerateOptions<Schema>): Promise<z.infer<Schema>> {
    const schemaJson = jsonSchemaFor(options.schema);
    const messages: ChatCompletionMessageParam[] = [
      {
        role: "system",
        content: `${options.system}\n\nRespond with a single JSON object only — no prose, no code fences — matching this JSON Schema:\n${JSON.stringify(schemaJson)}`,
      },
      { role: "user", content: options.prompt },
    ];

    for (let attempt = 0; ; attempt++) {
      const text = await this.complete(messages, options, schemaJson);
      const outcome = parseStructured(text, options.schema);
      if (outcome.ok) return outcome.value;
      if (attempt >= MAX_REPAIR_ATTEMPTS) {
        throw new ModelResponseError(`${this.config.model} did not return valid structured output: ${outcome.error}`);
      }
      messages.push({ role: "assistant", content: text }, { role: "user", content: `${outcome.error}. Reply again with only the corrected JSON object.` });
    }
  }

  private async complete(messages: ChatCompletionMessageParam[], options: GenerateOptions<z.ZodType>, schemaJson: Record<string, unknown>): Promise<string> {
    for (; this.formatIndex < FORMAT_MODES.length; this.formatIndex++) {
      const mode = FORMAT_MODES[this.formatIndex]!;
      try {
        const response = await this.client.chat.completions.create(this.buildRequest(messages, options, schemaJson, mode));
        const choice = response.choices[0];
        if (!choice) throw new ModelResponseError("The model returned no choices.");
        if (choice.finish_reason === "length") throw new ModelResponseError("The answer exceeded the output limit; try a smaller scope.");
        if (choice.finish_reason === "content_filter") throw new ModelResponseError("The provider's content filter blocked the answer.");
        const content = choice.message.content;
        if (!content) throw new ModelResponseError(choice.message.refusal ? `The model declined: ${choice.message.refusal}` : "The model returned an empty answer.");
        return content;
      } catch (error) {
        // A 400/422 on a structured-output request usually means "format not supported": try the next mode.
        const unsupportedFormat = error instanceof OpenAI.APIError && (error.status === 400 || error.status === 422) && mode !== "none";
        if (!unsupportedFormat) throw error;
      }
    }
    throw new ModelResponseError("The endpoint rejected every request format.");
  }

  private buildRequest(
    messages: ChatCompletionMessageParam[],
    options: GenerateOptions<z.ZodType>,
    schemaJson: Record<string, unknown>,
    mode: FormatMode,
  ): ChatCompletionCreateParamsNonStreaming {
    const request: ChatCompletionCreateParamsNonStreaming = { model: this.config.model, messages };
    if (this.config.openaiReasoningParams) {
      request.max_completion_tokens = MAX_OUTPUT_TOKENS;
      request.reasoning_effort = reasoningEffort(options.effort);
    } else {
      request.max_tokens = MAX_OUTPUT_TOKENS;
    }
    if (mode === "json_schema") {
      request.response_format = { type: "json_schema", json_schema: { name: options.schemaName, schema: schemaJson, strict: false } };
    } else if (mode === "json_object") {
      request.response_format = { type: "json_object" };
    }
    return request;
  }
}

export function describeOpenAIError(error: unknown, label: string): string | null {
  if (error instanceof OpenAI.AuthenticationError) return `${label} rejected the configured API key.`;
  if (error instanceof OpenAI.RateLimitError) return `${label} rate limit reached; retry shortly.`;
  if (error instanceof OpenAI.NotFoundError) return `${label} does not know that model — check AI_MODEL.`;
  if (error instanceof OpenAI.APIConnectionError) return `Could not reach ${label}${label === "Ollama" || label === "LM Studio" ? " — is it running?" : "."}`;
  if (error instanceof OpenAI.APIError) return `${label} API error (${error.status ?? "unknown"}).`;
  return null;
}
