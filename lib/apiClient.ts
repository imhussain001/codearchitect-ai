"use client";

import { buildHeuristicGraph, selectGraphFiles } from "@/lib/engines/heuristicGraph";
import { analyzeImpactLocally } from "@/lib/engines/localImpact";
import { scaffoldLocally } from "@/lib/engines/localScaffold";
import type { ArchitectureGraph, EngineKind, ImpactAnalysisResult, ScaffoldResult, SourceFile, StoryNarrative } from "@/lib/types";

export type Outcome<T> = { data: T; warning?: string };

type Envelope<T> = { ok: true; data: T; warning?: string } | { ok: false; error: string };

/** Thrown when the server could not be reached at all (dev server down, offline). */
class NetworkError extends Error {}

async function postJson<T>(url: string, body: unknown): Promise<Outcome<T>> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  } catch (error) {
    throw new NetworkError(error instanceof Error ? error.message : "network error");
  }
  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new Error(`Server returned ${response.status} with an unreadable body.`);
  }
  if (!envelope.ok) throw new Error(envelope.error);
  return { data: envelope.data, warning: envelope.warning };
}

const OFFLINE_WARNING = "Analysis server unreachable — ran the local engine in your browser.";

async function withOfflineFallback<T>(remote: () => Promise<Outcome<T>>, local: () => T): Promise<Outcome<T>> {
  try {
    return await remote();
  } catch (error) {
    if (!(error instanceof NetworkError)) throw error;
    return { data: local(), warning: OFFLINE_WARNING };
  }
}

export function requestImpact(graph: ArchitectureGraph, prompt: string, selectedNodeId: string | null): Promise<Outcome<ImpactAnalysisResult>> {
  return withOfflineFallback(
    () => postJson("/api/impact", { graph, prompt, selectedNodeId }),
    () => analyzeImpactLocally(graph, prompt, selectedNodeId),
  );
}

export function requestScaffold(graph: ArchitectureGraph): Promise<Outcome<ScaffoldResult>> {
  return withOfflineFallback(() => postJson("/api/scaffold", { graph }), () => scaffoldLocally(graph));
}

export function requestStory(graph: ArchitectureGraph): Promise<Outcome<StoryNarrative>> {
  return postJson("/api/story", { graph });
}

export function requestRepoFromFiles(name: string, files: SourceFile[]): Promise<Outcome<ArchitectureGraph>> {
  const { selected, warnings } = selectGraphFiles(files);
  return withOfflineFallback(
    () => postJson<ArchitectureGraph>("/api/analyze-repo", { kind: "files", name, files: selected }),
    () => buildHeuristicGraph(name, files),
  ).then((outcome) => ({ ...outcome, warning: [outcome.warning, ...warnings].filter(Boolean).join(" ") || undefined }));
}

export function requestRepoFromGithub(url: string): Promise<Outcome<ArchitectureGraph>> {
  return postJson("/api/analyze-repo", { kind: "github", url });
}

export async function fetchEngine(): Promise<{ engine: EngineKind; model: string | null }> {
  try {
    const response = await fetch("/api/health");
    return (await response.json()) as { engine: EngineKind; model: string | null };
  } catch {
    return { engine: "local", model: null };
  }
}
