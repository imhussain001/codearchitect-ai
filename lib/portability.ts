"use client";

import JSZip from "jszip";
import { GraphSchema } from "@/lib/graphSchema";
import { extractSourceFiles } from "@/lib/engines/zip";
import type { ArchitectureGraph, SourceFile } from "@/lib/types";

export const GRAPH_MANIFEST = "codearchitect.graph.json";
const MANIFEST_FORMAT = "codearchitect/v1";

/** Bundle every component's current code at its file path, plus a manifest that restores the exact graph. */
export async function exportCodebase(graph: ArchitectureGraph): Promise<void> {
  const zip = new JSZip();
  for (const node of graph.nodes) zip.file(node.data.filePath, node.data.code);
  zip.file(GRAPH_MANIFEST, JSON.stringify({ format: MANIFEST_FORMAT, exportedAt: new Date().toISOString(), graph }, null, 2));

  const blob = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${graph.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-codebase.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function parseGraphManifest(text: string): ArchitectureGraph {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The JSON file is not valid JSON.");
  }
  const candidate = (json as { graph?: unknown })?.graph ?? json;
  const parsed = GraphSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`Not a CodeArchitect graph: ${issue?.path.join(".") || "root"} — ${issue?.message ?? "invalid"}`);
  }
  return parsed.data as ArchitectureGraph;
}

export type ImportedUpload = { kind: "graph"; graph: ArchitectureGraph } | { kind: "sources"; name: string; files: SourceFile[]; skipped: number };

/** A `.json` manifest or an exported ZIP restores directly; any other ZIP is treated as source code to analyze. */
export async function readUpload(file: File): Promise<ImportedUpload> {
  if (file.name.toLowerCase().endsWith(".json")) return { kind: "graph", graph: parseGraphManifest(await file.text()) };
  if (!file.name.toLowerCase().endsWith(".zip")) throw new Error("Upload a .zip of your repository or a CodeArchitect .json export.");

  const buffer = await file.arrayBuffer();
  const zip = await JSZip.loadAsync(buffer);
  const manifest = zip.file(GRAPH_MANIFEST);
  if (manifest) return { kind: "graph", graph: parseGraphManifest(await manifest.async("string")) };

  const { files, skipped } = await extractSourceFiles(buffer);
  return { kind: "sources", name: file.name.replace(/\.zip$/i, ""), files, skipped };
}
