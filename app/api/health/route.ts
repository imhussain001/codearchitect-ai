import { NextResponse } from "next/server";
import { getAiStatus } from "@/lib/server/ai";

export const dynamic = "force-dynamic";

export function GET() {
  const status = getAiStatus();
  if (status.state === "enabled") {
    const { provider, model } = status.config;
    return NextResponse.json({ engine: "ai", label: status.label, provider, model });
  }
  return NextResponse.json({ engine: "local", label: null, provider: null, model: null, error: status.state === "misconfigured" ? status.error : undefined });
}
