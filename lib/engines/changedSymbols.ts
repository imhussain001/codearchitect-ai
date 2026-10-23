import { declarationSpans, spanAt } from "@/lib/engines/declarations";
import { extractExports, isAnalyzableSource } from "@/lib/engines/heuristicGraph";
import { diffLines } from "@/lib/diff";
import type { SourceFile } from "@/lib/types";

/**
 * Which exported names a change touches. A pull request names changed *files*; this narrows
 * that to the exports whose code changed, so the check can say "3 files use `verifyToken` and
 * 4 only import the file". It compares the file before and after line by line and attributes each
 * changed line to the export whose declaration it falls under.
 *
 * It is deliberately cautious: if any changed line cannot be tied to one export (module-level
 * code before the first export, say), the result is marked `precise: false` and callers must not
 * narrow the importers. Import-only edits are neutral: they cannot change an export's signature.
 */

export type SymbolChange = {
  path: string;
  /** Exports whose code changed (present before and after). */
  modified: string[];
  added: string[];
  removed: string[];
  /** False when part of the change is outside every export, so importers cannot be narrowed. */
  precise: boolean;
};

const IMPORT_LINE = /^\s*(?:import\b|from\s+\S+\s+import\b|export\s[^;]*\sfrom\b|use\s|package\s|using\s|#include\b|(?:const|let|var)\s+\S+\s*=\s*require\()/;

const nameOf = (raw: string) => raw.replace(/^default\s+/, "");
const isNeutral = (text: string) => text.trim() === "" || IMPORT_LINE.test(text);

/** Symbol changes for every changed file that has a supported language. Files without exports yield nothing. */
export function analyzeChangedSymbols(baseFiles: readonly SourceFile[], headFiles: readonly SourceFile[], changedPaths: readonly string[]): SymbolChange[] {
  const base = new Map(baseFiles.map((f) => [f.path, f]));
  const head = new Map(headFiles.map((f) => [f.path, f]));
  const out: SymbolChange[] = [];

  for (const path of changedPaths) {
    if (!isAnalyzableSource(path)) continue;
    const before = base.get(path);
    const after = head.get(path);
    if (!before && !after) continue;

    const baseNames = before ? [...new Set(extractExports(before).map(nameOf))] : [];
    const headNames = after ? [...new Set(extractExports(after).map(nameOf))] : [];
    const added = headNames.filter((n) => !baseNames.includes(n));
    const removed = baseNames.filter((n) => !headNames.includes(n));

    // A file that is new or gone has no line-by-line story: every export was added or removed.
    if (!before || !after) {
      if (added.length || removed.length) out.push({ path, modified: [], added, removed, precise: true });
      continue;
    }

    const baseSpans = declarationSpans(before.content, baseNames);
    const headSpans = declarationSpans(after.content, headNames);
    const touched = new Set<string>();
    let precise = true;
    const attribute = (spans: ReturnType<typeof declarationSpans>, line: number, text: string) => {
      if (isNeutral(text)) return;
      const owner = spanAt(spans, line);
      if (owner) touched.add(owner);
      else precise = false;
    };

    for (const row of diffLines(before.content, after.content).rows) {
      if (row.type === "same") continue;
      if (row.left) attribute(baseSpans, row.left.lineNo - 1, row.left.text);
      if (row.right) attribute(headSpans, row.right.lineNo - 1, row.right.text);
    }

    const modified = [...touched].filter((n) => baseNames.includes(n) && headNames.includes(n));
    if (modified.length || added.length || removed.length || !precise) out.push({ path, modified, added, removed, precise });
  }
  return out;
}
