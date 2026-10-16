/**
 * Provider selection, as a pure function of the environment so it is testable.
 *
 * Two wire protocols cover every supported provider:
 * - "anthropic": the Anthropic Messages API (Claude).
 * - "openai-compatible": the OpenAI Chat Completions API, which OpenAI, Google Gemini,
 *   Ollama, LM Studio, OpenRouter, Groq and DeepSeek all expose.
 */

export type Protocol = "anthropic" | "openai-compatible";

export type ProviderId =
  | "anthropic"
  | "openai"
  | "gemini"
  | "ollama"
  | "lmstudio"
  | "openrouter"
  | "groq"
  | "deepseek"
  | "custom";

type Preset = {
  label: string;
  protocol: Protocol;
  defaultModel?: string;
  baseURL?: string;
  /** Env var holding this provider's key; `AI_API_KEY` always overrides it. */
  keyEnv?: string;
  /** Local servers accept any key; a placeholder keeps the SDK from refusing to start. */
  requiresKey: boolean;
  /** Uses OpenAI's newer `max_completion_tokens` / `reasoning_effort` parameters. */
  openaiReasoningParams?: boolean;
  /** Characters of source the repo-ingestion prompt may carry (context-window budget). */
  maxInputChars: number;
};

const LARGE_CONTEXT_CHARS = 600_000;
const MEDIUM_CONTEXT_CHARS = 200_000;
/** Local models often run with 8k–32k token windows; stay well inside them. */
const LOCAL_CONTEXT_CHARS = 40_000;

export const PROVIDER_PRESETS: Record<ProviderId, Preset> = {
  anthropic: { label: "Anthropic", protocol: "anthropic", defaultModel: "claude-opus-5-5", keyEnv: "ANTHROPIC_API_KEY", requiresKey: true, maxInputChars: LARGE_CONTEXT_CHARS },
  openai: { label: "OpenAI", protocol: "openai-compatible", baseURL: "https://api.openai.com/v1", keyEnv: "OPENAI_API_KEY", requiresKey: true, openaiReasoningParams: true, maxInputChars: MEDIUM_CONTEXT_CHARS },
  gemini: { label: "Google Gemini", protocol: "openai-compatible", baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/", keyEnv: "GEMINI_API_KEY", requiresKey: true, maxInputChars: LARGE_CONTEXT_CHARS },
  ollama: { label: "Ollama", protocol: "openai-compatible", baseURL: "http://localhost:11434/v1", requiresKey: false, maxInputChars: LOCAL_CONTEXT_CHARS },
  lmstudio: { label: "LM Studio", protocol: "openai-compatible", baseURL: "http://localhost:1234/v1", requiresKey: false, maxInputChars: LOCAL_CONTEXT_CHARS },
  openrouter: { label: "OpenRouter", protocol: "openai-compatible", baseURL: "https://openrouter.ai/api/v1", keyEnv: "OPENROUTER_API_KEY", requiresKey: true, maxInputChars: MEDIUM_CONTEXT_CHARS },
  groq: { label: "Groq", protocol: "openai-compatible", baseURL: "https://api.groq.com/openai/v1", keyEnv: "GROQ_API_KEY", requiresKey: true, maxInputChars: MEDIUM_CONTEXT_CHARS },
  deepseek: { label: "DeepSeek", protocol: "openai-compatible", baseURL: "https://api.deepseek.com/v1", keyEnv: "DEEPSEEK_API_KEY", requiresKey: true, maxInputChars: MEDIUM_CONTEXT_CHARS },
  custom: { label: "Custom endpoint", protocol: "openai-compatible", requiresKey: false, maxInputChars: MEDIUM_CONTEXT_CHARS },
};

export type ProviderConfig = {
  provider: ProviderId;
  label: string;
  protocol: Protocol;
  model: string;
  baseURL?: string;
  apiKey?: string;
  openaiReasoningParams: boolean;
  maxInputChars: number;
};

export type Env = Readonly<Record<string, string | undefined>>;

export class ProviderConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderConfigError";
  }
}

/** With no AI_PROVIDER, the first provider whose key is present wins, in this order. */
const AUTO_DETECT_ORDER: ProviderId[] = ["anthropic", "openai", "gemini", "openrouter", "groq", "deepseek"];

function isProviderId(value: string): value is ProviderId {
  return value in PROVIDER_PRESETS;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/**
 * Resolve which model provider to use, or `null` for the local engine.
 *
 * - `CODEARCHITECT_ENGINE=local` always disables AI.
 * - `AI_PROVIDER` picks a provider explicitly (required for keyless local servers like Ollama).
 * - Otherwise the first provider with a key in the environment is used.
 * - `CODEARCHITECT_ENGINE=claude` (legacy) forces Anthropic even without a key env var,
 *   so an `ant auth login` profile can supply credentials.
 *
 * Throws `ProviderConfigError` for an explicit but incomplete configuration, so a typo
 * fails loudly instead of silently falling back to the local engine.
 */
export function resolveProviderConfig(env: Env): ProviderConfig | null {
  const engine = (nonEmpty(env.CODEARCHITECT_ENGINE) ?? "auto").toLowerCase();
  if (engine === "local") return null;

  const requested = nonEmpty(env.AI_PROVIDER)?.toLowerCase();
  let provider: ProviderId | undefined;
  if (requested) {
    if (!isProviderId(requested)) {
      throw new ProviderConfigError(`Unknown AI_PROVIDER "${requested}". Use one of: ${Object.keys(PROVIDER_PRESETS).join(", ")}.`);
    }
    provider = requested;
  } else if (engine === "claude") {
    provider = "anthropic";
  } else {
    provider = AUTO_DETECT_ORDER.find((id) => nonEmpty(env[PROVIDER_PRESETS[id].keyEnv ?? ""]));
  }
  if (!provider) return null;

  const preset = PROVIDER_PRESETS[provider];
  const apiKey = nonEmpty(env.AI_API_KEY) ?? (preset.keyEnv ? nonEmpty(env[preset.keyEnv]) : undefined);
  const model = nonEmpty(env.AI_MODEL) ?? preset.defaultModel;
  const baseURL = nonEmpty(env.AI_BASE_URL) ?? preset.baseURL;

  if (!model) throw new ProviderConfigError(`${preset.label} needs a model name: set AI_MODEL (e.g. AI_MODEL=llama3.1 for Ollama).`);
  if (preset.protocol === "openai-compatible" && !baseURL) {
    throw new ProviderConfigError(`${preset.label} needs AI_BASE_URL (an OpenAI-compatible endpoint, e.g. http://localhost:8000/v1).`);
  }
  // Anthropic may authenticate from an `ant` profile when forced via CODEARCHITECT_ENGINE=claude.
  const keyOptional = !preset.requiresKey || (provider === "anthropic" && engine === "claude");
  if (!apiKey && !keyOptional) {
    throw new ProviderConfigError(`${preset.label} needs an API key: set ${preset.keyEnv ?? "AI_API_KEY"} (or AI_API_KEY).`);
  }

  const maxInputChars = Number(nonEmpty(env.AI_MAX_INPUT_CHARS));
  return {
    provider,
    label: preset.label,
    protocol: preset.protocol,
    model,
    baseURL,
    apiKey,
    openaiReasoningParams: Boolean(preset.openaiReasoningParams),
    maxInputChars: Number.isFinite(maxInputChars) && maxInputChars > 0 ? maxInputChars : preset.maxInputChars,
  };
}

/** Human-readable engine label, e.g. "llama3.1 · Ollama". */
export function describeProvider(config: ProviderConfig): string {
  return `${config.model} · ${config.label}`;
}
