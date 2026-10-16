import "server-only";
import { AnthropicGenerator, describeAnthropicError } from "@/lib/server/ai/anthropic";
import { describeProvider, ProviderConfigError, resolveProviderConfig, type ProviderConfig } from "@/lib/server/ai/config";
import { describeOpenAIError, OpenAICompatibleGenerator } from "@/lib/server/ai/openaiCompatible";
import { ModelResponseError, type StructuredGenerator } from "@/lib/server/ai/types";

export type AiStatus =
  | { state: "enabled"; config: ProviderConfig; label: string }
  | { state: "disabled" }
  | { state: "misconfigured"; error: string };

export function getAiStatus(): AiStatus {
  try {
    const config = resolveProviderConfig(process.env);
    return config ? { state: "enabled", config, label: describeProvider(config) } : { state: "disabled" };
  } catch (error) {
    if (error instanceof ProviderConfigError) return { state: "misconfigured", error: error.message };
    throw error;
  }
}

let cached: { key: string; generator: StructuredGenerator } | null = null;

/** The generator for the current configuration, or an error explaining why there is none. */
export function getGenerator(): StructuredGenerator {
  const status = getAiStatus();
  if (status.state === "misconfigured") throw new ProviderConfigError(status.error);
  if (status.state === "disabled") throw new ProviderConfigError("No AI provider is configured.");

  const { config } = status;
  const key = JSON.stringify([config.provider, config.model, config.baseURL, config.apiKey ? "key" : "nokey"]);
  if (cached?.key !== key) {
    cached = {
      key,
      generator: config.protocol === "anthropic" ? new AnthropicGenerator(config) : new OpenAICompatibleGenerator(config),
    };
  }
  return cached.generator;
}

/** Short, user-safe description of a provider failure; never echoes keys or raw payloads. */
export function describeAiError(error: unknown): string {
  if (error instanceof ProviderConfigError || error instanceof ModelResponseError) return error.message;
  const status = getAiStatus();
  const label = status.state === "enabled" ? status.config.label : "The AI provider";
  return describeAnthropicError(error) ?? describeOpenAIError(error, label) ?? (error instanceof Error ? error.message : "Unknown error while calling the AI provider.");
}

export type { Effort, StructuredGenerator } from "@/lib/server/ai/types";
