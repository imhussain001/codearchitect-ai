// Builds a CodeArchitect graph of the CodeArchitect AI repo itself.
// Components/descriptions/scenarios are hand-authored; edges come from real imports;
// scenario diffs are exact-string edits against the real files (throws if any edit misses).
// Usage: npm run graph:self  (or: node scripts/build-self-graph.mjs <repoRoot> <outFile>)
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const [root, outFile] = process.argv.slice(2);
if (!root || !outFile) throw new Error("usage: node build-self-graph.mjs <repoRoot> <outFile>");
const read = (p) => readFileSync(join(root, p), "utf8").replace(/\r\n/g, "\n");

/** [id, label, kind, path, description, keywords, params] */
const COMPONENTS = [
  // ---- Frontend / UI
  ["page", "Workspace Page", "frontend", "app/page.tsx", "Composition root: owns the reducer, derives the render graph, and runs every async flow (impact, story, scaffold, import, export) with stale-result guards.", ["page", "workspace", "root", "layout"], []],
  ["top-nav", "Top Navigation", "frontend", "components/TopNav.tsx", "Repository selector (samples, imported graph, Custom Upload), engine badge, and the three global actions.", ["nav", "toolbar", "selector", "header"], [{ name: "onSelectRepository", type: "(id: string) => void" }]],
  ["canvas", "Architecture Canvas", "frontend", "components/ArchitectureCanvas.tsx", "Controlled React Flow canvas: background, controls, minimap, legends; forwards node changes, selection and new connections.", ["canvas", "reactflow", "graph", "minimap", "edges"], [{ name: "nodes", type: "RenderNode[]" }, { name: "edges", type: "RenderEdge[]" }]],
  ["custom-node", "Component Node", "frontend", "components/CustomNode.tsx", "Custom node card: kind colour, status dot/glow, quick actions injected through NodeActionsContext.", ["node", "card", "glow", "status", "handle"], [{ name: "data", type: "RenderNodeData" }]],
  ["inspector-panel", "Inspector Drawer", "frontend", "components/InspectorPanel.tsx", "Tabbed right drawer routing workspace state into the four mode panels.", ["inspector", "drawer", "tabs", "sidebar"], [{ name: "state", type: "WorkspaceState" }]],
  ["node-inspector", "Node Inspector Tab", "frontend", "components/inspector/NodeInspector.tsx", "Code, exports, imports, params and dependency links for the selected component.", ["inspector", "node", "exports", "imports"], []],
  ["blast-panel", "Blast Radius Tab", "frontend", "components/inspector/BlastRadiusPanel.tsx", "Prompt box, risk meter, affected-component list and diffs for an impact analysis.", ["blast", "radius", "impact", "risk", "prompt"], [{ name: "result", type: "ImpactAnalysisResult | null" }]],
  ["story-panel", "Story Tab", "frontend", "components/inspector/StoryPanel.tsx", "Time-machine transport controls, commit timeline, narration and git-log importer.", ["story", "timeline", "commits", "history", "git"], []],
  ["builder-panel", "Builder Tab", "frontend", "components/inspector/BuilderPanel.tsx", "Add draft components, list draft edges, generate and apply scaffolding.", ["builder", "scaffold", "draft", "generate"], []],
  ["diff-viewer", "Diff Viewer", "frontend", "components/inspector/DiffViewer.tsx", "Collapsible side-by-side diff cards built on the LCS line diff.", ["diff", "side", "before", "after"], [{ name: "items", type: "DiffItem[]" }]],
  ["code-block", "Code Block", "frontend", "components/inspector/CodeBlock.tsx", "Line-numbered code view with lightweight lexical highlighting and copy button.", ["code", "highlight", "syntax", "copy"], [{ name: "code", type: "string" }]],
  ["import-dialog", "Import Dialog", "frontend", "components/ImportDialog.tsx", "Modal for ZIP/JSON drop and GitHub URL submission.", ["import", "upload", "zip", "github", "dialog"], []],
  ["search-box", "Search & Focus Box", "frontend", "components/SearchBox.tsx", "Accessible combobox over components plus the focus-mode toggle; / and Ctrl+K focus it.", ["search", "focus", "combobox", "find"], [{ name: "nodes", type: "ArchNode[]" }]],
  ["guided-tour", "Guided Tour", "frontend", "components/GuidedTour.tsx", "Spotlight overlay that walks a first-time user through the real controls, switching drawer tabs as needed.", ["tour", "onboarding", "help", "spotlight"], [{ name: "open", type: "boolean" }]],
  ["health-panel", "Health Tab", "frontend", "components/inspector/HealthPanel.tsx", "Grade, riskiest components and plain-language issues; clicking one pans the canvas to it.", ["health", "risk", "cycle", "hub", "grade"], [{ name: "report", type: "HealthReport" }]],
  ["glossary", "Glossary", "frontend", "components/Glossary.tsx", "Collapsible plain-language definitions of blast radius, broken/impacted, hop, change-risk and more.", ["glossary", "terms", "help"], []],

  // ---- API routes
  ["api-impact", "POST /api/impact", "api", "app/api/impact/route.ts", "Validates the graph + prompt, then Claude or the local impact engine.", ["impact", "route", "api", "endpoint"], [{ name: "body", type: "{ graph, prompt, selectedNodeId }" }]],
  ["api-story", "POST /api/story", "api", "app/api/story/route.ts", "Narrates commit history with Claude, or echoes commit-derived narratives.", ["story", "route", "api", "narrate"], [{ name: "body", type: "{ graph }" }]],
  ["api-scaffold", "POST /api/scaffold", "api", "app/api/scaffold/route.ts", "Generates files for draft components and wiring edits.", ["scaffold", "route", "api"], [{ name: "body", type: "{ graph }" }]],
  ["api-analyze", "POST /api/analyze-repo", "api", "app/api/analyze-repo/route.ts", "Ingests uploaded files or a GitHub archive into an architecture graph.", ["analyze", "ingest", "repo", "route", "api", "github"], [{ name: "body", type: "{ kind: 'github', url } | { kind: 'files', name, files }" }]],
  ["api-health", "GET /api/health", "api", "app/api/health/route.ts", "Reports whether Claude is enabled and which model.", ["health", "engine", "route", "api"], []],

  // ---- Business logic (client + shared)
  ["workspace-store", "Workspace Reducer", "logic", "hooks/useWorkspace.ts", "Single reducer for all UI state: graph, selection, impact, story, builder, notices.", ["reducer", "state", "workspace", "store"], [{ name: "action", type: "WorkspaceAction" }]],
  ["view-model", "Render View-Model", "logic", "lib/viewModel.ts", "Pure overlay of impact/story/draft status onto nodes and edges (precedence: story > impact > draft).", ["viewmodel", "render", "status", "overlay"], [{ name: "inputs", type: "ViewInputs" }]],
  ["api-client", "API Client", "logic", "lib/apiClient.ts", "Typed fetch wrappers; falls back to in-browser engines when the server is unreachable.", ["client", "fetch", "api", "fallback"], []],
  ["portability", "Export / Import", "logic", "lib/portability.ts", "ZIP export of all component code plus manifest; restores graphs from JSON or exported ZIPs.", ["export", "import", "zip", "manifest"], [{ name: "file", type: "File" }]],
  ["graph-core", "Graph Algorithms", "logic", "lib/graph.ts", "Reverse-dependency BFS, impact-path edges, layered layout, identifier extraction.", ["graph", "bfs", "dependents", "layout", "collectdependents", "depth"], [{ name: "rootId", type: "string" }, { name: "edges", type: "DependencyEdge[]" }]],
  ["line-diff", "Line Diff (LCS)", "logic", "lib/diff.ts", "O(n·m) LCS edit script paired into aligned side-by-side rows.", ["diff", "lcs", "lines"], [{ name: "before", type: "string" }, { name: "after", type: "string" }]],
  ["impact-engine", "Local Impact Engine", "logic", "lib/engines/localImpact.ts", "Scenario matching, prompt→root ranking, BFS severities, risk score, heuristic diffs.", ["impact", "engine", "scenario", "risk", "local"], [{ name: "prompt", type: "string" }, { name: "selectedNodeId", type: "string | null" }]],
  ["story-engine", "Story Engine", "logic", "lib/engines/story.ts", "git log parser, path→node matching, per-frame visibility.", ["story", "git", "log", "commits", "timeline"], [{ name: "text", type: "string" }]],
  ["heuristic-graph", "Heuristic Repo Mapper", "logic", "lib/engines/heuristicGraph.ts", "File filtering, path classification, import resolution and export extraction for repo ingestion.", ["heuristic", "ingest", "imports", "classify"], [{ name: "files", type: "SourceFile[]" }]],
  ["scaffold-engine", "Scaffold Templates", "logic", "lib/engines/localScaffold.ts", "Per-kind code templates and wiring edits for draft components.", ["scaffold", "template", "codegen", "builder"], []],
  ["zip-reader", "ZIP Reader", "logic", "lib/engines/zip.ts", "JSZip extraction with size caps and GitHub top-folder stripping.", ["zip", "archive", "extract"], [{ name: "data", type: "ArrayBuffer | Uint8Array" }]],
  ["graph-schema", "Graph Schema (zod)", "logic", "lib/graphSchema.ts", "Bounded zod schema for graphs; shared by API validation and JSON import.", ["schema", "zod", "validation"], []],
  ["health-engine", "Health Engine", "logic", "lib/engines/health.ts", "Per-component change-risk, circular dependencies (Tarjan SCC), hubs, crossed layers, oversized files and an A-F grade.", ["health", "risk", "cycle", "hub", "scc", "layering", "grade"], [{ name: "graph", type: "ArchitectureGraph" }]],
  ["scripts-engine", "Script Mapper (MATLAB/Python)", "logic", "lib/engines/scripts.ts", "Lexer plus data-flow mapping: which script calls which function and which data files it reads and writes.", ["matlab", "python", "script", "csv", "data", "lexer", "dataflow"], [{ name: "files", type: "SourceFile[]" }]],
  ["explain", "Plain-language Explainer", "logic", "lib/explain.ts", "Turns the graph and impact results into everyday sentences, an effort estimate and an order of work.", ["explain", "plain", "effort", "glossary"], [{ name: "result", type: "ImpactAnalysisResult" }]],
  ["search-lib", "Search Ranking", "logic", "lib/search.ts", "AND-of-words ranking over name, path, export, keyword and description.", ["search", "rank", "find"], [{ name: "query", type: "string" }]],
  ["provenance-engine", "Provenance Engine", "logic", "lib/engines/provenance.ts", "Upstream/downstream data-flow traces: where a result comes from and which results an input affects, plus plain-language descriptions.", ["provenance", "lineage", "trace", "upstream", "downstream", "dataflow", "figure"], [{ name: "request", type: "TraceRequest" }]],
  ["rules-engine", "Rules Engine", "logic", "lib/engines/rules.ts", "Evaluates forbid / no-cycles / max-dependents / max-lines rules with glob selectors; gives violations stable keys.", ["rules", "violation", "forbid", "selector", "glob", "constraint"], [{ name: "rules", type: "ArchRule[]" }]],
  ["rules-schema", "Rules Schema (zod)", "logic", "lib/rulesSchema.ts", "Shared validation for rules, with errors phrased by rule number and field.", ["rules", "schema", "zod", "validation"], [{ name: "text", type: "string" }]],
  ["report", "PR Report", "logic", "lib/report.ts", "Compares two snapshots: new/fixed problems, blast radius of changed files, pass/fail, and the Markdown comment.", ["report", "pr", "compare", "blast", "markdown", "check"], [{ name: "changedFiles", type: "string[]" }]],
  ["cli", "CodeArchitect CLI", "api", "scripts/cli/main.ts", "analyze and pr commands; reads commits straight from git and exits non-zero when the check fails.", ["cli", "command", "git", "analyze", "pr", "exit"], [{ name: "argv", type: "string[]" }]],
  ["tour-lib", "Tour Steps", "logic", "lib/tour.ts", "The tour script plus localStorage-safe seen flag.", ["tour", "steps", "storage"], []],

  // ---- Server-side logic
  ["server-schemas", "API Request Schemas", "logic", "lib/server/schemas.ts", "Request validation and provider-neutral model output schemas.", ["schema", "zod", "structured", "output"], []],
  ["respond", "Route Responder", "logic", "lib/server/respond.ts", "Body parsing, error envelopes, and Claude→local fallback orchestration.", ["respond", "fallback", "envelope", "route"], []],
  ["analyzers", "AI Analyzers", "logic", "lib/server/analyzers.ts", "Provider-neutral prompts for impact/story/scaffold/ingest; fits code to the model's budget and validates output against the graph.", ["analyzer", "prompt", "llm", "ai"], []],
  ["ai-gateway", "AI Provider Gateway", "logic", "lib/server/ai/index.ts", "Resolves the configured provider, caches its generator, and maps provider errors to safe messages.", ["ai", "provider", "gateway", "llm", "model"], []],
  ["ai-config", "Provider Config", "logic", "lib/server/ai/config.ts", "Pure env → provider resolution: presets for Anthropic, OpenAI, Gemini, Ollama, LM Studio, OpenRouter, Groq, DeepSeek, custom.", ["provider", "config", "preset", "ollama", "openai", "gemini", "mistral", "env"], [{ name: "env", type: "Record<string, string | undefined>" }]],
  ["ai-json", "JSON Repair", "logic", "lib/server/ai/json.ts", "Extracts JSON from fenced/prose replies, validates with Zod, and phrases errors for a repair retry.", ["json", "repair", "validation", "zod"], [{ name: "text", type: "string" }]],

  // ---- External services / data
  ["anthropic-adapter", "Anthropic Adapter", "data", "lib/server/ai/anthropic.ts", "Claude via the Anthropic SDK: native structured outputs, refusal fallback. External dependency.", ["anthropic", "claude", "sdk", "adapter"], [{ name: "config", type: "ProviderConfig" }]],
  ["openai-adapter", "OpenAI-compatible Adapter", "data", "lib/server/ai/openaiCompatible.ts", "OpenAI, Gemini, Ollama, LM Studio, OpenRouter, Groq, DeepSeek: degrading response_format, one repair retry. External dependency.", ["openai", "ollama", "gemini", "compatible", "adapter"], [{ name: "config", type: "ProviderConfig" }]],
  ["github-fetch", "GitHub Archive Fetcher", "data", "lib/server/github.ts", "SSRF-safe zipball download from api.github.com. External dependency.", ["github", "fetch", "zipball", "download"], [{ name: "url", type: "string" }]],
  ["sample-repos", "Sample Repositories", "data", "lib/mockData.ts", "Built-in E-Commerce and Auth sample graphs, prompts and scenarios.", ["mock", "sample", "data", "fixtures"], []],
];

