import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import * as z from "zod/v4";
import { extractJson } from "@/lib/server/ai/json";
import { OpenAICompatibleGenerator } from "@/lib/server/ai/openaiCompatible";
import { ModelResponseError } from "@/lib/server/ai/types";
import type { ProviderConfig } from "@/lib/server/ai/config";

const Schema = z.object({ rootNodeId: z.string(), riskScore: z.number() });

type Handler = (body: Record<string, unknown>, call: number) => { status?: number; content?: string };

let server: Server | null = null;
let requests: Array<Record<string, unknown>> = [];

/** A minimal OpenAI-compatible /chat/completions endpoint driven by `handler`. */
async function startFakeServer(handler: Handler): Promise<string> {
  requests = [];
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      requests.push(body);
      const { status = 200, content = "" } = handler(body, requests.length);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status === 200
          ? JSON.stringify({ id: "x", object: "chat.completion", created: 0, model: "fake", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }] })
          : JSON.stringify({ error: { message: "unsupported response_format", type: "invalid_request_error" } }),
      );
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server!.address() as AddressInfo).port}/v1`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

function config(baseURL: string, overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return { provider: "ollama", label: "Ollama", protocol: "openai-compatible", model: "llama3.1", baseURL, openaiReasoningParams: false, maxInputChars: 40_000, ...overrides };
}

const options = { schema: Schema, schemaName: "impact", system: "sys", prompt: "go", effort: "high" as const };

describe("OpenAICompatibleGenerator", () => {
  it("falls back from json_schema to json_object and accepts fenced JSON", async () => {
    const baseURL = await startFakeServer((body) =>
      (body.response_format as { type: string } | undefined)?.type === "json_schema"
        ? { status: 400 }
        : { content: 'Sure!\n```json\n{"rootNodeId":"users-db","riskScore":42}\n```' },
    );
    const result = await new OpenAICompatibleGenerator(config(baseURL)).generate(options);

    expect(result).toEqual({ rootNodeId: "users-db", riskScore: 42 });
    expect(requests.map((r) => (r.response_format as { type: string }).type)).toEqual(["json_schema", "json_object"]);
    expect(requests[1]).toMatchObject({ model: "llama3.1", max_tokens: 16_000 });
    expect(requests[1]).not.toHaveProperty("reasoning_effort");
  });

  it("sends the JSON Schema in the system prompt so models without structured output still see it", async () => {
    const baseURL = await startFakeServer(() => ({ content: '{"rootNodeId":"a","riskScore":1}' }));
    await new OpenAICompatibleGenerator(config(baseURL)).generate(options);
    const system = (requests[0]!.messages as Array<{ role: string; content: string }>)[0]!;
    expect(system.role).toBe("system");
    expect(system.content).toContain('"rootNodeId"');
  });

  it("repairs once by sending the validation error back to the model", async () => {
    const baseURL = await startFakeServer((_, call) => ({ content: call === 1 ? '{"rootNodeId":"a"}' : '{"rootNodeId":"a","riskScore":7}' }));
    const result = await new OpenAICompatibleGenerator(config(baseURL)).generate(options);

    expect(result.riskScore).toBe(7);
    const retryMessages = requests[1]!.messages as Array<{ role: string; content: string }>;
    expect(retryMessages.at(-1)!.content).toMatch(/riskScore/);
  });

  it("gives up with a ModelResponseError after the repair attempt fails", async () => {
    const baseURL = await startFakeServer(() => ({ content: "I cannot produce JSON" }));
    await expect(new OpenAICompatibleGenerator(config(baseURL)).generate(options)).rejects.toBeInstanceOf(ModelResponseError);
    expect(requests).toHaveLength(2);
  });

  it("uses OpenAI's reasoning parameters when the preset asks for them", async () => {
    const baseURL = await startFakeServer(() => ({ content: '{"rootNodeId":"a","riskScore":1}' }));
    await new OpenAICompatibleGenerator(config(baseURL, { openaiReasoningParams: true, apiKey: "k" })).generate({ ...options, effort: "xhigh" });
    expect(requests[0]).toMatchObject({ max_completion_tokens: 16_000, reasoning_effort: "high" });
    expect(requests[0]).not.toHaveProperty("max_tokens");
  });
});

describe("extractJson", () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['```json\n{"a":1}\n```', { a: 1 }],
    ['Here you go: {"a":{"b":2}} — done.', { a: { b: 2 } }],
  ])("parses %j", (input, expected) => expect(extractJson(input)).toEqual(expected));

  it("throws when there is no JSON", () => {
    expect(() => extractJson("no json here")).toThrow(SyntaxError);
  });
});
