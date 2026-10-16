import { NextResponse } from "next/server";
import { CLAUDE_MODEL, isClaudeEnabled } from "@/lib/server/claude";

export const dynamic = "force-dynamic";

export function GET() {
  const claude = isClaudeEnabled();
  return NextResponse.json({ engine: claude ? "claude" : "local", model: claude ? CLAUDE_MODEL : null });
}
