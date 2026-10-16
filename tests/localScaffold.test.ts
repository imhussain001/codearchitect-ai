import { describe, expect, it } from "vitest";
import { scaffoldLocally, suggestFilePath } from "@/lib/engines/localScaffold";
import { authMicroservice } from "@/lib/mockData";
import type { ArchitectureGraph } from "@/lib/types";

describe("scaffoldLocally", () => {
  it("generates the new file and wires it into the existing parent", () => {
    const graph: ArchitectureGraph = {
      ...authMicroservice,
      nodes: [
        ...authMicroservice.nodes,
        {
          id: "draft-export-pdf",
          type: "component",
          position: { x: 0, y: 0 },
          data: {
            label: "Export PDF Button",
            kind: "frontend",
            filePath: suggestFilePath("Export PDF Button", "frontend"),
            description: "",
            language: "tsx",
            code: "",
            exports: [],
            imports: [],
            params: [],
            keywords: [],
            isDraft: true,
          },
        },
      ],
      edges: [...authMicroservice.edges, { id: "d1", source: "dashboard", target: "draft-export-pdf", relation: "calls", isDraft: true }],
    };

    const result = scaffoldLocally(graph);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]!.path).toBe("src/components/ExportPdfButton.tsx");
    expect(result.files[0]!.content).toContain("export default function ExportPdfButton()");

    const wiring = result.diffs[0]!;
    expect(wiring.nodeId).toBe("dashboard");
    expect(wiring.after).toContain('import ExportPdfButton from "@/components/ExportPdfButton";');
    expect(wiring.after).toContain("<ExportPdfButton />");
  });

  it("refuses to run with nothing drafted", () => {
    expect(() => scaffoldLocally(authMicroservice)).toThrow(/Add a component/);
  });
});
