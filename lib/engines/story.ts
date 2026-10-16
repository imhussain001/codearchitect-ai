import type { ArchNode, CommitSnapshot } from "@/lib/types";

/**
 * Nodes visible at commit `index`: those introduced at or before it, plus nodes
 * no commit introduces (they pre-date the imported history).
 */
export function visibleNodeIdsAt(nodes: readonly ArchNode[], commits: readonly CommitSnapshot[], index: number): Set<string> {
  const introducedAt = new Map<string, number>();
  commits.forEach((commit, i) => {
    for (const id of commit.addedNodeIds) if (!introducedAt.has(id)) introducedAt.set(id, i);
  });
  return new Set(nodes.filter((n) => (introducedAt.get(n.id) ?? -1) <= index).map((n) => n.id));
}

type ParsedCommit = {
  hash: string;
  author: string;
  date: string;
  message: string;
  files: Array<{ status: string; path: string }>;
};

const COMMIT_HEADER = /^commit\s+([0-9a-f]{7,40})/i;
const ONELINE_HEADER = /^([0-9a-f]{7,40})\s+(.+)$/i;
const NAME_STATUS = /^([AMDR])\d*\t(.+)$/;
const SHORT_HASH_LENGTH = 7;

/**
 * Parse `git log --name-status` (default or `--oneline`) output, newest first,
 * into chronological commits.
 */
export function parseGitLog(text: string): ParsedCommit[] {
  const commits: ParsedCommit[] = [];
  let current: ParsedCommit | null = null;

  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.trimEnd();
    const header = COMMIT_HEADER.exec(line);
    const oneline = !header && !NAME_STATUS.test(line) ? ONELINE_HEADER.exec(line) : null;

    if (header || oneline) {
      current = { hash: (header?.[1] ?? oneline![1]!).slice(0, SHORT_HASH_LENGTH), author: "", date: "", message: oneline?.[2] ?? "", files: [] };
      commits.push(current);
      continue;
    }
    if (!current) continue;

    const status = NAME_STATUS.exec(line);
    if (status) {
      // Renames are "R100\told\tnew": keep the destination path.
      const path = status[2]!.split("\t").pop()!;
      current.files.push({ status: status[1]!, path });
    } else if (line.startsWith("Author:")) {
      current.author = line.slice(7).replace(/<.*>/, "").trim();
    } else if (line.startsWith("Date:")) {
      current.date = line.slice(5).trim();
    } else if (/^\s{4}\S/.test(raw) && !current.message) {
      current.message = line.trim();
    }
  }
  return commits.reverse();
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
}

/** Match a changed file to a node by path suffix in either direction. */
export function nodeIdForPath(path: string, nodes: readonly ArchNode[]): string | undefined {
  const target = normalizePath(path);
  return nodes.find((n) => {
    const nodePath = normalizePath(n.data.filePath);
    return nodePath === target || nodePath.endsWith(`/${target}`) || target.endsWith(`/${nodePath}`);
  })?.id;
}

export function commitsFromGitLog(text: string, nodes: readonly ArchNode[]): CommitSnapshot[] {
  const parsed = parseGitLog(text);
  if (parsed.length === 0) {
    throw new Error("No commits found. Paste the output of `git log --name-status` (default or --oneline format).");
  }

  const seen = new Set<string>();
  return parsed.map((commit, i) => {
    const added: string[] = [];
    const modified: string[] = [];
    for (const file of commit.files) {
      const id = nodeIdForPath(file.path, nodes);
      if (!id) continue;
      if (file.status === "A" && !seen.has(id)) {
        added.push(id);
        seen.add(id);
      } else if (!modified.includes(id) && !added.includes(id)) {
        modified.push(id);
      }
    }
    const touched = [...added, ...modified].map((id) => nodes.find((n) => n.id === id)?.data.label).filter(Boolean);
    return {
      hash: commit.hash,
      message: commit.message || "(no message)",
      author: commit.author || "unknown",
      date: commit.date,
      phase: `Step ${i + 1}`,
      narrative: touched.length
        ? `${commit.message}. Touches ${touched.join(", ")} (${commit.files.length} file(s) changed).`
        : `${commit.message}. No mapped components changed (${commit.files.length} file(s)).`,
      addedNodeIds: added,
      modifiedNodeIds: modified,
    };
  });
}
