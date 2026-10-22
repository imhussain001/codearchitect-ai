import "server-only";
import { readFile } from "node:fs/promises";
import { NextResponse } from "next/server";
import { parsePreload, PRELOAD_ENV } from "@/lib/preload";

export const dynamic = "force-dynamic";

/** The graph `codearchitect view` prepared, or 204 when the app was started normally. Serves only the file named by the launcher's env var. */
export async function GET() {
  const file = process.env[PRELOAD_ENV];
  if (!file) return new NextResponse(null, { status: 204 });
  try {
    return NextResponse.json(parsePreload(await readFile(file, "utf8")));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 });
  }
}
