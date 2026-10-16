"use client";

import clsx from "clsx";
import { FileSearch, History, Radar, Wand2, type LucideIcon } from "lucide-react";
import type { Dispatch } from "react";
import { BlastRadiusPanel } from "@/components/inspector/BlastRadiusPanel";
import { BuilderPanel } from "@/components/inspector/BuilderPanel";
import { NodeInspector } from "@/components/inspector/NodeInspector";
import { StoryPanel } from "@/components/inspector/StoryPanel";
import type { InspectorTab, WorkspaceAction, WorkspaceState } from "@/hooks/useWorkspace";
import type { NodeKind } from "@/lib/types";

const TABS: Array<{ id: InspectorTab; label: string; icon: LucideIcon }> = [
  { id: "inspector", label: "Inspector", icon: FileSearch },
  { id: "blast", label: "Blast Radius", icon: Radar },
  { id: "story", label: "Story", icon: History },
  { id: "builder", label: "Builder", icon: Wand2 },
];

type Props = {
  state: WorkspaceState;
  dispatch: Dispatch<WorkspaceAction>;
  samplePrompts: string[];
  onRunImpact: () => void;
  onSimulate: (nodeId: string) => void;
  onNarrate: () => void;
  onImportGitLog: (text: string) => void;
  onAddComponent: (input: { label: string; kind: NodeKind; filePath: string; description: string }) => void;
  onGenerateScaffold: () => void;
};

export function InspectorPanel({ state, dispatch, samplePrompts, ...handlers }: Props) {
  const { graph, activeTab, selectedNodeId } = state;
  const selectedNode = graph.nodes.find((n) => n.id === selectedNodeId);
  const select = (nodeId: string) => dispatch({ type: "selectNode", nodeId });

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-zinc-800/80 bg-zinc-950/60 backdrop-blur-xl">
      <div role="tablist" aria-label="Inspector modes" className="flex shrink-0 gap-1 border-b border-zinc-800/80 p-1.5">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            role="tab"
            type="button"
            id={`tab-${id}`}
            aria-selected={activeTab === id}
            aria-controls={`panel-${id}`}
            onClick={() => dispatch({ type: "setTab", tab: id })}
            className={clsx(
              "flex flex-1 items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-xs font-medium transition",
              activeTab === id ? "bg-zinc-800 text-zinc-50 shadow-inner" : "text-zinc-500 hover:bg-zinc-900 hover:text-zinc-200",
            )}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            {id === "blast" && state.impact.result && <span className="h-1.5 w-1.5 rounded-full bg-red-500" />}
            {id === "builder" && graph.nodes.some((n) => n.data.isDraft) && <span className="h-1.5 w-1.5 rounded-full bg-fuchsia-500" />}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`panel-${activeTab}`} aria-labelledby={`tab-${activeTab}`} className="scrollbar-thin min-h-0 flex-1 overflow-y-auto p-4">
        {activeTab === "inspector" && <NodeInspector graph={graph} node={selectedNode} onSelectNode={select} onSimulate={handlers.onSimulate} />}
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
            onSelectNode={select}
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
