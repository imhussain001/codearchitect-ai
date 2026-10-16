import "server-only";
import { NextResponse } from "next/server";
import type * as z from "zod/v4";
import { describeAiError, getAiStatus } from "@/lib/server/ai";

export type ApiSuccess<T> = { ok: true; data: T; warning?: string };
export type ApiFailure = { ok: false; error: string };

export function fail(error: string, status: number): NextResponse<ApiFailure> {
  return NextResponse.json({ ok: false, error }, { status });
}

export async function parseBody<Schema extends z.ZodType>(
  request: Request,
  schema: Schema,
): Promise<{ data: z.infer<Schema> } | { error: NextResponse<ApiFailure> }> {
  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return { error: fail("Request body must be valid JSON.", 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { error: fail(`Invalid request: ${issue?.path.join(".") || "body"} — ${issue?.message ?? "invalid"}`, 400) };
  }
  return { data: parsed.data };
}

/**
 * Prefer the configured AI provider; on any failure (or a broken configuration)
 * fall back to the deterministic engine and surface why, so the UI never dead-ends.
 */
export async function runWithFallback<T>(
  withAi: () => Promise<T>,
  locally: () => T | Promise<T>,
): Promise<NextResponse<ApiSuccess<T> | ApiFailure>> {
  let warning: string | undefined;
  const status = getAiStatus();
  if (status.state === "misconfigured") {
    warning = `AI provider misconfigured: ${status.error} Showing the local engine's result instead.`;
  } else if (status.state === "enabled") {
    try {
      return NextResponse.json({ ok: true, data: await withAi() });
    } catch (error) {
      warning = `${describeAiError(error)} Showing the local engine's result instead.`;
      console.error(`[codearchitect] ${status.label} call failed:`, error);
    }
  }
  try {
    return NextResponse.json({ ok: true, data: await locally(), warning });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Analysis failed.", 422);
  }
}
