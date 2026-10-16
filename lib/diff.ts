export type DiffLine = { lineNo: number; text: string };

export type DiffRowType = "same" | "removed" | "added" | "changed";

export type DiffRow = {
  type: DiffRowType;
  left?: DiffLine;
  right?: DiffLine;
};

export type DiffStats = { added: number; removed: number };

type Op = { kind: "same" | "del" | "add"; text: string };

/** Above this many DP cells (~16 MB of Uint32) fall back to a whole-file replace. */
const MAX_LCS_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n");
}

/** Classic LCS edit script. O(n·m) time and memory — fine for file-sized snippets. */
function editScript(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n * m > MAX_LCS_CELLS) {
    return [...a.map((text) => ({ kind: "del" as const, text })), ...b.map((text) => ({ kind: "add" as const, text }))];
  }

  const width = m + 1;
  const lcs = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: "same", text: a[i]! });
      i++;
      j++;
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      ops.push({ kind: "del", text: a[i++]! });
    } else {
      ops.push({ kind: "add", text: b[j++]! });
    }
  }
  while (i < n) ops.push({ kind: "del", text: a[i++]! });
  while (j < m) ops.push({ kind: "add", text: b[j++]! });
  return ops;
}

/**
 * Side-by-side rows: runs of deletions and additions are paired line-by-line
 * into `changed` rows so the two columns stay aligned.
 */
export function diffLines(before: string, after: string): { rows: DiffRow[]; stats: DiffStats } {
  const ops = editScript(splitLines(before), splitLines(after));
  const rows: DiffRow[] = [];
  const stats: DiffStats = { added: 0, removed: 0 };
  let leftNo = 1;
  let rightNo = 1;

  for (let k = 0; k < ops.length; ) {
    const op = ops[k]!;
    if (op.kind === "same") {
      rows.push({ type: "same", left: { lineNo: leftNo++, text: op.text }, right: { lineNo: rightNo++, text: op.text } });
      k++;
      continue;
    }

    const removed: string[] = [];
    const added: string[] = [];
    while (k < ops.length && ops[k]!.kind !== "same") {
      const current = ops[k]!;
      (current.kind === "del" ? removed : added).push(current.text);
      k++;
    }
    stats.removed += removed.length;
    stats.added += added.length;

    const span = Math.max(removed.length, added.length);
    for (let r = 0; r < span; r++) {
      const left = r < removed.length ? { lineNo: leftNo++, text: removed[r]! } : undefined;
      const right = r < added.length ? { lineNo: rightNo++, text: added[r]! } : undefined;
      rows.push({ type: left && right ? "changed" : left ? "removed" : "added", left, right });
    }
  }
  return { rows, stats };
}