/** Calls that happen over HTTP rather than via imports. */
const HTTP_EDGES = [
  ["api-client", "api-impact", "POST impact"],
  ["api-client", "api-story", "POST story"],
  ["api-client", "api-scaffold", "POST scaffold"],
  ["api-client", "api-analyze", "POST analyze-repo"],
  ["api-client", "api-health", "GET health"],
];

const EXPORT_RE = /export\s+(default\s+)?(?:async\s+)?(?:function\*?|const|let|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/g;
const IMPORT_RE = /import\s+(?:type\s+)?([^'";]*?)\s+from\s+["']([^"']+)["']/g;

const byPath = new Map(COMPONENTS.map((c) => [c[3].replace(/\.(tsx?|jsx?)$/, ""), c[0]]));
// Folded modules map onto their owning component.
byPath.set("lib/mock/authMicroservice", "sample-repos");
byPath.set("lib/mock/ecommerceApi", "sample-repos");
byPath.set("lib/mock/powerSystems", "sample-repos");

function resolve(fromPath, spec) {
  let p;
  if (spec.startsWith("@/")) p = spec.slice(2);
  else if (spec.startsWith(".")) {
    const parts = fromPath.split("/").slice(0, -1);
    for (const s of spec.split("/")) s === ".." ? parts.pop() : s !== "." && parts.push(s);
    p = parts.join("/");
  } else return null;
  // A folder import ("@/lib/server/ai") resolves to its index file.
  return byPath.get(p) ?? byPath.get(`${p}/index`) ?? null;
}

const relationFor = (sourceKind, targetKind, targetId) =>
  targetId === "anthropic-adapter" || targetId === "openai-adapter" || targetId === "github-fetch" ? "calls" : targetKind === "data" ? "reads" : sourceKind === "frontend" && targetKind === "frontend" ? "imports" : "calls";

const kindOf = new Map(COMPONENTS.map((c) => [c[0], c[2]]));
const nodes = [];
const edges = [];
const seen = new Set();

for (const [id, label, kind, path, description, keywords, params] of COMPONENTS) {
  const code = read(path);
  const exportsList = [...code.matchAll(EXPORT_RE)].map((m) => (m[1] ? `default ${m[2]}` : m[2]));
  const importSpecs = [];
  for (const m of code.matchAll(IMPORT_RE)) {
    importSpecs.push(m[2]);
    const target = resolve(path, m[2]);
    if (!target || target === id) continue;
    const key = `${id}->${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const names = m[1].replace(/[{}]/g, "").split(",").map((s) => s.replace(/\btype\s+/, "").split(/\s+as\s+/)[0].trim()).filter(Boolean);
    edges.push({ id: `e-${id}--${target}`, source: id, target, relation: relationFor(kind, kindOf.get(target), target), label: names.slice(0, 2).join(", ") + (names.length > 2 ? "…" : "") });
  }
  nodes.push({
    id,
    type: "component",
    position: { x: 0, y: 0 },
    data: { label, kind, filePath: path, description, language: path.split(".").pop(), code, exports: exportsList, imports: [...new Set(importSpecs)], params, keywords },
  });
}
for (const [source, target, label] of HTTP_EDGES) edges.push({ id: `e-${source}--${target}`, source, target, relation: "calls", label });

// ---- Layout: one band per layer, hand-ordered so related nodes sit near each other.
const ROWS = [
  ["top-nav", "import-dialog", "page", "canvas", "custom-node"],
  ["node-inspector", "blast-panel", "inspector-panel", "story-panel", "builder-panel", "diff-viewer", "code-block"],
  ["search-box", "guided-tour", "health-panel", "glossary"],
  ["api-analyze", "api-story", "api-impact", "api-scaffold", "api-health"],
  ["portability", "api-client", "workspace-store", "view-model", "line-diff"],
  ["heuristic-graph", "zip-reader", "story-engine", "impact-engine", "scaffold-engine", "graph-core", "graph-schema"],
  ["health-engine", "scripts-engine", "explain", "search-lib", "tour-lib"],
  ["rules-engine", "rules-schema", "report", "cli", "provenance-engine"],
  ["github-fetch", "respond", "analyzers", "server-schemas", "sample-repos"],
  ["ai-json", "ai-gateway", "ai-config", "anthropic-adapter", "openai-adapter"],
];
const COL_PX = 250;
const ROW_PX = 200;
ROWS.forEach((row, r) =>
  row.forEach((id, c) => {
    const node = nodes.find((n) => n.id === id);
    if (!node) throw new Error(`layout references unknown node ${id}`);
    node.position = { x: c * COL_PX - ((row.length - 1) * COL_PX) / 2 + 800, y: r * ROW_PX };
  }),
);
const unplaced = nodes.filter((n) => !ROWS.flat().includes(n.id));
if (unplaced.length) throw new Error(`unplaced: ${unplaced.map((n) => n.id)}`);

// ---- Scenarios: exact edits against real files.
function edit(nodeId, replacements) {
  const node = nodes.find((n) => n.id === nodeId);
  let after = node.data.code;
  for (const [from, to] of replacements) {
    if (!after.includes(from)) throw new Error(`scenario edit missed in ${nodeId}: ${from}`);
    after = after.split(from).join(to);
  }
  return after;
}

const scenarios = [
  {
    id: "self-dependents-record",
    title: "Return a plain Record from collectDependents",
    triggers: ["collectdependents", "plain (object|record)", "record<string", "depth map"],
    rootNodeId: "graph-core",
    summary:
      "Changing `collectDependents` from `Map<string, number>` to `Record<string, number>` breaks exactly two callers that use Map methods: the local impact engine (`.entries()`, `.has()`) and the Claude analyzers (`.get()`). Other importers of lib/graph.ts (layout, edge highlighting, node lookup) are unaffected but sit in the same module, so they are flagged for review only.",
    extraImpacts: [],
    diffs: [
      {
        nodeId: "graph-core",
        rationale: "New return type; property access replaces Map methods.",
        after: edit("graph-core", [
          ["): Map<string, number> {", "): Record<string, number> {"],
          ["const depth = new Map<string, number>([[rootId, 0]]);", "const depth: Record<string, number> = { [rootId]: 0 };"],
          ["const currentDepth = depth.get(current)!;", "const currentDepth = depth[current]!;"],
          ["if (depth.has(dependent)) continue;", "if (dependent in depth) continue;"],
          ["depth.set(dependent, currentDepth + 1);", "depth[dependent] = currentDepth + 1;"],
        ]),
      },
      {
        nodeId: "impact-engine",
        rationale: "Iterate with Object.entries and test membership with `in`.",
        after: edit("impact-engine", [
          ["[...depths.entries()].map(", "Object.entries(depths).map("],
          ["if (depths.has(extra.nodeId) ||", "if (extra.nodeId in depths ||"],
        ]),
      },
      {
        nodeId: "analyzers",
        rationale: "Index access replaces Map#get.",
        after: edit("analyzers", [["depth: depths.get(i.nodeId) ?? 1", "depth: depths[i.nodeId] ?? 1"]]),
      },
    ],
  },
  {
    id: "self-add-provider",
    title: "Add a Mistral provider preset",
    triggers: ["mistral", "add (a |another )?provider", "new provider", "provider preset"],
    rootNodeId: "ai-config",
    summary:
      "Mistral speaks the OpenAI Chat Completions protocol, so adding it is a config-only change: one ProviderId union member and one preset. No adapter changes; the gateway, analyzers and routes pick it up through the existing interface and nothing breaks at compile time. Add a resolution test and a README row.",
    extraImpacts: [],
    diffs: [
      {
        nodeId: "ai-config",
        rationale: "New ProviderId member plus its preset (base URL, key variable, context budget).",
        after: edit("ai-config", [
          ['  | "deepseek"\n  | "custom";', '  | "deepseek"\n  | "mistral"\n  | "custom";'],
          [
            '  custom: { label: "Custom endpoint",',
            '  mistral: { label: "Mistral", protocol: "openai-compatible", baseURL: "https://api.mistral.ai/v1", keyEnv: "MISTRAL_API_KEY", requiresKey: true, maxInputChars: MEDIUM_CONTEXT_CHARS },\n  custom: { label: "Custom endpoint",',
          ],
          ['const AUTO_DETECT_ORDER: ProviderId[] = ["anthropic", "openai", "gemini", "openrouter", "groq", "deepseek"];', 'const AUTO_DETECT_ORDER: ProviderId[] = ["anthropic", "openai", "gemini", "openrouter", "groq", "deepseek", "mistral"];'],
        ]),
      },
    ],
  },
];

// ---- Story: replayed from this repo's real git history (oldest first).
// Narratives are authored per commit subject; unknown commits get a generated summary.
const NARRATIVES = {
  "chore: scaffold": ["Phase 0 · Toolchain", "Next.js 16, React 19, Tailwind 4, React Flow 12 and Vitest are pinned before any feature code. No architectural components exist yet."],
  "feat(domain):": ["Phase 1 · Domain model", "The project starts data-first: a typed graph model where node status is derived, never stored, plus two hand-written sample repositories so every later layer has realistic input."],
  "feat(engines):": ["Phase 2 · Pure engines", "All analysis logic lands as pure, isomorphic functions before any UI exists: reverse-dependency BFS, LCS diff, impact scoring, git-log parsing, repo heuristics and scaffold templates. This is what lets the app run fully offline and fall back in the browser."],
  "feat(api):": ["Phase 3 · Claude layer", "The server wraps the engines: each route validates input with zod, tries Claude with structured outputs, and degrades to the local engine with a visible warning. Claude output is never trusted for node IDs or 'before' code."],
  "feat(ui):": ["Phase 4 · Workspace UI", "A single reducer and a pure view-model drive the canvas and the four inspector tabs; import/export closes the loop so analysed graphs can be saved and restored."],
  "fix(diff):": ["Phase 5 · Found in the browser", "Browser testing showed long lines bleeding from the Before column into After. The fix moves to one shared grid with wrapping cells — a bug no unit test would have caught."],
  "feat(samples):": ["Phase 6 · Self-mapping", "The tool maps its own repository: authored components, import-derived edges, and scenarios whose diffs are exact edits to real files."],
  "fix(impact):": ["Phase 7 · Dogfooding pays off", "Mapping its own code exposed that the local engine flagged every direct dependent as broken. With an authored scenario, only files that need an edit are now 'broken'; the rest are review-only."],
  "feat(ai):": ["Phase 9 · Any model", "The Claude-only gateway becomes a provider layer: one structured-output interface, a native Anthropic adapter and a tolerant OpenAI-compatible adapter covering OpenAI, Gemini, Ollama, LM Studio and more. Free local models make AI analysis available without a paid API."],
  "test(live):": ["Phase 8a · Real-model harness", "An opt-in suite scores real AI models on every feature against the graph, not just for valid JSON."],
  "fix(test):": ["Phase 8b · A hidden failure", "The live suite matched the default test glob and failed to load, so npm test exited with an error while its summary still said 'passed'. Caught when running the whole suite for exit codes."],
  "feat(health):": ["Phase 9a · Architecture health", "A structural scorecard with no AI: change-risk per component, circular dependencies, hubs, crossed layers and oversized files, shown as rings and chips on the canvas."],
  "feat(search):": ["Phase 9b · Search and focus", "Find a component by name, path or symbol and jump to it; focus mode dims everything but its neighbours so large maps stay readable."],
  "feat(guide):": ["Phase 9c · Approachability", "Plain-language summaries, effort estimates and a spotlight tour make the vocabulary and controls understandable without prior knowledge."],
  "feat(provenance):": ["Provenance", "Select a figure and see the scripts, functions and raw input files behind it; select an input and see every result that would be out of date."],
  "feat(rules):": ["Architecture rules", "Constraints such as 'the UI must not touch the database' become checkable: violations are listed in the Health tab and drawn on the map."],
  "fix(health):": ["Cleaning the signal", "Mapping this repo exposed noise: a types file flagged as a hub and entry points flagged as unconnected. Type-only imports and entry points are now understood, lifting this repo from B to A."],
  "feat(report):": ["PR comparison", "Two architectures are compared to find new and fixed problems and the blast radius of the changed files, rendered as a Markdown report."],
  "fix(report):": ["Counting once", "A single loop was reported as both a cycle and a rule violation; it is now counted once."],
  "feat(cli):": ["Command line", "analyze and pr commands bundled into one file, reading commits straight from git."],
  "ci:": ["Automation", "A GitHub workflow runs the check on every pull request, comments the result and fails on new problems."],
  "feat(scripts):": ["Phase 9d · Research code", "MATLAB and Python scripts become data-flow maps: entry scripts, helper functions, and the data files they read and write."],
  "chore(samples):": ["Refreshing the map", "The map of this repository is rebuilt from the current code and git history so it never goes stale."],
  "docs:": ["Phase 8 · Documentation", "README plus architecture, API, engine, format and development guides — no component code changes."],
};

function nodeIdForFile(file) {
  return byPath.get(file.replace(/\.(tsx?|jsx?)$/, "")) ?? null;
}

function readGitHistory() {
  let log;
  try {
    log = execFileSync("git", ["-C", root, "log", "--reverse", "--no-merges", "--name-status", "--date=short", "--pretty=format:@@%h|%an|%ad|%s"], { encoding: "utf8" });
  } catch {
    return { commits: [], warning: "No git history found; Story mode is empty. Run inside a git checkout." };
  }
  const commits = [];
  const introduced = new Set();
  for (const block of log.split("@@").filter(Boolean)) {
    const [header, ...lines] = block.trim().split(/\r?\n/);
    const [hash, author, date, ...subjectParts] = header.split("|");
    const message = subjectParts.join("|");
    const added = [];
    const modified = [];
    for (const line of lines) {
      const match = /^([AMDR])\d*\t(.+)$/.exec(line.trim());
      if (!match) continue;
      const id = nodeIdForFile(match[2].split("\t").pop());
      if (!id) continue;
      if (!introduced.has(id) && match[1] !== "D") {
        introduced.add(id);
        added.push(id);
      } else if (!added.includes(id) && !modified.includes(id)) {
        modified.push(id);
      }
    }
    const key = Object.keys(NARRATIVES).find((prefix) => message.startsWith(prefix));
    const subject = message.replace(/^\w+(\([^)]*\))?:\s*/, "");
    const [rawTitle, narrative] = key
      ? NARRATIVES[key]
      : [subject, `${message}. Touches ${added.length + modified.length} mapped component(s).`];
    // Phases are numbered by position so the timeline always reads in order, whatever the table says.
    const phase = `Phase ${commits.length + 1} · ${rawTitle.replace(/^Phase \w+ · /, "")}`;
    commits.push({ hash, author, date, message, phase, narrative, addedNodeIds: added, modifiedNodeIds: modified });
  }
  return { commits, warning: commits.length ? null : "This checkout has no commits yet; Story mode is empty." };
}

const { commits, warning: historyWarning } = readGitHistory();

const graph = {
  id: "codearchitect-self",
  name: "CodeArchitect AI (this repo)",
  description: `${nodes.length} components mapped by Claude Code; edges derived from real imports plus HTTP calls.`,
  nodes,
  edges,
  commits,
  scenarios,
  warnings: [
    "lib/types.ts and lib/ui.ts are omitted: nearly every module imports them, which would add ~30 edges of noise. app/layout.tsx and lib/mock/* are folded into neighbouring components.",
    ...(historyWarning ? [historyWarning] : []),
  ],
};

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify({ format: "codearchitect/v1", exportedAt: new Date().toISOString(), graph }, null, 2));
console.log(`nodes=${nodes.length} edges=${edges.length} scenarios=${scenarios.length} commits=${commits.length}`);
