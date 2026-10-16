import type { ArchNode, CodeParam, DependencyEdge, NodeData, NodeKind, SourceFile } from "@/lib/types";

/**
 * Data-flow mapping for analysis scripts (MATLAB `.m`, Python `.py`): which script calls
 * which function, and which data files each one reads or writes. Pure and deterministic.
 *
 * Limits, by design: file names built at run time (`[name '_base.csv']`) cannot be
 * resolved. Literal fragments are kept and marked as patterns; nothing is executed.
 */

export type ScriptLang = "matlab" | "python";

export function scriptLangOf(path: string): ScriptLang | null {
  if (/\.m$/i.test(path)) return "matlab";
  if (/\.py$/i.test(path)) return "python";
  return null;
}

/* ---------- Lexing: strip comments, blank string contents, collect literals ---------- */

export type LexedLine = {
  /** The line with comments removed and string contents blanked (`'abc'` → `''`). */
  text: string;
  /** String literals on this line, unquoted. */
  literals: string[];
};

const MATLAB_TRANSPOSE_PRECEDERS = /[A-Za-z0-9_)\]}.']/;

/** Lex MATLAB or Python source line by line. Handles block comments, doubled quotes and the transpose operator. */
export function lexSource(code: string, lang: ScriptLang): LexedLine[] {
  const rawLines = code.replace(/\r\n/g, "\n").split("\n");
  const out: LexedLine[] = [];
  let inBlockComment = false;
  let tripleQuote: string | null = null; // Python only

  for (const raw of rawLines) {
    if (lang === "matlab") {
      const trimmed = raw.trim();
      if (inBlockComment) {
        if (trimmed === "%}") inBlockComment = false;
        out.push({ text: "", literals: [] });
        continue;
      }
      if (trimmed === "%{") {
        inBlockComment = true;
        out.push({ text: "", literals: [] });
        continue;
      }
    }

    let text = "";
    const literals: string[] = [];
    let i = 0;

    if (tripleQuote) {
      const end = raw.indexOf(tripleQuote);
      if (end === -1) {
        out.push({ text: "", literals: [] });
        continue;
      }
      i = end + 3;
      tripleQuote = null;
    }

    while (i < raw.length) {
      const ch = raw[i]!;
      const commentStart = lang === "matlab" ? ch === "%" || raw.startsWith("...", i) : ch === "#";
      if (commentStart) break;

      const isQuote = ch === '"' || ch === "'";
      if (lang === "python" && isQuote && raw.startsWith(ch.repeat(3), i)) {
        const end = raw.indexOf(ch.repeat(3), i + 3);
        if (end === -1) {
          tripleQuote = ch.repeat(3);
          break;
        }
        text += `${ch}${ch}`;
        i = end + 3;
        continue;
      }

      const isTranspose = lang === "matlab" && ch === "'" && i > 0 && MATLAB_TRANSPOSE_PRECEDERS.test(raw[i - 1]!);
      if (isQuote && !isTranspose) {
        let j = i + 1;
        let value = "";
        for (; j < raw.length; j++) {
          const c = raw[j]!;
          if (lang === "python" && c === "\\") {
            value += raw[j + 1] ?? "";
            j++;
          } else if (c === ch) {
            if (lang === "matlab" && raw[j + 1] === ch) {
              value += ch; // doubled quote is an escaped quote in MATLAB
              j++;
            } else break;
          } else value += c;
        }
        literals.push(value);
        text += `${ch}${ch}`;
        i = j + 1;
        continue;
      }
      text += ch;
      i++;
    }
    out.push({ text, literals });
  }
  return out;
}

/* ---------- Data-file references ---------- */

const DATA_EXTENSIONS = new Set(["csv", "tsv", "mat", "xlsx", "xls", "xlsm", "txt", "dat", "json", "h5", "hdf5", "parquet", "pkl", "pickle", "npy", "npz", "xml", "psout", "nc", "feather"]);
const OUTPUT_EXTENSIONS = new Set(["png", "jpg", "jpeg", "pdf", "svg", "eps", "fig", "gif", "tif", "tiff", "emf"]);

