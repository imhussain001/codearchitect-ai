import * as z from "zod/v4";

/**
 * Pull a JSON value out of a model reply. Models without native structured output
 * often wrap JSON in ```json fences or add a sentence before/after it.
 */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed)?.[1];
  const candidates = [fenced, trimmed, sliceOutermost(trimmed, "{", "}"), sliceOutermost(trimmed, "[", "]")];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next candidate
    }
  }
  throw new SyntaxError("The model reply did not contain valid JSON.");
}

function sliceOutermost(text: string, open: string, close: string): string | undefined {
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  return start >= 0 && end > start ? text.slice(start, end + 1) : undefined;
}

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Parse and validate; the error string is phrased so it can be fed back to the model for a retry. */
export function parseStructured<Schema extends z.ZodType>(text: string, schema: Schema): ParseOutcome<z.infer<Schema>> {
  let json: unknown;
  try {
    json = extractJson(text);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Invalid JSON." };
  }
  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  return { ok: false, error: `JSON did not match the schema — ${issues}` };
}

/** JSON Schema for prompts and `response_format`, generated from the same Zod schema used to validate. */
export function jsonSchemaFor(schema: z.ZodType): Record<string, unknown> {
  return z.toJSONSchema(schema) as Record<string, unknown>;
}
