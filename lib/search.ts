import type { ArchNode } from "@/lib/types";

export type SearchField = "name" | "path" | "export" | "keyword" | "description";

export type SearchHit = {
  nodeId: string;
  score: number;
  /** The field the best match came from, for showing "why it matched". */
  matchedOn: SearchField;
};

const SCORE = { exactName: 100, namePrefix: 40, nameWord: 80, nameContains: 60, path: 40, export: 35, keyword: 30, description: 10 } as const;
const DEFAULT_LIMIT = 8;

/** "UserDashboard" → "user dashboard", so people can search by word. */
function words(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_\-./\\]+/g, " ").toLowerCase();
}

type TokenMatch = { score: number; field: SearchField };

function matchToken(node: ArchNode, token: string): TokenMatch | null {
  const { label, filePath, exports, keywords, description } = node.data;
  const name = words(label);
  const best: TokenMatch[] = [];

  if (name.split(" ").some((w) => w.startsWith(token))) best.push({ score: SCORE.nameWord, field: "name" });
  else if (name.includes(token) || label.toLowerCase().includes(token)) best.push({ score: SCORE.nameContains, field: "name" });
  if (filePath.toLowerCase().includes(token) || words(filePath).includes(token)) best.push({ score: SCORE.path, field: "path" });
  if (exports.some((e) => e.toLowerCase().includes(token))) best.push({ score: SCORE.export, field: "export" });
  if (keywords.some((k) => k.toLowerCase().startsWith(token))) best.push({ score: SCORE.keyword, field: "keyword" });
  if (description.toLowerCase().includes(token)) best.push({ score: SCORE.description, field: "description" });

  return best.length ? best.reduce((a, b) => (b.score > a.score ? b : a)) : null;
}

/**
 * Find components by name, file path, exported symbol, keyword or description.
 * Every whitespace-separated word of the query must match something (AND), so
 * "auth jwt" finds the JWT service in the auth folder. Results are best-first.
 */
export function searchNodes(nodes: readonly ArchNode[], query: string, limit = DEFAULT_LIMIT): SearchHit[] {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return [];
  const whole = tokens.join(" ");

  const hits: SearchHit[] = [];
  for (const node of nodes) {
    let score = 0;
    let matchedOn: SearchField | null = null;
    let allMatched = true;
    for (const token of tokens) {
      const m = matchToken(node, token);
      if (!m) {
        allMatched = false;
        break;
      }
      score += m.score;
      matchedOn ??= m.field;
    }
    if (!allMatched || !matchedOn) continue;

    const name = node.data.label.toLowerCase();
    if (name === whole) score += SCORE.exactName;
    else if (name.startsWith(whole)) score += SCORE.namePrefix;
    hits.push({ nodeId: node.id, score, matchedOn });
  }

  const byId = new Map(nodes.map((n) => [n.id, n.data.label]));
  return hits.sort((a, b) => b.score - a.score || (byId.get(a.nodeId) ?? "").localeCompare(byId.get(b.nodeId) ?? "")).slice(0, limit);
}
