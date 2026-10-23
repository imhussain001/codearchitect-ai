import type { SymbolChange } from "@/lib/engines/changedSymbols";
import { analyzeHealth, healthIssueKey, riskiestNodes, type HealthIssue, type HealthReport } from "@/lib/engines/health";
import { evaluateRules, violationKey } from "@/lib/engines/rules";
import { traceProvenance } from "@/lib/engines/provenance";
import { nodeIdForPath } from "@/lib/engines/story";
import { collectDependents, nodeById } from "@/lib/graph";
import type { ArchitectureGraph, ArchRule, RuleViolation } from "@/lib/types";

/** Hidden marker so a bot can find and update its own comment instead of posting a new one each push. */
export const REPORT_MARKER = "<!-- codearchitect-report -->";

const MAX_LISTED = 12;

export type Snapshot = {
  graph: ArchitectureGraph;
  health: HealthReport;
  violations: RuleViolation[];
};

export function takeSnapshot(graph: ArchitectureGraph, rules?: readonly ArchRule[]): Snapshot {
  return { graph, health: analyzeHealth(graph), violations: evaluateRules(graph, rules ?? graph.rules ?? []) };
}

/** What a change does to the exports of one file, and who that reaches. */
export type SymbolImpact = {
  path: string;
  label: string;
  modified: string[];
  added: string[];
  removed: string[];
  /** False when part of the change sits outside every export, so importers are not narrowed. */
  precise: boolean;
  /** Direct importers that use a changed or removed name (or whose usage is unknown). */
  affected: Array<{ label: string; symbols: string[] }>;
  /** Direct importers that import the file but none of the changed names. */
  spared: string[];
  /** Importers in files this change did not touch that still import a name the change removed. */
  stillImporting: Array<{ label: string; symbols: string[] }>;
};

export type Comparison = {
  base: Snapshot | null;
  head: Snapshot;
  newIssues: HealthIssue[];
  resolvedIssues: HealthIssue[];
  newViolations: RuleViolation[];
  resolvedViolations: RuleViolation[];
  /** head overall − base overall; 0 when there is no base. */
  scoreDelta: number;
  changedFiles: string[];
  /** Components (in the head map) that contain a changed file. */
  changedNodeIds: string[];
  /** Changed files that belong to no mapped component (docs, config, assets). */
  unmappedFiles: string[];
  /** Components that depend on a changed one: 1 hop and 2+ hops. */
  directDependents: string[];
  indirectDependents: string[];
  /** Deleted components that surviving components still depend on (in the base map). */
  removedStillUsedBy: Array<{ removed: string; usedBy: string[] }>;
  riskiestTouched: { nodeId: string; score: number } | null;
  /** Output files (data nodes) that a changed script or input feeds, and so may be out of date until it is re-run. */
  staleOutputs: Array<{ output: string; because: string[] }>;
  /** Per changed file: which exports changed and which importers use them. Empty unless the caller supplied symbol changes. */
  symbolImpact: SymbolImpact[];
};

function byKey<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  return new Map(items.map((item) => [key(item), item]));
}

/** Who each changed file's changed exports reach, using the symbols recorded on import edges. */
function computeSymbolImpact(base: Snapshot | null, head: Snapshot, changedFiles: readonly string[], changes: readonly SymbolChange[]): SymbolImpact[] {
  const changedSet = new Set(changedFiles.map((f) => f.split("\\").join("/")));
  const out: SymbolImpact[] = [];

  for (const change of changes) {
    if (!change.modified.length && !change.added.length && !change.removed.length && change.precise) continue;
    const inHead = nodeIdForPath(change.path, head.graph.nodes);
    const graph = inHead ? head.graph : base?.graph;
    const nodeId = inHead ?? (base ? nodeIdForPath(change.path, base.graph.nodes) : undefined);
    if (!graph || !nodeId) continue;

    const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
    const reached = new Set([...change.modified, ...change.removed]);
    const incoming = graph.edges.filter((e) => !e.isDraft && e.target === nodeId && e.source !== nodeId && e.relation !== "writes");

    const affected: SymbolImpact["affected"] = [];
    const spared: string[] = [];
    const seenAffected = new Set<string>();
    for (const e of incoming) {
      if (seenAffected.has(e.source)) continue;
      const used = e.symbols === undefined ? null : e.symbols.includes("*") ? [...reached] : e.symbols.filter((s) => reached.has(s));
      // Unknown usage, an imprecise change, or a name in common all count as affected; only a known miss is spared.
      if (!change.precise || used === null || used.length > 0) {
        seenAffected.add(e.source);
        affected.push({ label: label(e.source), symbols: used ?? [] });
      } else if (reached.size > 0) spared.push(label(e.source));
    }

    // A name this change removed that an importer, left untouched by the change, still imports.
    const stillImporting: SymbolImpact["stillImporting"] = [];
    if (inHead && change.removed.length) {
      for (const e of head.graph.edges) {
        if (e.isDraft || e.target !== nodeId || !e.symbols) continue;
        const importerPath = nodeById(head.graph.nodes, e.source)?.data.filePath;
        if (importerPath && changedSet.has(importerPath)) continue;
        const gone = e.symbols.filter((s) => change.removed.includes(s));
        if (gone.length) stillImporting.push({ label: label(e.source), symbols: gone });
      }
    }

    out.push({ path: change.path, label: nodeById(graph.nodes, nodeId)?.data.label ?? change.path, modified: change.modified, added: change.added, removed: change.removed, precise: change.precise, affected, spared, stillImporting });
  }
  return out;
}

