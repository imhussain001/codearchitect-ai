/**
 * Where a name is declared in a source file. Shared by the VS Code extension (CodeLens position)
 * and the changed-symbols analysis of the pull-request check. Lexical and language-agnostic:
 * it recognises the declaration keywords of TypeScript/JavaScript, Python, Go, Java and Rust.
 */

/** First line that looks like the declaration of `name` (function, class, const, struct, fn, …), else any line using it. */
export function findDeclarationLine(content: string, name: string): number | null {
  const escaped = name.replace(/\$/g, String.raw`\$`);
  const decl = new RegExp(
    String.raw`(?:function|class|interface|type|enum|const|let|var|struct|trait|fn|func|record|def|object|mod|static|union)\s+${escaped}(?![\w$])|(?<![\w$.])${escaped}\s*[:=]\s*(?:async\s*)?(?:\(|function)`,
  );
  const lines = content.split("\n");
  const index = lines.findIndex((line) => decl.test(line));
  if (index >= 0) return index;
  const loose = new RegExp(String.raw`(?<![\w$])${escaped}(?![\w$])`);
  const fallback = lines.findIndex((line) => loose.test(line));
  return fallback >= 0 ? fallback : null;
}

/** Lines that belong to the declaration below them: doc comments, plain comments, decorators and attributes. */
const LEADING_TRIVIA = /^\s*(?:\/\*\*?|\*\/?|\/\/|#|@|\[)/;

/** The first line of a declaration's own block, including the comments and decorators directly above it. */
function blockStart(lines: readonly string[], declLine: number): number {
  let start = declLine;
  while (start > 0 && LEADING_TRIVIA.test(lines[start - 1]!)) start--;
  return start;
}

export type DeclarationSpan = { name: string; /** 0-based, inclusive. */ start: number; /** 0-based, exclusive. */ end: number };

/**
 * One span per name: from its declaration (with the comments and decorators above it) to the line
 * before the next declaration in the list; the last runs to the end of the file. Anything before
 * the first declaration belongs to no span. Names that cannot be found are left out.
 */
export function declarationSpans(content: string, names: readonly string[]): DeclarationSpan[] {
  const lines = content.split("\n");
  const found = names
    .map((name) => ({ name, decl: findDeclarationLine(content, name) }))
    .filter((d): d is { name: string; decl: number } => d.decl !== null)
    .map((d) => ({ name: d.name, decl: d.decl, start: blockStart(lines, d.decl) }))
    .sort((a, b) => a.decl - b.decl);
  // Two names on one line (`export { a, b }`) share a span rather than the first swallowing the second.
  return found.map((d, i) => ({ name: d.name, start: d.start, end: found.slice(i + 1).find((n) => n.decl > d.decl)?.start ?? lines.length }));
}

/** The name whose span contains `line`, if any. */
export function spanAt(spans: readonly DeclarationSpan[], line: number): string | undefined {
  return spans.find((s) => line >= s.start && line < s.end)?.name;
}