const MATLAB_WRITE = /\b(writetable|writematrix|writecell|writetimetable|csvwrite|dlmwrite|xlswrite|save|saveas|savefig|exportgraphics|exportapp|print|imwrite|audiowrite|h5create|h5write|diary)\b/;
const PYTHON_WRITE = /\b(to_csv|to_excel|to_parquet|to_json|to_pickle|to_hdf|to_feather|savetxt|save|savez|savez_compressed|savefig|dump|dumps|write_text|write_bytes|imwrite|imsave)\b/;
const READ_CALL = /\b(read\w*|load\w*|imread|fileread|importdata|textscan|xlsread|csvread|dlmread|matfile|open)\b/;
const WRITE_MODE_LITERAL = /^(w|a|wt|at|wb|ab|w\+|a\+|wt\+|at\+)$/;

export type DataRef = { path: string; mode: "reads" | "writes"; isPattern: boolean };

function extensionOf(path: string): string {
  return /\.([A-Za-z0-9]{2,8})$/.exec(path)?.[1]?.toLowerCase() ?? "";
}

/** File names assembled at run time show up as fragments such as `_base.csv`, `%s.csv` or `*.csv`. */
function isPatternPath(path: string): boolean {
  const base = path.split(/[\\/]/).pop() ?? path;
  return /[%*?{}]/.test(base) || /^[_.\-+]/.test(base) || base.startsWith("$");
}

export function normalizeDataPath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

/** Every string literal that names a data or output file, classified as a read or a write from its line. */
export function scanDataRefs(lines: readonly LexedLine[], lang: ScriptLang): DataRef[] {
  const writeCall = lang === "matlab" ? MATLAB_WRITE : PYTHON_WRITE;
  const refs = new Map<string, DataRef>();

  for (const { text, literals } of lines) {
    if (literals.length === 0) continue;
    const opensForWriting = /\b(fopen|open)\b/.test(text) && literals.some((l) => WRITE_MODE_LITERAL.test(l));
    for (const literal of literals) {
      const ext = extensionOf(literal);
      const isData = DATA_EXTENSIONS.has(ext);
      const isOutput = OUTPUT_EXTENSIONS.has(ext);
      if (!isData && !isOutput) continue;
      if (/^(https?:|[a-z]+:\/\/)/i.test(literal)) continue; // URLs are not local files

      let mode: DataRef["mode"] = "reads";
      if (opensForWriting || writeCall.test(text)) mode = "writes";
      else if (isOutput && !READ_CALL.test(text)) mode = "writes";

      const path = normalizeDataPath(literal);
      const previous = refs.get(path);
      // A file both read and written is reported as written: the stronger claim for impact analysis.
      if (!previous || (previous.mode === "reads" && mode === "writes")) refs.set(path, { path, mode, isPattern: isPatternPath(path) });
    }
  }
  return [...refs.values()];
}

/* ---------- MATLAB structure ---------- */

const FUNCTION_DEF = /^\s*function\b\s*(?:\[[^\]]*\]\s*=\s*|[A-Za-z_]\w*\s*=\s*)?([A-Za-z_][\w.]*)\s*(?:\(([^)]*)\))?/;

export type MatlabStructure = {
  /** Names of every function defined in the file; the first is the main one for a function file. */
  functions: string[];
  /** True when the file starts with a function (callable by its file name) rather than top-level statements. */
  isFunctionFile: boolean;
  params: CodeParam[];
};

export function matlabStructure(lines: readonly LexedLine[]): MatlabStructure {
  const functions: string[] = [];
  let params: CodeParam[] = [];
  let firstStatementIsFunction: boolean | null = null;

  for (const { text } of lines) {
    const match = FUNCTION_DEF.exec(text);
    if (firstStatementIsFunction === null && text.trim() !== "") firstStatementIsFunction = Boolean(match) || /^\s*classdef\b/.test(text);
    if (!match) continue;
    if (functions.length === 0) {
      params = (match[2] ?? "")
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p && p !== "varargin" && p !== "~")
        .map((name) => ({ name, type: "any" }));
    }
    functions.push(match[1]!);
  }
  return { functions, isFunctionFile: Boolean(firstStatementIsFunction), params };
}