/** What a change set does to the architecture: new/fixed problems and who it can ripple to. */
export function compareSnapshots(base: Snapshot | null, head: Snapshot, changedFiles: readonly string[] = [], symbolChanges: readonly SymbolChange[] = []): Comparison {
  const baseIssues = byKey(base?.health.issues ?? [], healthIssueKey);
  const headIssues = byKey(head.health.issues, healthIssueKey);
  const baseViolations = byKey(base?.violations ?? [], violationKey);
  const headViolations = byKey(head.violations, violationKey);

  const changedNodeIds = new Set<string>();
  const unmappedFiles: string[] = [];
  const deletedNodeIds = new Set<string>();
  for (const file of changedFiles) {
    const inHead = nodeIdForPath(file, head.graph.nodes);
    if (inHead) {
      changedNodeIds.add(inHead);
      continue;
    }
    const inBase = base ? nodeIdForPath(file, base.graph.nodes) : undefined;
    if (inBase) deletedNodeIds.add(inBase);
    else unmappedFiles.push(file);
  }

  const edges = head.graph.edges.filter((e) => !e.isDraft);
  const direct = new Set<string>();
  const indirect = new Set<string>();
  for (const id of changedNodeIds) {
    for (const [dependent, depth] of collectDependents(id, edges)) {
      if (changedNodeIds.has(dependent)) continue;
      (depth === 1 ? direct : indirect).add(dependent);
    }
  }
  for (const id of direct) indirect.delete(id);

  const removedStillUsedBy: Comparison["removedStillUsedBy"] = [];
  if (base) {
    const baseEdges = base.graph.edges.filter((e) => !e.isDraft);
    for (const removed of deletedNodeIds) {
      const usedBy = [...collectDependents(removed, baseEdges).keys()].filter((id) => id !== removed && !deletedNodeIds.has(id) && nodeById(head.graph.nodes, id));
      if (usedBy.length) removedStillUsedBy.push({ removed: nodeById(base.graph.nodes, removed)!.data.label, usedBy: usedBy.map((id) => nodeById(head.graph.nodes, id)!.data.label) });
    }
  }

  // A changed script or input file makes everything downstream of it stale until the pipeline is re-run.
  const staleBy = new Map<string, string[]>();
  for (const id of changedNodeIds) {
    const trace = traceProvenance(head.graph, { nodeId: id, mode: "downstream" });
    for (const out of trace?.results ?? []) {
      if (changedNodeIds.has(out)) continue;
      (staleBy.get(out) ?? staleBy.set(out, []).get(out)!).push(nodeById(head.graph.nodes, id)!.data.label);
    }
  }
  const staleOutputs = [...staleBy]
    .map(([out, because]) => ({ output: nodeById(head.graph.nodes, out)!.data.label, because }))
    .sort((a, b) => a.output.localeCompare(b.output));

  const symbolImpact = computeSymbolImpact(base, head, changedFiles, symbolChanges);

  const touched = [...changedNodeIds].map((id) => head.health.nodes[id]).filter((n) => n !== undefined);
  const riskiest = touched.sort((a, b) => b.score - a.score)[0];

  return {
    base,
    head,
    newIssues: head.health.issues.filter((i) => !baseIssues.has(healthIssueKey(i))),
    resolvedIssues: (base?.health.issues ?? []).filter((i) => !headIssues.has(healthIssueKey(i))),
    newViolations: head.violations.filter((v) => !baseViolations.has(violationKey(v))),
    resolvedViolations: (base?.violations ?? []).filter((v) => !headViolations.has(violationKey(v))),
    scoreDelta: base ? head.health.overall - base.health.overall : 0,
    changedFiles: [...changedFiles],
    changedNodeIds: [...changedNodeIds],
    unmappedFiles,
    directDependents: [...direct],
    indirectDependents: [...indirect],
    removedStillUsedBy,
    riskiestTouched: riskiest ? { nodeId: riskiest.nodeId, score: riskiest.score } : null,
    staleOutputs,
    symbolImpact,
  };
}

