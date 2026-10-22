"use client";

import JSZip from "jszip";
import { GraphSchema } from "@/lib/graphSchema";
import { extractSourceFiles } from "@/lib/engines/zip";
import type { ArchitectureGraph, SourceFile } from "@/lib/types";

export const GRAPH_MANIFEST = "codearchitect.graph.json";
const MANIFEST_FORMAT = "codearchitect/v1";

/** Lower-case, dash-separated file stem for a graph name. */
export const fileStem = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "architecture";

/** Hand a blob to the browser as a download. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export const downloadText = (text: string, filename: string, type: string) => downloadBlob(new Blob([text], { type: `${type};charset=utf-8` }), filename);

const PNG_SCALE = 2;
const MAX_PNG_PIXELS = 16_000_000;

/** Rasterise an SVG document (needs a browser canvas). Scales down for very large diagrams. */
export async function svgToPngBlob(svg: string, width: number, height: number): Promise<Blob> {
  const scale = Math.min(PNG_SCALE, Math.sqrt(MAX_PNG_PIXELS / (width * height)));
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }));
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser cannot draw to a canvas.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("PNG encoding failed"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

export const graphManifestText = (graph: ArchitectureGraph) => JSON.stringify({ format: MANIFEST_FORMAT, exportedAt: new Date().toISOString(), graph }, null, 2);

/** Bundle every component's current code at its file path, plus a manifest that restores the exact graph. */
export async function exportCodebase(graph: ArchitectureGraph): Promise<void> {
  const zip = new JSZip();
  for (const node of graph.nodes) zip.file(node.data.filePath, node.data.code);
  zip.file(GRAPH_MANIFEST, graphManifestText(graph));
  downloadBlob(await zip.generateAsync({ type: "blob", compression: "DEFLATE" }), `${fileStem(graph.name)}-codebase.zip`);
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
