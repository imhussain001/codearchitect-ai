import { describe, expect, it } from "vitest";
import { ProviderConfigError, resolveProviderConfig } from "@/lib/server/ai/config";

describe("resolveProviderConfig", () => {
  it("returns null (local engine) when nothing is configured", () => {
    expect(resolveProviderConfig({})).toBeNull();
  });

  it("keeps the existing Anthropic setup working from just ANTHROPIC_API_KEY", () => {
    const config = resolveProviderConfig({ ANTHROPIC_API_KEY: "sk-ant-test" });
    expect(config).toMatchObject({ provider: "anthropic", protocol: "anthropic", model: "claude-opus-5-5", apiKey: "sk-ant-test" });
  });

  it("CODEARCHITECT_ENGINE=local wins over any key", () => {
    expect(resolveProviderConfig({ CODEARCHITECT_ENGINE: "local", ANTHROPIC_API_KEY: "k", AI_PROVIDER: "ollama" })).toBeNull();
  });

  it("configures Ollama without a key, using the local default endpoint", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "ollama", AI_MODEL: "llama3.1" });
    expect(config).toMatchObject({
      provider: "ollama",
      protocol: "openai-compatible",
      baseURL: "http://localhost:11434/v1",
      model: "llama3.1",
      apiKey: undefined,
      openaiReasoningParams: false,
    });
    expect(config!.maxInputChars).toBeLessThan(100_000);
  });

  it("uses Gemini's OpenAI-compatible endpoint and GEMINI_API_KEY", () => {
    const config = resolveProviderConfig({ AI_PROVIDER: "gemini", AI_MODEL: "gemini-pro", GEMINI_API_KEY: "g-key" });
    expect(config).toMatchObject({ protocol: "openai-compatible", apiKey: "g-key" });
    expect(config!.baseURL).toContain("generativelanguage.googleapis.com");
  });

  it("auto-detects OpenAI from OPENAI_API_KEY and enables reasoning parameters", () => {
    const config = resolveProviderConfig({ OPENAI_API_KEY: "o-key", AI_MODEL: "some-model" });
    expect(config).toMatchObject({ provider: "openai", openaiReasoningParams: true });
  });

  it("lets AI_BASE_URL, AI_API_KEY and AI_MAX_INPUT_CHARS override presets", () => {
    const config = resolveProviderConfig({
      AI_PROVIDER: "custom",
      AI_MODEL: "my-model",
      AI_BASE_URL: "http://gpu-box:8000/v1",
      AI_API_KEY: "secret",
      AI_MAX_INPUT_CHARS: "123456",
    });
    expect(config).toMatchObject({ baseURL: "http://gpu-box:8000/v1", apiKey: "secret", maxInputChars: 123456 });
  });

  it("fails loudly on an unknown provider instead of silently using the local engine", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "olama" })).toThrow(ProviderConfigError);
  });

  it("requires a model for providers without a default", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "ollama" })).toThrow(/AI_MODEL/);
  });

  it("requires a key for hosted providers", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "groq", AI_MODEL: "m" })).toThrow(/GROQ_API_KEY/);
  });

  it("requires a base URL for custom endpoints", () => {
    expect(() => resolveProviderConfig({ AI_PROVIDER: "custom", AI_MODEL: "m" })).toThrow(/AI_BASE_URL/);
  });

  it("legacy CODEARCHITECT_ENGINE=claude still forces Anthropic without a key env var", () => {
    expect(resolveProviderConfig({ CODEARCHITECT_ENGINE: "claude" })).toMatchObject({ provider: "anthropic", apiKey: undefined });
  });
});