/* ---------- Pass / fail ---------- */

export type CheckOptions = {
  /** Fail when the change introduces a circular dependency (default true). */
  failOnNewCycles?: boolean;
  /** Fail when the change breaks an `error`-severity rule (default true). */
  failOnNewViolations?: boolean;
  /** Fail when the overall health score drops by more than this many points. Off by default. */
  maxHealthDrop?: number;
  /** Fail when a change removes an export that another, untouched file still imports. Off by default (the match is heuristic). */
  failOnRemovedExports?: boolean;
};

export type CheckResult = { passed: boolean; failures: string[] };

/** A `no-cycles` rule violation describes the same loop as the health check's cycle issue. */
function cycleKeyOf(nodeIds: readonly string[]): string {
  return `cycle:${[...nodeIds].sort().join(",")}`;
}

/** New rule violations excluding `no-cycles` ones already reported as a health cycle (so nothing is counted twice). */
function distinctNewViolations(c: Comparison): RuleViolation[] {
  const newCycles = new Set(c.newIssues.filter((i) => i.kind === "cycle").map((i) => healthIssueKey(i)));
  return c.newViolations.filter((v) => !(v.ruleType === "no-cycles" && newCycles.has(cycleKeyOf(v.nodeIds))));
}

export function evaluateCheck(c: Comparison, options: CheckOptions = {}): CheckResult {
  const { failOnNewCycles = true, failOnNewViolations = true, maxHealthDrop } = options;
  const failures: string[] = [];

  const cycles = c.newIssues.filter((i) => i.kind === "cycle");
  if (failOnNewCycles && cycles.length) failures.push(`${cycles.length} new circular ${cycles.length === 1 ? "dependency" : "dependencies"}`);

  const errors = (failOnNewCycles ? distinctNewViolations(c) : c.newViolations).filter((v) => v.severity === "error");
  if (failOnNewViolations && errors.length) failures.push(`${errors.length} new architecture rule ${errors.length === 1 ? "violation" : "violations"}`);

  const dangling = c.symbolImpact.reduce((n, s) => n + s.stillImporting.length, 0);
  if (options.failOnRemovedExports && dangling) failures.push(`${dangling} removed export${dangling === 1 ? "" : "s"} still imported by files this change does not touch`);

  if (maxHealthDrop !== undefined && -c.scoreDelta > maxHealthDrop) failures.push(`health score dropped by ${-c.scoreDelta} (limit ${maxHealthDrop})`);
  return { passed: failures.length === 0, failures };
}

/** Machine-readable summary for scripts and dashboards (no graphs, just the findings). */
export function comparisonToJson(c: Comparison, check: CheckResult) {
  const label = (id: string) => nodeById(c.head.graph.nodes, id)?.data.label ?? id;
  return {
    passed: check.passed,
    failures: check.failures,
    health: { grade: c.head.health.grade, score: c.head.health.overall, baseScore: c.base?.health.overall ?? null, delta: c.scoreDelta, counts: c.head.health.counts },
    newViolations: c.newViolations,
    resolvedViolations: c.resolvedViolations,
    newIssues: c.newIssues.map(({ kind, severity, title, detail }) => ({ kind, severity, title, detail })),
    resolvedIssues: c.resolvedIssues.map(({ kind, title }) => ({ kind, title })),
    blastRadius: {
      changedFiles: c.changedFiles.length,
      changedComponents: c.changedNodeIds.map(label),
      directDependents: c.directDependents.map(label),
      indirectDependents: c.indirectDependents.map(label),
      unmappedFiles: c.unmappedFiles,
      removedStillUsedBy: c.removedStillUsedBy,
      staleOutputs: c.staleOutputs,
      changedSymbols: c.symbolImpact,
    },
  };
}

/* ---------- Markdown ---------- */

const escapeCell = (text: string) => text.replace(/\|/g, "\\|").replace(/\n/g, " ");

function signed(n: number): string {
  return n === 0 ? "±0" : n > 0 ? `+${n}` : `−${Math.abs(n)}`;
}

function listWithMore(items: readonly string[], max = MAX_LISTED): string[] {
  return items.length <= max ? [...items] : [...items.slice(0, max), `…and ${items.length - max} more`];
}

const ruleCount = (s: Snapshot) => s.violations.filter((v) => v.ruleType !== "no-cycles").length;

