"use client";

import clsx from "clsx";
import { Activity, Compass, FileSearch, History, Radar, Wand2, type LucideIcon } from "lucide-react";
import type { Dispatch } from "react";
import { BlastRadiusPanel } from "@/components/inspector/BlastRadiusPanel";
import { BuilderPanel } from "@/components/inspector/BuilderPanel";
import { GuidePanel } from "@/components/inspector/GuidePanel";
import { HealthPanel } from "@/components/inspector/HealthPanel";
import { NodeInspector } from "@/components/inspector/NodeInspector";
import { StoryPanel } from "@/components/inspector/StoryPanel";
import type { InspectorTab, WorkspaceAction, WorkspaceState } from "@/hooks/useWorkspace";
import type { HealthReport } from "@/lib/engines/health";
import type { Trace, TraceRequest } from "@/lib/engines/provenance";
import type { NodeKind, RuleViolation } from "@/lib/types";

const TABS: Array<{ id: InspectorTab; label: string; hint: string; icon: LucideIcon }> = [
  { id: "guide", label: "Guide", hint: "New here? A reading order for this codebase", icon: Compass },
  { id: "inspector", label: "Inspector", hint: "Code and details of the selected component", icon: FileSearch },
  { id: "blast", label: "Blast Radius", hint: "Simulate a change and see what it breaks", icon: Radar },
  { id: "health", label: "Health", hint: "Find fragile, tangled or oversized parts", icon: Activity },
  { id: "story", label: "Story", hint: "Replay how the architecture evolved", icon: History },
  { id: "builder", label: "Builder", hint: "Draw new components and generate the code", icon: Wand2 },
];

type Props = {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  samplePrompts: string[];
  healthReport: HealthReport;
  violations: RuleViolation[];
  trace: Trace | null;
  onTrace: (request: TraceRequest | null) => void;
  /** Select a component and pan/zoom the canvas to it. */
  onSelectAndCenter: (nodeId: string) => void;
  onRunImpact: () => void;
  onSimulate: (nodeId: string, symbol?: string) => void;
  onNarrate: () => void;
  onImportGitLog: (text: string) => void;
  onAddComponent: (input: { label: string; kind: NodeKind; filePath: string; description: string }) => void;
  onGenerateScaffold: () => void;
};

export function InspectorPanel({ state, dispatch, samplePrompts, healthReport, violations, trace, onTrace, onSelectAndCenter, ...handlers }: Props) {
  const { graph, activeTab, selectedNodeId } = state;
  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);

  return (
    <aside data-tour="inspector" className="flex h-full min-h-0 flex-col border-l border-zinc-800/80 bg-zinc-950/60 backdrop-blur-xl">
      {/* Container query: on a narrow drawer only the active tab shows its name; the rest keep their icon + tooltip. */}
      <div role="tablist" aria-label="Inspector modes" className="@container flex shrink-0 gap-1 border-b border-zinc-800/80 p-1.5">
        {TABS.map(({ id, label, hint, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            data-tour={`tab-${id}`}
            title={`${label}: ${hint}`}
            aria-label={label}
            aria-selected={activeTab === id}
            aria-controls={`panel-${id}`}
            onClick={() => dispatch({ type: "setTab", tab: id })}
            className={clsx(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition",
              activeTab === id ? "flex-[2] bg-zinc-800 text-zinc-50 shadow-inner" : "flex-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" />
            <span className={clsx("truncate", activeTab === id ? "inline" : "hidden @[34rem]:inline")}>{label}</span>
            {id === "blast" && state.impact.result && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-red-500" />}
            {id === "health" && violations.some((v) => v.severity === "error") && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-orange-500" />}
            {id === "builder" && graph.nodes.some((n) => n.data.isDraft) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-fuchsia-500" />}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === "guide" && <GuidePanel graph={graph} selectedNodeId={selectedNodeId} onSelectAndCenter={onSelectAndCenter} />}
        {activeTab === "inspector" && (
          <NodeInspector
            graph={graph}
            node={selectedNode}
            health={selectedNode ? healthReport.nodes[selectedNode.id] : undefined}
            trace={trace}
            onTrace={(mode) => onTrace(mode && selectedNode ? { nodeId: selectedNode.id, mode } : null)}
            onSelectNode={onSelectAndCenter}
            onSimulate={handlers.onSimulate}
          />
        )}
        {activeTab === "blast" && (
          <BlastRadiusPanel
            graph={graph}
            selectedNodeId={selectedNodeId}
            prompt={state.impactPrompt}
            samplePrompts={samplePrompts}
            status={state.impact.status}
            error={state.impact.error}
            result={state.impact.result}
            onPromptChange={(prompt) => dispatch({ type: "setImpactPrompt", prompt })}
            onRun={handlers.onRunImpact}
            onClear={() => dispatch({ type: "clearImpact" })}
            onApply={() => dispatch({ type: "applyImpact" })}
            onSelectNode={onSelectAndCenter}
          />
        )}
        {activeTab === "health" && (
          <HealthPanel
            graph={graph}
            report={healthReport}
            selectedNodeId={selectedNodeId}
            onSelectNode={onSelectAndCenter}
            rules={graph.rules}
            violations={violations}
            onSetRules={(rules) => dispatch({ type: "setRules", rules })}
          />
        )}
        {activeTab === "story" && (
          <StoryPanel
            graph={graph}
            enabled={state.story.enabled}
            index={state.story.index}
            isPlaying={state.story.isPlaying}
            narrative={state.story.narrative}
            narrationStatus={state.story.status}
            onToggle={() => dispatch({ type: "toggleStory" })}
            onIndexChange={(index) => dispatch({ type: "setStoryIndex", index })}
            onPlayingChange={(isPlaying) => dispatch({ type: "setStoryPlaying", isPlaying })}
            onNarrate={handlers.onNarrate}
            onImportGitLog={handlers.onImportGitLog}
          />
        )}
        {activeTab === "builder" && (
          <BuilderPanel
            graph={graph}
            status={state.scaffold.status}
            error={state.scaffold.error}
            result={state.scaffold.result}
            onAddComponent={handlers.onAddComponent}
            onRemoveDraft={(nodeId) => dispatch({ type: "removeDraftNode", nodeId })}
            onRemoveEdge={(edgeId) => dispatch({ type: "removeDraftEdge", edgeId })}
            onGenerate={handlers.onGenerateScaffold}
            onApply={() => dispatch({ type: "applyScaffold" })}
          />
        )}
      </div>
    </aside>
  );
}