/** Function names defined in a MATLAB file, for the export list. */
export function matlabFunctions(code: string): string[] {
  return matlabStructure(lexSource(code, "matlab")).functions;
}

const MATLAB_PLOT_CALLS = ["plot", "plot3", "figure", "subplot", "tiledlayout", "nexttile", "bar", "histogram", "scatter", "surf", "contour", "heatmap", "legend", "xlabel", "ylabel", "exportgraphics", "saveas", "axes"];
const PYTHON_PLOT_HINT = /\b(plt|matplotlib|seaborn|plotly|bokeh)\b|\.plot\(|\bsavefig\b/;
const PLOT_CALL_THRESHOLD = 2;

function isPlotting(lines: readonly LexedLine[], lang: ScriptLang): boolean {
  if (lang === "python") return lines.some((l) => PYTHON_PLOT_HINT.test(l.text));
  const seen = new Set<string>();
  const pattern = new RegExp(`(?<![\\w.])(${MATLAB_PLOT_CALLS.join("|")})\\s*\\(`, "g");
  for (const { text } of lines) for (const m of text.matchAll(pattern)) seen.add(m[1]!);
  return seen.size >= PLOT_CALL_THRESHOLD;
}

/** First comment block of a script, which people write as its description. */
export function headerComment(code: string, lang: ScriptLang): string | undefined {
  const marker = lang === "matlab" ? "%" : "#";
  const collected: string[] = [];
  for (const raw of code.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trim();
    if (line === "") {
      if (collected.length) break;
      continue;
    }
    if (line.startsWith(marker)) {
      const text = line.replace(new RegExp(`^\\${marker}+\\s*`), "").trim();
      if (text && !/^(-{3,}|={3,}|\*{3,})$/.test(text)) collected.push(text);
      if (collected.join(" ").length > 200) break;
      continue;
    }
    if (lang === "matlab" && /^function\b/.test(line) && collected.length === 0) continue; // doc comment follows the signature
    if (lang === "python" && /^(#!|import|from)\b/.test(line) && collected.length === 0) continue;
    break;
  }
  const joined = collected.join(" ").replace(/\s+/g, " ").trim();
  return joined ? (joined.length > 220 ? `${joined.slice(0, 217)}…` : joined) : undefined;
}

/* ---------- The graph layer ---------- */

export const MAX_DATA_NODES = 40;
const SCRIPT_DOMINANT_SHARE = 0.5;

export const SCRIPT_KIND_LABELS: Partial<Record<NodeKind, string>> = {
  frontend: "Plots & outputs",
  api: "Entry scripts",
  logic: "Analysis code",
  data: "Data files",
};

export type ScriptLayer = {
  /** Changes to apply to existing file nodes, keyed by file path. */
  patches: Map<string, Partial<NodeData>>;
  dataNodes: ArchNode[];
  edges: DependencyEdge[];
  kindLabels?: Partial<Record<NodeKind, string>>;
  warnings: string[];
};

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function dataNodeId(path: string): string {
  return `data-${slug(normalizeDataPath(path))}`;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function keywordsFor(path: string, extra: string[] = []): string[] {
  return [...new Set([...slug(basename(path).replace(/\.[^.]+$/, "")).split("-"), ...extra].filter((k) => k.length >= 2))];
}

export function analyzeScriptFiles(files: readonly SourceFile[], idForPath: ReadonlyMap<string, string>): ScriptLayer {
  const scripts = files.filter((f) => scriptLangOf(f.path));
  const layer: ScriptLayer = { patches: new Map(), dataNodes: [], edges: [], warnings: [] };
  if (scripts.length === 0) return layer;

  const lexed = new Map(scripts.map((f) => [f.path, lexSource(f.content, scriptLangOf(f.path)!)]));

  /* MATLAB: who calls whom (by file name; local functions shadow other files) */
  const matlabFiles = scripts.filter((f) => scriptLangOf(f.path) === "matlab");
  const structure = new Map(matlabFiles.map((f) => [f.path, matlabStructure(lexed.get(f.path)!)]));
  const pathByName = new Map(matlabFiles.map((f) => [basename(f.path).replace(/\.m$/i, ""), f.path]));
  const callsByPath = new Map<string, Set<string>>();
  if (pathByName.size > 0) {
    const names = [...pathByName.keys()].filter((n) => /^[A-Za-z_]\w*$/.test(n));
    const callPattern = names.length ? new RegExp(`(?<![\\w.])(${names.join("|")})(?![\\w])`, "g") : null;
    for (const f of matlabFiles) {
      const own = new Set(structure.get(f.path)!.functions);
      const called = new Set<string>();
      for (const { text } of lexed.get(f.path)!) {
        if (!callPattern || FUNCTION_DEF.test(text)) continue;
        for (const m of text.matchAll(callPattern)) {
          const target = pathByName.get(m[1]!);
          if (target && target !== f.path && !own.has(m[1]!)) called.add(m[1]!);
        }
      }
      callsByPath.set(f.path, called);
    }
  }

  const seenEdges = new Set<string>();
  const addEdge = (edge: DependencyEdge) => {
    const key = `${edge.source}->${edge.target}`;
    if (seenEdges.has(key)) return;
    seenEdges.add(key);
    layer.edges.push(edge);
  };

  const callerCount = new Map<string, number>();
  for (const [path, names] of callsByPath) {
    for (const name of names) {
      const targetPath = pathByName.get(name)!;
      callerCount.set(targetPath, (callerCount.get(targetPath) ?? 0) + 1);
      const source = idForPath.get(path)!;
      const target = idForPath.get(targetPath)!;
      addEdge({ id: `e-${source}--${target}`, source, target, relation: "calls", label: `${name}()` });
    }
  }

  /* Data files, for both languages */
  const refsByScript = new Map(scripts.map((f) => [f.path, scanDataRefs(lexed.get(f.path)!, scriptLangOf(f.path)!)]));
  const usage = new Map<string, { ref: DataRef; scripts: Set<string> }>();
  for (const [scriptPath, refs] of refsByScript) {
    for (const ref of refs) {
      const entry = usage.get(ref.path) ?? { ref, scripts: new Set<string>() };
      if (ref.mode === "writes") entry.ref = { ...entry.ref, mode: "writes" };
      entry.scripts.add(scriptPath);
      usage.set(ref.path, entry);
    }
  }

  const ranked = [...usage.values()].sort((a, b) => b.scripts.size - a.scripts.size || a.ref.path.localeCompare(b.ref.path));
  const shown = ranked.slice(0, MAX_DATA_NODES);
  const overflow = ranked.slice(MAX_DATA_NODES);

  const makeDataNode = (id: string, path: string, label: string, description: string, code: string, ext: string, keywords: string[]): ArchNode => ({
    id,
    type: "component",
    position: { x: 0, y: 0 },
    data: { label, kind: "data", filePath: path, description, language: ext || "data", code, exports: [], imports: [], params: [], keywords },
  });
  const labelFor = (names: Iterable<string>) => [...names].map((p) => basename(p)).join(", ");

  for (const { ref, scripts: users } of shown) {
    const id = dataNodeId(ref.path);
    const verb = ref.mode === "writes" ? "written" : "read";
    layer.dataNodes.push(
      makeDataNode(
        id,
        ref.path,
        basename(ref.path),
        `${ref.isPattern ? "File name pattern (built at run time)" : ref.mode === "writes" ? "Output file" : "Input data file"}, ${verb} by ${labelFor(users)}.`,
        `// ${ref.path}\n// ${verb} by: ${[...users].join(", ")}\n// File contents are not loaded; this node comes from references in the code.`,
        extensionOf(ref.path),
        keywordsFor(ref.path, ["data", "file", extensionOf(ref.path)]),
      ),
    );
    for (const scriptPath of users) {
      const source = idForPath.get(scriptPath)!;
      const mode = refsByScript.get(scriptPath)!.find((r) => r.path === ref.path)?.mode ?? "reads";
      addEdge({ id: `e-${source}--${id}`, source, target: id, relation: mode, label: mode === "writes" ? "writes" : undefined });
    }
  }
  if (overflow.length > 0) {
    const id = "data-more-files";
    const usersOfOverflow = new Set(overflow.flatMap((o) => [...o.scripts]));
    layer.dataNodes.push(
      makeDataNode(
        id,
        `(${overflow.length} more data files)`,
        `+${overflow.length} more data files`,
        `Further data files referenced by ${labelFor(usersOfOverflow)}: ${overflow.slice(0, 8).map((o) => basename(o.ref.path)).join(", ")}…`,
        overflow.map((o) => `// ${o.ref.path}`).join("\n"),
        "data",
        ["data", "files", "more"],
      ),
    );
    for (const scriptPath of usersOfOverflow) {
      const source = idForPath.get(scriptPath)!;
      addEdge({ id: `e-${source}--${id}`, source, target: id, relation: "reads" });
    }
    layer.warnings.push(`Showing the ${MAX_DATA_NODES} most-used data files; ${overflow.length} more are grouped into one node.`);
  }
  if (usage.size > 0) layer.warnings.push("Data files are shown from references in the code; their contents are never read. File names built at run time appear as patterns.");
  if ([...usage.values()].some((u) => u.ref.isPattern)) layer.warnings.push("Some names are fragments (e.g. '_base.csv'), so the real file set may be larger.");

  /* Per-file node patches: description, exports, imports, layer */
  for (const f of scripts) {
    const lang = scriptLangOf(f.path)!;
    const lines = lexed.get(f.path)!;
    const patch: Partial<NodeData> = {};
    const header = headerComment(f.content, lang);
    const calls = [...(callsByPath.get(f.path) ?? [])];
    const reads = (refsByScript.get(f.path) ?? []).filter((r) => r.mode === "reads").map((r) => basename(r.path));
    const writes = (refsByScript.get(f.path) ?? []).filter((r) => r.mode === "writes").map((r) => basename(r.path));

    let isScript = false;
    if (lang === "matlab") {
      const s = structure.get(f.path)!;
      isScript = !s.isFunctionFile;
      patch.language = "matlab";
      patch.exports = s.functions;
      patch.imports = [...calls.map((c) => `${c}()`), ...reads];
      if (s.params.length) patch.params = s.params;
    } else {
      isScript = /^\s*if\s+__name__\s*==\s*['"]__main__['"]/m.test(f.content);
      patch.imports = undefined; // keep the import list from the generic scan
    }
    if (header) patch.description = header;
    else if (reads.length || writes.length || calls.length) {
      const bits = [calls.length && `calls ${calls.slice(0, 3).join(", ")}`, reads.length && `reads ${reads.length} data file(s)`, writes.length && `writes ${writes.slice(0, 2).join(", ")}`].filter(Boolean);
      patch.description = `${isScript ? "Script" : "Function"} that ${bits.join(", ")}.`;
    }

    const hasCallers = (callerCount.get(f.path) ?? 0) > 0;
    const isEntry = isScript && !hasCallers && (calls.length > 0 || reads.length + writes.length > 0);
    if (isEntry) patch.kind = "api";
    else if (isPlotting(lines, lang)) patch.kind = "frontend";
    for (const key of Object.keys(patch) as Array<keyof NodeData>) if (patch[key] === undefined) delete patch[key];
    layer.patches.set(f.path, patch);
  }

  if (scripts.length / Math.max(1, files.length) >= SCRIPT_DOMINANT_SHARE) layer.kindLabels = SCRIPT_KIND_LABELS;
  return layer;
}