export function renderMarkdown(c: Comparison, check: CheckResult): string {
  const label = (id: string) => nodeById(c.head.graph.nodes, id)?.data.label ?? id;
  const { head, base } = c;
  const lines: string[] = [REPORT_MARKER];

  lines.push(`## ${check.passed ? "✅" : "❌"} Architecture check${check.passed ? "" : `: ${check.failures.join(", ")}`}`, "");

  const cyclesNow = head.health.counts.cycles;
  const rows = [
    ["Health grade", base ? `${base.health.grade} · ${base.health.overall}` : "n/a", `${head.health.grade} · ${head.health.overall}${base ? ` (${signed(c.scoreDelta)})` : ""}`],
    ["Circular dependencies", base ? String(base.health.counts.cycles) : "n/a", `${cyclesNow}${base ? ` (${signed(cyclesNow - base.health.counts.cycles)})` : ""}`],
    // Loops are counted in the row above, so a `no-cycles` rule does not count them a second time.
    ["Rule violations", base ? String(ruleCount(base)) : "n/a", `${ruleCount(head)}${base ? ` (${signed(ruleCount(head) - ruleCount(base))})` : ""}`],
  ];
  lines.push("| | Base | This PR |", "|---|---|---|", ...rows.map((r) => `| ${r.map(escapeCell).join(" | ")} |`), "");

  const shownViolations = distinctNewViolations(c);
  if (shownViolations.length || c.newIssues.length) {
    lines.push(`### New problems (${shownViolations.length + c.newIssues.length})`);
    for (const v of listWithMore(shownViolations.map((v) => `- ${v.severity === "error" ? "🟠" : "🟡"} **Rule \`${v.ruleId}\`**: ${escapeCell(v.message)}`))) lines.push(v);
    for (const i of listWithMore(c.newIssues.map((i) => `- ${i.severity === "high" ? "🔴" : i.severity === "medium" ? "🟠" : "🟡"} **${escapeCell(i.title)}**: ${escapeCell(i.detail)}`))) lines.push(i);
    lines.push("");
  }
  if (c.resolvedViolations.length || c.resolvedIssues.length) {
    lines.push(`### Fixed by this PR (${c.resolvedViolations.length + c.resolvedIssues.length})`);
    for (const v of listWithMore(c.resolvedViolations.map((v) => `- ✔ Rule \`${v.ruleId}\`: ${escapeCell(v.message)}`))) lines.push(v);
    for (const i of listWithMore(c.resolvedIssues.map((i) => `- ✔ ${escapeCell(i.title)}`))) lines.push(i);
    lines.push("");
  }

  lines.push("### Blast radius");
  if (c.changedNodeIds.length === 0 && c.removedStillUsedBy.length === 0) {
    lines.push(c.changedFiles.length === 1 ? "The one changed file does not belong to a mapped component." : c.changedFiles.length ? `None of the ${c.changedFiles.length} changed files belong to a mapped component.` : "No changed files were given.");
  } else {
    const dependents = c.directDependents.length + c.indirectDependents.length;
    lines.push(
      `This change touches **${c.changedNodeIds.length}** component${c.changedNodeIds.length === 1 ? "" : "s"} (${listWithMore(c.changedNodeIds.map(label), 5).join(", ")}). ` +
        (dependents === 0
          ? (c.changedNodeIds.length === 1 ? "Nothing else depends on it." : "Nothing else depends on them.")
          : `**${dependents}** other component${dependents === 1 ? " depends" : "s depend"} on ${c.changedNodeIds.length === 1 ? "it" : "them"} (${c.directDependents.length} directly, ${c.indirectDependents.length} indirectly).`),
    );
    if (c.riskiestTouched) {
      const level = head.health.nodes[c.riskiestTouched.nodeId]?.level ?? "healthy";
      lines.push(`Riskiest component touched: **${label(c.riskiestTouched.nodeId)}** (change-risk ${c.riskiestTouched.score}, ${level}).`);
    }
    for (const r of c.removedStillUsedBy) lines.push(`⚠ Removed **${escapeCell(r.removed)}** is still used by ${listWithMore(r.usedBy, 5).join(", ")}.`);
    if (c.symbolImpact.length) {
      lines.push("", "**Changed exports**");
      for (const s of c.symbolImpact) {
        const parts = [
          s.modified.length ? `modified ${s.modified.map((n) => `\`${n}\``).join(", ")}` : "",
          s.removed.length ? `removed ${s.removed.map((n) => `\`${n}\``).join(", ")}` : "",
          s.added.length ? `added ${s.added.map((n) => `\`${n}\``).join(", ")}` : "",
        ].filter(Boolean);
        lines.push("", `- **${escapeCell(s.label)}** (\`${escapeCell(s.path)}\`): ${parts.join("; ") || "changes outside any export"}`);
        if (!s.precise) {
          lines.push(`  - Part of the change is outside every export (module-level code), so all **${s.affected.length}** importer${s.affected.length === 1 ? "" : "s"} are counted: ${listWithMore(s.affected.map((a) => escapeCell(a.label)), 5).join(", ")}.`);
          continue;
        }
        if (s.modified.length || s.removed.length) {
          lines.push(`  - **${s.affected.length}** file${s.affected.length === 1 ? "" : "s"} use${s.affected.length === 1 ? "s" : ""} ${s.affected.length === 1 ? "a changed name" : "the changed names"}${s.affected.length ? `: ${listWithMore(s.affected.map((a) => escapeCell(a.label) + (a.symbols.length ? ` (${a.symbols.map((n) => `\`${n}\``).join(", ")})` : "")), 5).join(", ")}` : ""}.`);
          if (s.spared.length) lines.push(`  - **${s.spared.length}** other file${s.spared.length === 1 ? "" : "s"} import${s.spared.length === 1 ? "s" : ""} it but none of those names: ${listWithMore(s.spared.map(escapeCell), 5).join(", ")}.`);
        }
        for (const m of s.stillImporting) lines.push(`  - ⚠ Removed ${m.symbols.map((n) => `\`${n}\``).join(", ")} is still imported by ${escapeCell(m.label)}, which this change does not touch.`);
      }
    }
    if (c.staleOutputs.length) {
      lines.push("", `**${c.staleOutputs.length}** output file${c.staleOutputs.length === 1 ? "" : "s"} may be out of date until the pipeline is re-run:`);
      for (const s of listWithMore(c.staleOutputs.map((s) => `- \`${escapeCell(s.output)}\` _(from ${listWithMore(s.because, 3).map(escapeCell).join(", ")})_`))) lines.push(s);
    }
    if (dependents > 0) {
      lines.push("", "<details><summary>Components that may need a look</summary>", "");
      for (const id of listWithMore(c.directDependents.map(label))) lines.push(`- ${id} _(direct)_`);
      for (const id of listWithMore(c.indirectDependents.map(label))) lines.push(`- ${id} _(indirect)_`);
      lines.push("", "</details>");
    }
  }

  const risky = riskiestNodes(head.health, 3).filter((n) => n.level === "risky");
  if (risky.length) lines.push("", `Currently riskiest overall: ${risky.map((n) => `${label(n.nodeId)} (${n.score})`).join(", ")}.`);

  lines.push("", "<sub>Structural analysis by CodeArchitect AI. Heuristic: it shows where to look, not whether the change is correct.</sub>", "");
  return lines.join("\n");
}

