import * as z from "zod/v4";

const MAX_RULES = 50;
const MAX_SELECTOR_CHARS = 300;
const MAX_MESSAGE_CHARS = 300;

const id = z.string().min(1).max(80).regex(/^[A-Za-z0-9._-]+$/, "use letters, digits, . _ - only");
const selector = z.string().min(1).max(MAX_SELECTOR_CHARS);
const message = z.string().max(MAX_MESSAGE_CHARS).optional();
const severity = z.enum(["error", "warn"]).optional();

export const RuleSchema = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("forbid"), from: selector, to: selector, message, severity }),
  z.object({ id, type: z.literal("no-cycles"), message, severity }),
  z.object({ id, type: z.literal("max-dependents"), limit: z.number().int().nonnegative(), selector: selector.optional(), message, severity }),
  z.object({ id, type: z.literal("max-lines"), limit: z.number().int().positive(), selector: selector.optional(), message, severity }),
]);

export const RulesSchema = z
  .array(RuleSchema)
  .max(MAX_RULES)
  .refine((rules) => new Set(rules.map((r) => r.id)).size === rules.length, "rule ids must be unique");

/** Parse rules from JSON text with a message a person can act on. */
export function parseRulesJson(text: string): { ok: true; rules: z.infer<typeof RulesSchema> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: `Not valid JSON: ${error instanceof Error ? error.message : "parse error"}` };
  }
  const candidate = Array.isArray(json) ? json : (json as { rules?: unknown } | null)?.rules;
  const parsed = RulesSchema.safeParse(candidate);
  if (parsed.success) return { ok: true, rules: parsed.data };
  const issue = parsed.error.issues[0];
  const [first, ...rest] = issue?.path ?? [];
  const where = first === undefined ? "rules" : `rule ${typeof first === "number" ? first + 1 : String(first)} → ${rest.map(String).join(".") || "(rule)"}`;
  return { ok: false, error: `${where}: ${issue?.message ?? "invalid"}` };
}

export const EXAMPLE_RULES_JSON = JSON.stringify(
  [
    { id: "ui-not-data", type: "forbid", from: "kind:frontend", to: "kind:data", message: "UI must go through the API or logic layer" },
    { id: "no-cycles", type: "no-cycles" },
    { id: "small-hubs", type: "max-dependents", limit: 6, severity: "warn" },
  ],
  null,
  2,
);
