import { narrateStoryWithClaude } from "@/lib/server/analyzers";
import { fail, parseBody, runWithFallback } from "@/lib/server/respond";
import { StoryRequestSchema } from "@/lib/server/schemas";
import type { ArchitectureGraph, StoryNarrative } from "@/lib/types";

export const maxDuration = 300;

function localNarrative(graph: ArchitectureGraph): StoryNarrative {
  return {
    overview: `${graph.commits.length} commits replayed from history. Configure Claude to generate an interpretive narrative.`,
    phases: graph.commits.map((c) => ({ hash: c.hash, phase: c.phase, narrative: c.narrative })),
    engine: "local",
  };
}

export async function POST(request: Request) {
  const body = await parseBody(request, StoryRequestSchema);
  if ("error" in body) return body.error;
  const graph = body.data.graph as ArchitectureGraph;
  if (graph.commits.length === 0) return fail("Import a git history first.", 400);

  return runWithFallback(() => narrateStoryWithClaude(graph), () => localNarrative(graph));
}
