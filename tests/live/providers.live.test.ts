/**
 * Runs every AI feature against real models and writes a scorecard.
 *
 *   LIVE_TARGETS="gemini:<model>,groq:<model>" npm run test:live
 *
 * Keys come from the environment or .env.local (GEMINI_API_KEY, GROQ_API_KEY, …).
 * Each case checks the output against the graph, not just that JSON came back.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { authMicroservice, ecommerceApi } from "@/lib/mockData";
import { suggestFilePath } from "@/lib/engines/localScaffold";
import { analyzeImpactWithAi, ingestWithAi, narrateStoryWithAi, scaffoldWithAi } from "@/lib/server/analyzers";
import { describeAiError } from "@/lib/server/ai";
import type { ArchitectureGraph, SourceFile } from "@/lib/types";

if (existsSync(".env.local")) process.loadEnvFile(".env.local");

type Target = { provider: string; model: string };
const targets: Target[] = (process.env.LIVE_TARGETS ?? "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean)
  .map((t) => {
    const [provider, ...rest] = t.split(":");
    return { provider: provider!, model: rest.join(":") };
  });

/** Pause between calls so free-tier per-minute limits are not the thing being measured. */
const PAUSE_BETWEEN_CALLS_MS = Number(process.env.LIVE_PAUSE_MS ?? 8_000);

type Row = { target: string; feature: string; ok: boolean; seconds: number; detail: string };
const rows: Row[] = [];

function useTarget({ provider, model }: Target): void {
  process.env.CODEARCHITECT_ENGINE = "auto";
  process.env.AI_PROVIDER = provider;
  process.env.AI_MODEL = model;
}

async function record(target: Target, feature: string, run: () => Promise<string>): Promise<void> {
  useTarget(target);
  const started = Date.now();
  try {
    const detail = await run();
    rows.push({ target: `${target.provider}:${target.model}`, feature, ok: true, seconds: (Date.now() - started) / 1000, detail });
  } catch (error) {
    const message = error instanceof Error && error.name === "AssertionError" ? error.message.split("\n")[0]! : describeAiError(error);
    rows.push({ target: `${target.provider}:${target.model}`, feature, ok: false, seconds: (Date.now() - started) / 1000, detail: message });
    throw error;
  } finally {
    await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_CALLS_MS));
  }
}

function scaffoldGraph(): ArchitectureGraph {
  return {
    ...authMicroservice,
    nodes: [
      ...authMicroservice.nodes,
      {
        id: "draft-export-pdf-button",
        type: "component",
        position: { x: 600, y: 0 },
        data: {
          label: "Export PDF Button",
          kind: "frontend",
          filePath: suggestFilePath("Export PDF Button", "frontend"),
          description: "Button that downloads the user's profile as a PDF.",
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
    edges: [...authMicroservice.edges, { id: "draft-e", source: "dashboard", target: "draft-export-pdf-button", relation: "calls", isDraft: true }],
  };
}

/** A real slice of this repository for the ingest test (~25k characters). */
function repoSlice(): SourceFile[] {
  const paths = [
    "app/api/impact/route.ts",
    "app/api/story/route.ts",
    "lib/server/respond.ts",
    "lib/engines/localImpact.ts",
    "lib/graph.ts",
    "lib/diff.ts",
    "lib/mockData.ts",
    "components/inspector/DiffViewer.tsx",
  ];
  return paths.map((path) => ({ path, content: readFileSync(path, "utf8") }));
}

describe.skipIf(targets.length === 0)("live providers", () => {
  for (const target of targets) {
    describe(`${target.provider}:${target.model}`, () => {
      it("impact · UUID migration (Auth Microservice)", async () => {
        await record(target, "impact-uuid", async () => {
          const result = await analyzeImpactWithAi(authMicroservice, "Change `userId` from integer to UUID v4", null);
          const broken = result.impacts.filter((i) => i.severity === "broken").map((i) => i.nodeId);
          expect(result.rootNodeId, "root should be the users table").toBe("users-db");
          expect(broken, "auth controller must break").toContain("auth-controller");
          expect(result.diffs.length, "should propose code edits").toBeGreaterThan(0);
          const changed = result.diffs.filter((d) => d.after.trim() !== d.before.trim()).length;
          return `root ok · ${result.impacts.length} impacts (${broken.length} broken) · ${changed}/${result.diffs.length} diffs change code · risk ${result.riskScore}`;
        });
      });

      it("impact · price to integer cents (E-Commerce)", async () => {
        await record(target, "impact-cents", async () => {
          const result = await analyzeImpactWithAi(ecommerceApi, "Store prices as integer cents instead of float dollars", null);
          const ids = result.impacts.map((i) => i.nodeId);
          expect(result.rootNodeId, "root should be the orders/products DB").toBe("orders-db");
          expect(ids, "payment adapter's *100 coupling must be found").toContain("payment-adapter");
          return `root ok · found payment coupling · ${ids.length} impacts · ${result.diffs.length} diffs`;
        });
      });

      it("story · narrate Auth Microservice history", async () => {
        await record(target, "story", async () => {
          const story = await narrateStoryWithAi(authMicroservice);
          expect(story.phases.length, "one phase per commit with valid hashes").toBe(authMicroservice.commits.length);
          expect(story.overview.length).toBeGreaterThan(40);
          return `${story.phases.length}/${authMicroservice.commits.length} phases · overview ${story.overview.length} chars`;
        });
      });

      it("scaffold · Export PDF Button wired into dashboard", async () => {
        await record(target, "scaffold", async () => {
          const result = await scaffoldWithAi(scaffoldGraph());
          expect(result.files.length, "one new file for the draft").toBe(1);
          expect(result.files[0]!.content.length).toBeGreaterThan(80);
          const wired = result.diffs.some((d) => d.nodeId === "dashboard" && /ExportPdf|Export PDF/i.test(d.after));
          return `${result.files.length} file (${result.files[0]!.content.split("\n").length} lines) · dashboard ${wired ? "wired" : "NOT wired"}`;
        });
      });

      it("ingest · map a slice of this repository", async () => {
        await record(target, "ingest", async () => {
          const graph = await ingestWithAi("codearchitect-slice", repoSlice());
          expect(graph.nodes.length, "at least 4 components").toBeGreaterThanOrEqual(4);
          expect(graph.edges.length, "some dependencies").toBeGreaterThan(0);
          return `${graph.nodes.length} components · ${graph.edges.length} edges · kinds ${[...new Set(graph.nodes.map((n) => n.data.kind))].join("/")}`;
        });
      });
    });
  }
});

afterAll(() => {
  if (rows.length === 0) return;
  const lines = [
    "| Model | Feature | Result | Time | Detail |",
    "|---|---|---|---|---|",
    ...rows.map((r) => `| ${r.target} | ${r.feature} | ${r.ok ? "PASS" : "FAIL"} | ${r.seconds.toFixed(1)}s | ${r.detail.replace(/\|/g, "/")} |`),
  ];
  const dir = process.env.LIVE_REPORT_DIR ?? join("tests", "live", ".results");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "scorecard.md"), `${lines.join("\n")}\n`);
  writeFileSync(join(dir, "scorecard.json"), JSON.stringify(rows, null, 2));
  console.log(`\n${lines.join("\n")}\n`);
});
