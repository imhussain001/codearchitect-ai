"use client";

import { useCallback, useState } from "react";
import type { Notice } from "@/hooks/useWorkspace";
import { buildMarkdownReport, renderSvg, toMermaid, type ReportOptions } from "@/lib/export";
import { downloadBlob, downloadText, exportCodebase, fileStem, graphManifestText, svgToPngBlob } from "@/lib/portability";
import type { ArchitectureGraph, RenderEdge, RenderNode } from "@/lib/types";

export type ExportKind = "zip" | "svg" | "png" | "mermaid" | "markdown" | "json";

type Inputs = {
  graph: ArchitectureGraph;
  /** What the canvas shows right now; diagram exports match it. */
  nodes: RenderNode[];
  edges: RenderEdge[];
  report: ReportOptions;
  notify: (notice: Notice | null) => void;
};

/** Runs one export at a time and reports failure through the notice banner. */
export function useExport({ graph, nodes, edges, report, notify }: Inputs) {
  const [busy, setBusy] = useState<ExportKind | null>(null);

  const run = useCallback(
    async (kind: ExportKind) => {
      const stem = fileStem(graph.name);
      setBusy(kind);
      try {
        if (kind === "zip") await exportCodebase(graph);
        else if (kind === "json") downloadText(graphManifestText(graph), `${stem}.graph.json`, "application/json");
        else if (kind === "mermaid") downloadText(toMermaid(graph), `${stem}.mmd`, "text/plain");
        else if (kind === "markdown") downloadText(buildMarkdownReport(graph, report), `${stem}-architecture.md`, "text/markdown");
        else {
          const drawing = renderSvg(nodes, edges, { title: graph.name, kindLabels: graph.kindLabels });
          if (kind === "svg") downloadText(drawing.svg, `${stem}.svg`, "image/svg+xml");
          else downloadBlob(await svgToPngBlob(drawing.svg, drawing.width, drawing.height), `${stem}.png`);
        }
      } catch (error) {
        notify({ tone: "error", message: `Export failed: ${error instanceof Error ? error.message : String(error)}` });
      } finally {
        setBusy(null);
      }
    },
    [graph, nodes, edges, report, notify],
  );

  return { run, busy };
}
