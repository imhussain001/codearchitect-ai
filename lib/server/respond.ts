import "server-only";
import { NextResponse } from "next/server";
import type * as z from "zod/v4";
import { describeClaudeError, isClaudeEnabled } from "@/lib/server/claude";

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
 * Prefer Claude when configured; on any Claude failure fall back to the
 * deterministic engine and surface why, so the UI never dead-ends.
 */
export async function runWithFallback<T>(
  withClaude: () => Promise<T>,
  locally: () => T | Promise<T>,
): Promise<NextResponse<ApiSuccess<T> | ApiFailure>> {
  let warning: string | undefined;
  if (isClaudeEnabled()) {
    try {
      return NextResponse.json({ ok: true, data: await withClaude() });
    } catch (error) {
      warning = `${describeClaudeError(error)} Showing the local engine's result instead.`;
      console.error("[codearchitect] Claude call failed:", error);
    }
  }
  try {
    return NextResponse.json({ ok: true, data: await locally(), warning });
  } catch (error) {
    return fail(error instanceof Error ? error.message : "Analysis failed.", 422);
  }
}
