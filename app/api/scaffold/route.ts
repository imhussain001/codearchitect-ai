import { scaffoldLocally } from "@/lib/engines/localScaffold";
import { scaffoldWithClaude } from "@/lib/server/analyzers";
import { parseBody, runWithFallback } from "@/lib/server/respond";
import { ScaffoldRequestSchema } from "@/lib/server/schemas";
import type { ArchitectureGraph } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await parseBody(request, ScaffoldRequestSchema);
  if ("error" in body) return body.error;
  const graph = body.data.graph as ArchitectureGraph;

  return runWithFallback(() => scaffoldWithClaude(graph), () => scaffoldLocally(graph));
}
