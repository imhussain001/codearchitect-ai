import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { analyzeImpactWithClaude } from "@/lib/server/analyzers";
import { parseBody, runWithFallback } from "@/lib/server/respond";
import { ImpactRequestSchema } from "@/lib/server/schemas";
import type { ArchitectureGraph } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await parseBody(request, ImpactRequestSchema);
  if ("error" in body) return body.error;
  const { prompt, selectedNodeId } = body.data;
  const graph = body.data.graph as ArchitectureGraph;

  return runWithFallback(
    () => analyzeImpactWithClaude(graph, prompt, selectedNodeId),
    () => analyzeImpactLocally(graph, prompt, selectedNodeId),
  );
}