/** Markdown health and rules summary of one snapshot (the `analyze` command). */
export function renderAnalysis(snapshot: Snapshot, name: string): string {
  const { graph, health, violations } = snapshot;
  const label = (id: string) => nodeById(graph.nodes, id)?.data.label ?? id;
  const lines = [
    `# Architecture of ${name}`,
    "",
    `**Health ${health.grade} (${health.overall}/100)** · ${graph.nodes.length} components · ${graph.edges.length} dependencies · ${violations.length} rule violation${violations.length === 1 ? "" : "s"}`,
    "",
  ];
  if (violations.length) {
    lines.push("## Rule violations");
    for (const v of listWithMore(violations.map((v) => `- ${v.severity === "error" ? "🟠 error" : "🟡 warn"} \`${v.ruleId}\`: ${escapeCell(v.message)}`), 30)) lines.push(v);
    lines.push("");
  }
  if (health.issues.length) {
    lines.push("## Health issues");
    for (const i of listWithMore(health.issues.map((i) => `- ${i.severity === "high" ? "🔴" : i.severity === "medium" ? "🟠" : "🟡"} **${escapeCell(i.title)}**: ${escapeCell(i.detail)}`), 30)) lines.push(i);
    lines.push("");
  }
  const risky = riskiestNodes(health, 5);
  if (risky.length) {
    lines.push("## Riskiest components", "", "| Risk | Component | Why |", "|---|---|---|");
    for (const n of risky) lines.push(`| ${n.score} | ${escapeCell(label(n.nodeId))} | ${escapeCell(n.reasons.join("; ") || "-")} |`);
    lines.push("");
  }
  for (const w of graph.warnings ?? []) lines.push(`> ${w}`);
  return lines.join("\n") + "\n";
}
