import type { ArchNode, DependencyEdge, NodeKind } from "@/lib/types";

/**
 * Breadth-first walk over *reverse* dependencies: everything that (transitively)
 * depends on `rootId`. Returns hop distance per reached node, root included at 0.
 * O(V + E).
 */
export function collectDependents(rootId: string, edges: readonly DependencyEdge[]): Map<string, number> {
  const dependentsOf = new Map<string, string[]>();
  for (const edge of edges) {
    const list = dependentsOf.get(edge.target) ?? [];
    list.push(edge.source);
    dependentsOf.set(edge.target, list);
  }

  const depth = new Map<string, number>([[rootId, 0]]);
  const queue: string[] = [rootId];
  for (let head = 0; head < queue.length; head++) {
    const current = queue[head]!;
    const currentDepth = depth.get(current)!;
    for (const dependent of dependentsOf.get(current) ?? []) {
      if (depth.has(dependent)) continue;
      depth.set(dependent, currentDepth + 1);
      queue.push(dependent);
    }
  }
  return depth;
}

/** Edges whose both endpoints are in the impacted set — the propagation path to highlight. */
export function impactPathEdgeIds(edges: readonly DependencyEdge[], impacted: ReadonlySet<string>): Set<string> {
  return new Set(edges.filter((e) => impacted.has(e.source) && impacted.has(e.target)).map((e) => e.id));
}

const KIND_ROW: Record<NodeKind, number> = { frontend: 0, api: 1, logic: 2, data: 3 };
const LAYOUT_COLUMN_SPACING_PX = 250;
const LAYOUT_ROW_SPACING_PX = 190;
const LAYOUT_MAX_PER_ROW = 5;

/**
 * Layered layout: one band per architectural layer (UI → API → logic → data),
 * wrapping wide layers onto extra rows. Deterministic, so re-imports are stable.
 */
export function layoutByKind(nodes: readonly ArchNode[]): ArchNode[] {
  const byKind = new Map<NodeKind, ArchNode[]>();
  for (const node of nodes) {
    const list = byKind.get(node.data.kind) ?? [];
    list.push(node);
    byKind.set(node.data.kind, list);
  }

  const placed: ArchNode[] = [];
  let rowCursor = 0;
  for (const kind of Object.keys(KIND_ROW) as NodeKind[]) {
    const group = byKind.get(kind) ?? [];
    for (let start = 0; start < group.length; start += LAYOUT_MAX_PER_ROW) {
      const row = group.slice(start, start + LAYOUT_MAX_PER_ROW);
      const rowWidth = (row.length - 1) * LAYOUT_COLUMN_SPACING_PX;
      row.forEach((node, i) => {
        placed.push({
          ...node,
          position: { x: i * LAYOUT_COLUMN_SPACING_PX - rowWidth / 2 + 500, y: rowCursor * LAYOUT_ROW_SPACING_PX },
        });
      });
      rowCursor++;
    }
  }
  return placed;
}

export function nodeById(nodes: readonly ArchNode[], id: string): ArchNode | undefined {
  return nodes.find((n) => n.id === id);
}

/** Identifier names a node exposes, stripped of `default`/`type` decorations. */
export function exportedIdentifiers(node: ArchNode): string[] {
  return node.data.exports
    .map((e) => e.replace(/^(default|type|async)\s+/g, "").trim())
    .flatMap((e) => e.split(/\s+/))
    .filter((e) => /^[A-Za-z_$][\w$]*$/.test(e) && e !== "default");
}
