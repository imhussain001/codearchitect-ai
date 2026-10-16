import type { ArchNode, NodeData, XYPosition } from "@/lib/types";

export function makeNode(id: string, position: XYPosition, data: NodeData): ArchNode {
  return { id, type: "component", position, data };
}
