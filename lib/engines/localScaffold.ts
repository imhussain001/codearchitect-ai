import { nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ArchNode, DiffItem, NodeKind, ScaffoldFile, ScaffoldResult } from "@/lib/types";

function words(label: string): string[] {
  return label.replace(/([a-z])([A-Z])/g, "$1 $2").split(/[^A-Za-z0-9]+/).filter(Boolean);
}
export const pascalCase = (label: string) => words(label).map((w) => w[0]!.toUpperCase() + w.slice(1).toLowerCase()).join("");
export const camelCase = (label: string) => {
  const p = pascalCase(label);
  return p ? p[0]!.toLowerCase() + p.slice(1) : "component";
};
export const kebabCase = (label: string) => words(label).map((w) => w.toLowerCase()).join("-");

/** Conventional file location for a new component of the given kind (Next.js App Router layout). */
export function suggestFilePath(label: string, kind: NodeKind): string {
  switch (kind) {
    case "frontend":
      return `src/components/${pascalCase(label)}.tsx`;
    case "api":
      return `src/app/api/${kebabCase(label)}/route.ts`;
    case "logic":
      return `src/server/services/${camelCase(label)}.ts`;
    case "data":
      return `src/server/db/${kebabCase(label)}.ts`;
  }
}

/** The identifier other files import to use this component. */
export function primaryExport(label: string, kind: NodeKind): string {
  switch (kind) {
    case "frontend":
      return pascalCase(label);
    case "api":
      return "POST";
    case "logic":
      return `${camelCase(label)}Service`;
    case "data":
      return `${camelCase(label)}Repo`;
  }
}

function importSpecifier(filePath: string): string {
  return `@/${filePath.replace(/^src\//, "").replace(/\.(tsx?|jsx?)$/, "")}`;
}

function importLine(dep: ArchNode): string | null {
  if (dep.data.kind === "api") return null; // routes are reached over HTTP, not imported
  const name = primaryExport(dep.data.label, dep.data.kind);
  const clause = dep.data.kind === "frontend" ? name : `{ ${name} }`;
  return `import ${clause} from "${importSpecifier(dep.data.filePath)}";`;
}

function apiCall(dep: ArchNode): string {
  const route = dep.data.filePath.match(/app(\/api\/.+)\/route\.[jt]s$/)?.[1] ?? `/api/${kebabCase(dep.data.label)}`;
  return `fetch("${route}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })`;
}

function templateFor(node: ArchNode, deps: ArchNode[]): string {
  const { label, kind } = node.data;
  const imports = deps.map(importLine).filter((l): l is string => l !== null);
  const header = imports.length ? `${imports.join("\n")}\n\n` : "";
  const firstLogic = deps.find((d) => d.data.kind === "logic" || d.data.kind === "data");
  const firstApi = deps.find((d) => d.data.kind === "api");

  switch (kind) {
    case "frontend": {
      const action = firstApi
        ? `    const response = await ${apiCall(firstApi).replace("payload", "{}")};\n    if (!response.ok) throw new Error(\`${label} failed: \${response.status}\`);`
        : `    await Promise.resolve();`;
      return `"use client";

${header}import { useState } from "react";

export default function ${pascalCase(label)}() {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick() {
    setIsPending(true);
    setError(null);
    try {
${action}
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsPending(false);
    }
  }

  return (
    <div>
      <button type="button" onClick={handleClick} disabled={isPending}>
        {isPending ? "Working…" : "${label}"}
      </button>
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
`;
    }
    case "api": {
      const call = firstLogic ? `await ${primaryExport(firstLogic.data.label, firstLogic.data.kind)}.execute(body)` : "body";
      return `import { NextResponse } from "next/server";
${header}export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const result = ${call};
  return NextResponse.json(result, { status: 200 });
}
`;
    }
    case "logic": {
      const call = firstLogic ? `return ${primaryExport(firstLogic.data.label, firstLogic.data.kind)}.execute(input);` : "return { ok: true, input };";
      return `${header}export const ${primaryExport(label, kind)} = {
  async execute(input: unknown) {
    ${call}
  },
};
`;
    }
    case "data":
      return `${header}import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export const ${primaryExport(label, kind)} = {
  async execute(input: unknown) {
    const { rows } = await pool.query("SELECT $1::jsonb AS payload", [JSON.stringify(input)]);
    return rows[0];
  },
};
`;
  }
}

/** Insert an import after the last import, plus a JSX usage before the outermost closing tag when wiring UI into UI. */
function wireIntoExisting(source: ArchNode, target: ArchNode): DiffItem {
  const lines = source.data.code.split("\n");
  const line = importLine(target);
  const lastImport = lines.reduce((acc, l, i) => (/^\s*import\b/.test(l) ? i : acc), -1);
  if (line) lines.splice(lastImport + 1, 0, line);

  let usage = "imported";
  if (target.data.kind === "frontend" && /\.(tsx|jsx)$/.test(source.data.filePath)) {
    const closing = lines.reduce((acc, l, i) => (/^\s*<\/\w+>\s*$/.test(l) ? i : acc), -1);
    if (closing > 0) {
      const indent = (lines[closing]!.match(/^\s*/)?.[0] ?? "") + "  ";
      lines.splice(closing, 0, `${indent}<${pascalCase(target.data.label)} />`);
      usage = "rendered";
    }
  } else if (target.data.kind === "api") {
    lines.push("", `export async function call${pascalCase(target.data.label)}(payload: unknown) {`, `  return ${apiCall(target)}.then((r) => r.json());`, "}");
    usage = "called via a typed fetch helper";
  }

  return {
    nodeId: source.id,
    filePath: source.data.filePath,
    before: source.data.code,
    after: lines.join("\n"),
    rationale: `Wire in new ${target.data.label} (${usage}).`,
  };
}

export function scaffoldLocally(graph: ArchitectureGraph): ScaffoldResult {
  const drafts = graph.nodes.filter((n) => n.data.isDraft);
  const draftEdges = graph.edges.filter((e) => e.isDraft);
  if (drafts.length === 0 && draftEdges.length === 0) {
    throw new Error("Add a component or draw a connection in the builder first.");
  }

  const files: ScaffoldFile[] = drafts.map((node) => {
    const deps = graph.edges
      .filter((e) => e.source === node.id)
      .map((e) => nodeById(graph.nodes, e.target))
      .filter((n): n is ArchNode => Boolean(n));
    return { nodeId: node.id, path: node.data.filePath, content: templateFor(node, deps) };
  });

  // Existing files only change when a new edge makes them depend on something.
  const diffsBySource = new Map<string, DiffItem>();
  for (const edge of draftEdges) {
    const source = nodeById(graph.nodes, edge.source);
    const target = nodeById(graph.nodes, edge.target);
    if (!source || !target || source.data.isDraft) continue;
    const existing = diffsBySource.get(source.id);
    const base = existing ? { ...source, data: { ...source.data, code: existing.after } } : source;
    const diff = wireIntoExisting(base, target);
    diffsBySource.set(source.id, {
      ...diff,
      before: source.data.code,
      rationale: existing ? `${existing.rationale} ${diff.rationale}` : diff.rationale,
    });
  }

  return {
    files,
    diffs: [...diffsBySource.values()],
    summary: `Generated ${files.length} new file(s) and ${diffsBySource.size} wiring edit(s) from templates.`,
    engine: "local",
  };
}
