import { findCycles } from "@/lib/engines/health";
import { nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ArchNode, ArchRule, RuleViolation } from "@/lib/types";

/** Compile a glob (`**` any depth, `*` within a segment, `?` one character) to an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        source += ".*";
        i++;
        if (glob[i + 1] === "/") i++; // `**/` also matches zero directories
      } else source += "[^/]*";
    } else if (ch === "?") source += "[^/]";
    else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`, "i");
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "");
}

/** Does `node` match one selector? See `ArchRule` for the grammar. */
function matchesOne(node: ArchNode, alternative: string): boolean {
  const text = alternative.trim();
  if (text === "*" || text === "any") return true;
  const colon = text.indexOf(":");
  const key = colon > 0 ? text.slice(0, colon).toLowerCase() : "";
  const value = colon > 0 ? text.slice(colon + 1).trim() : text;
  const path = normalizePath(node.data.filePath);

  switch (key) {
    case "kind":
      return node.data.kind === value.toLowerCase();
    case "id":
      return node.id === value;
    case "path":
      return globToRegExp(normalizePath(value)).test(path);
    case "label":
      return globToRegExp(value).test(node.data.label);
    default:
      // A bare word is a friendly shorthand: a label or a path.
      return globToRegExp(value).test(node.data.label) || globToRegExp(normalizePath(value)).test(path);
  }
}

export function matchesSelector(node: ArchNode, selector: string): boolean {
  return selector.split("|").some((alt) => matchesOne(node, alt));
}

function lineCountOf(node: ArchNode): number {
  return node.data.lineCount ?? (node.data.code ? node.data.code.split("\n").length : 0);
}

/**
 * Check a graph against rules. Pure; builder drafts are ignored. `graph.rules` is used
 * unless `rules` is passed (the CLI loads them from `.codearchitect.json`).
 */
export function evaluateRules(graph: ArchitectureGraph, rules: readonly ArchRule[] = graph.rules ?? []): RuleViolation[] {
  const nodes = graph.nodes.filter((n) => !n.data.isDraft);
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => !e.isDraft && ids.has(e.source) && ids.has(e.target));
  const label = (id: string) => nodeById(nodes, id)?.data.label ?? id;
  const violations: RuleViolation[] = [];

  for (const rule of rules) {
    const severity = rule.severity ?? "error";

    if (rule.type === "forbid") {
      for (const edge of edges) {
        const from = nodeById(nodes, edge.source)!;
        const to = nodeById(nodes, edge.target)!;
        if (!matchesSelector(from, rule.from) || !matchesSelector(to, rule.to)) continue;
        violations.push({
          ruleId: rule.id, ruleType: rule.type,
          severity,
          message: `${rule.message ?? "Forbidden dependency"}: ${label(edge.source)} → ${label(edge.target)}`,
          nodeIds: [edge.source, edge.target],
          edgeIds: [edge.id],
        });
      }
    } else if (rule.type === "no-cycles") {
      for (const group of findCycles([...ids], edges)) {
        const inGroup = new Set(group);
        violations.push({
          ruleId: rule.id, ruleType: rule.type,
          severity,
          message: `${rule.message ?? "Circular dependency"}: ${group.map(label).join(" ↔ ")}`,
          nodeIds: group,
          edgeIds: edges.filter((e) => inGroup.has(e.source) && inGroup.has(e.target)).map((e) => e.id),
        });
      }
    } else if (rule.type === "max-dependents") {
      for (const node of nodes) {
        if (rule.selector && !matchesSelector(node, rule.selector)) continue;
        const dependents = new Set(edges.filter((e) => e.target === node.id).map((e) => e.source));
        if (dependents.size > rule.limit) {
          violations.push({
            ruleId: rule.id, ruleType: rule.type,
            severity,
            message: `${rule.message ?? "Too many dependents"}: ${node.data.label} has ${dependents.size} (limit ${rule.limit})`,
            nodeIds: [node.id],
            edgeIds: [],
          });
        }
      }
    } else {
      for (const node of nodes) {
        if (rule.selector && !matchesSelector(node, rule.selector)) continue;
        const lines = lineCountOf(node);
        if (lines > rule.limit) {
          violations.push({
            ruleId: rule.id, ruleType: rule.type,
            severity,
            message: `${rule.message ?? "File too large"}: ${node.data.label} has ${lines.toLocaleString()} lines (limit ${rule.limit.toLocaleString()})`,
            nodeIds: [node.id],
            edgeIds: [],
          });
        }
      }
    }
  }
  return violations;
}

/** Stable identity of a violation, so a PR check can tell new ones from old ones. */
export function violationKey(v: RuleViolation): string {
  return `${v.ruleId}|${[...v.edgeIds, ...v.nodeIds].sort().join(",")}`;
}
