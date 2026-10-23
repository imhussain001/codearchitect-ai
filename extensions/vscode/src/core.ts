import { findDeclarationLine } from "@/lib/engines/declarations";
import { buildHeuristicGraph, isAnalyzableSource } from "@/lib/engines/heuristicGraph";
import { analyzeHealth, type HealthReport, type NodeHealth } from "@/lib/engines/health";
import { edgeUses, exportUsage } from "@/lib/engines/symbols";
import { collectDependents } from "@/lib/graph";
import { kindLabelFor } from "@/lib/ui";
import type { ArchitectureGraph, ArchNode, DependencyEdge } from "@/lib/types";

/**
 * The editor-independent half of the VS Code extension: it turns workspace files into an index
 * that answers "what does this file affect?" and "who uses this symbol?". It never imports
 * `vscode`, so it is unit-tested directly and could back other editors.
 */

export type WorkspaceFile = { path: string; content: string };

/** A related file: where it is, what the map calls it, and how far from the origin (1 = direct). */
export type FileRef = { path: string; label: string; depth: number; symbols?: string[] };

export type BlastRadius = {
  direct: FileRef[];
  indirect: FileRef[];
  /** Direct importers that do not use the named symbol (only when a symbol was given). */
  spared: FileRef[];
};

export type FileSummary = {
  path: string;
  label: string;
  layer: string;
  dependents: number;
  indirectDependents: number;
  dependencies: number;
  /** 0–100 change-risk and its level, from the health analysis. */
  risk: number;
  level: NodeHealth["level"];
  reasons: string[];
};

export type SymbolUsage = { name: string; users: FileRef[]; uncertain: boolean; line: number | null };

const normalize = (path: string) => path.split("\\").join("/").replace(/^\.\//, "");

export { findDeclarationLine } from "@/lib/engines/declarations";

export class ArchIndex {
  readonly graph: ArchitectureGraph;
  readonly health: HealthReport;
  /** Analysable files that did not fit under the cap, so the UI can say so instead of pretending the map is complete. */
  readonly skipped: number;
  private readonly byPath = new Map<string, ArchNode>();
  private readonly contents = new Map<string, string>();

  private constructor(graph: ArchitectureGraph, files: readonly WorkspaceFile[], skipped: number) {
    this.graph = graph;
    this.health = analyzeHealth(graph);
    this.skipped = skipped;
    for (const node of graph.nodes) this.byPath.set(node.data.filePath, node);
    for (const f of files) this.contents.set(f.path, f.content);
  }

  /** Map the workspace. `maxFiles` bounds the work; files beyond it are counted in `skipped`, not silently dropped. */
  static build(name: string, files: readonly WorkspaceFile[], maxFiles: number): ArchIndex {
    const normalized = files.map((f) => ({ path: normalize(f.path), content: f.content })).filter((f) => isAnalyzableSource(f.path));
    const graph = buildHeuristicGraph(name, normalized, { maxFiles });
    const mapped = new Set(graph.nodes.map((n) => n.data.filePath));
    return new ArchIndex(graph, normalized, normalized.filter((f) => !mapped.has(f.path)).length);
  }

  /** The map's component for a workspace-relative path, if that file was mapped. */
  nodeFor(path: string): ArchNode | undefined {
    return this.byPath.get(normalize(path));
  }

  private ref(nodeId: string, depth: number, symbols?: string[]): FileRef | null {
    const node = this.graph.nodes.find((n) => n.id === nodeId);
    return node ? { path: node.data.filePath, label: node.data.label, depth, ...(symbols ? { symbols } : {}) } : null;
  }

  private realEdges(): DependencyEdge[] {
    return this.graph.edges.filter((e) => !e.isDraft && e.source !== e.target);
  }

  summary(path: string): FileSummary | null {
    const node = this.nodeFor(path);
    if (!node) return null;
    const edges = this.realEdges();
    const reach = collectDependents(node.id, edges);
    const direct = new Set(edges.filter((e) => e.target === node.id && e.relation !== "writes").map((e) => e.source));
    const health = this.health.nodes[node.id];
    return {
      path: node.data.filePath,
      label: node.data.label,
      layer: kindLabelFor(this.graph, node.data.kind),
      dependents: direct.size,
      indirectDependents: Math.max(0, reach.size - 1 - direct.size),
      dependencies: new Set(edges.filter((e) => e.source === node.id && e.relation !== "writes").map((e) => e.target)).size,
      risk: health?.score ?? 0,
      level: health?.level ?? "healthy",
      reasons: health?.reasons ?? [],
    };
  }

  /**
   * Everything a change to this file can reach. With `symbol`, only importers that use it count
   * (importers whose usage is unknown count too, never narrowed on a guess).
   */
  blastRadius(path: string, symbol?: string): BlastRadius | null {
    const node = this.nodeFor(path);
    if (!node) return null;
    const all = this.realEdges();
    const kept = symbol ? all.filter((e) => !(e.target === node.id && e.relation === "imports" && !edgeUses(e.symbols, symbol))) : all;
    const depths = collectDependents(node.id, kept);

    const direct: FileRef[] = [];
    const indirect: FileRef[] = [];
    for (const [id, depth] of depths) {
      if (id === node.id) continue;
      const via = kept.find((e) => e.source === id && e.target === node.id);
      const ref = this.ref(id, depth, via?.symbols);
      if (ref) (depth === 1 ? direct : indirect).push(ref);
    }
    const spared = symbol
      ? all
          .filter((e) => e.target === node.id && e.relation === "imports" && !kept.includes(e))
          .map((e) => this.ref(e.source, 1, e.symbols))
          .filter((r): r is FileRef => r !== null)
      : [];
    const byLabel = (a: FileRef, b: FileRef) => a.depth - b.depth || a.label.localeCompare(b.label);
    return { direct: direct.sort(byLabel), indirect: indirect.sort(byLabel), spared: spared.sort(byLabel) };
  }

  /** For each export of a file: who uses it, and where it is declared (0-based line). */
  symbolUsage(path: string): SymbolUsage[] {
    const node = this.nodeFor(path);
    if (!node) return [];
    const content = this.contents.get(node.data.filePath) ?? node.data.code;
    return exportUsage(this.graph, node.id).map((u) => {
      const name = u.name.replace(/^default\s+/, "");
      return {
        name,
        uncertain: u.uncertain,
        line: findDeclarationLine(content, name),
        users: u.users.map((id) => this.ref(id, 1)).filter((r): r is FileRef => r !== null),
      };
    });
  }

  /** Users of one symbol of a file. */
  usersOf(path: string, symbol: string): FileRef[] {
    return this.symbolUsage(path).find((u) => u.name === symbol)?.users ?? [];
  }
}
