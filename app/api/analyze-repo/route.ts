import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import { extractSourceFiles } from "@/lib/engines/zip";
import { ingestWithClaude } from "@/lib/server/analyzers";
import { downloadRepoArchive, parseGithubUrl } from "@/lib/server/github";
import { fail, parseBody, runWithFallback } from "@/lib/server/respond";
import { AnalyzeRepoRequestSchema } from "@/lib/server/schemas";
import type { SourceFile } from "@/lib/types";

export const maxDuration = 300;

export async function POST(request: Request) {
  const body = await parseBody(request, AnalyzeRepoRequestSchema);
  if ("error" in body) return body.error;

  let name: string;
  let files: SourceFile[];
  if (body.data.kind === "github") {
    try {
      const ref = parseGithubUrl(body.data.url);
      const extracted = await extractSourceFiles(await downloadRepoArchive(ref));
      name = `${ref.owner}/${ref.repo}`;
      files = extracted.files;
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Could not download the repository.", 400);
    }
  } else {
    name = body.data.name;
    files = body.data.files;
  }
  if (files.length === 0) return fail("No supported source files found in the archive.", 422);

  return runWithFallback(() => ingestWithClaude(name, files), () => buildHeuristicGraph(name, files));
}
