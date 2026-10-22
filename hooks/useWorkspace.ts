"use client";

import { applyNodeChanges, type NodeChange } from "@xyflow/react";
import { useReducer } from "react";
import { findSample, DEFAULT_REPOSITORY_ID } from "@/lib/mockData";
import type { TraceRequest } from "@/lib/engines/provenance";
import type {
  ArchRule,
  ArchitectureGraph,
  ArchNode,
  CommitSnapshot,
  DependencyEdge,
  ImpactAnalysisResult,
  ScaffoldResult,
  StoryNarrative,
} from "@/lib/types";

export type InspectorTab = "inspector" | "blast" | "health" | "story" | "builder";
export type AsyncStatus = "idle" | "running" | "error";
export type Notice = { tone: "info" | "warning" | "error"; message: string };

export type WorkspaceState = {
  graph: ArchitectureGraph;
  selectedNodeId: string | null;
  activeTab: InspectorTab;
  impactPrompt: string;
  impact: { status: AsyncStatus; result: ImpactAnalysisResult | null; error?: string };
  story: { enabled: boolean; index: number; isPlaying: boolean; narrative: StoryNarrative | null; status: AsyncStatus };
  scaffold: { status: AsyncStatus; result: ScaffoldResult | null; error?: string };
  /** Dim everything outside the selected component's direct neighbourhood. */
  focusEnabled: boolean;
  /** The active provenance trace, if any. */
  trace: TraceRequest | null;
  notice: Notice | null;
};

export type WorkspaceAction =
  | { type: "loadGraph"; graph: ArchitectureGraph }
  | { type: "nodesChanged"; changes: NodeChange<ArchNode>[] }
  | { type: "selectNode"; nodeId: string | null }
  | { type: "toggleFocus" }
  | { type: "setRules"; rules: ArchRule[] }
  | { type: "setTrace"; trace: TraceRequest | null }
  | { type: "setTab"; tab: InspectorTab }
  | { type: "setImpactPrompt"; prompt: string }
  | { type: "impactStarted" }
  | { type: "impactSucceeded"; result: ImpactAnalysisResult }
  | { type: "impactFailed"; error: string }
  | { type: "clearImpact" }
  | { type: "applyImpact" }
  | { type: "toggleStory" }
  | { type: "setStoryIndex"; index: number }
  | { type: "setStoryPlaying"; isPlaying: boolean }
  | { type: "storyNarrationStarted" }
  | { type: "storyNarrated"; narrative: StoryNarrative }
  | { type: "storyNarrationFailed" }
  | { type: "setCommits"; commits: CommitSnapshot[] }
  | { type: "addDraftNode"; node: ArchNode }
  | { type: "addDraftEdge"; edge: DependencyEdge }
  | { type: "removeDraftEdge"; edgeId: string }
  | { type: "removeDraftNode"; nodeId: string }
  | { type: "scaffoldStarted" }
  | { type: "scaffoldSucceeded"; result: ScaffoldResult }
  | { type: "scaffoldFailed"; error: string }
  | { type: "applyScaffold" }
  | { type: "notify"; notice: Notice | null };

function freshState(graph: ArchitectureGraph): WorkspaceState {
  return {
    graph,
    selectedNodeId: null,
    activeTab: "inspector",
    impactPrompt: "",
    impact: { status: "idle", result: null },
    story: { enabled: false, index: Math.max(0, graph.commits.length - 1), isPlaying: false, narrative: null, status: "idle" },
    scaffold: { status: "idle", result: null },
    focusEnabled: false,
    trace: null,
    notice: graph.warnings?.length ? { tone: "warning", message: graph.warnings.join(" ") } : null,
  };
}

function replaceCode(nodes: ArchNode[], codeById: ReadonlyMap<string, string>): ArchNode[] {
  return nodes.map((n) => (codeById.has(n.id) ? { ...n, data: { ...n.data, code: codeById.get(n.id)! } } : n));
}

function withGraph(state: WorkspaceState, graph: Partial<ArchitectureGraph>): WorkspaceState {
  return { ...state, graph: { ...state.graph, ...graph } };
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case "loadGraph":
      return freshState(action.graph);

    case "nodesChanged": {
      // Only drafts may be deleted from the canvas; real components mirror the codebase.
      const draftIds = new Set(state.graph.nodes.filter((n) => n.data.isDraft).map((n) => n.id));
      const allowed = action.changes.filter((c) => c.type !== "remove" || draftIds.has(c.id));
      const removed = new Set(allowed.flatMap((c) => (c.type === "remove" ? [c.id] : [])));
      return withGraph(state, {
        nodes: applyNodeChanges(allowed, state.graph.nodes),
        edges: removed.size ? state.graph.edges.filter((e) => !removed.has(e.source) && !removed.has(e.target)) : state.graph.edges,
      });
    }

    case "selectNode":
      return { ...state, selectedNodeId: action.nodeId };
    case "toggleFocus":
      return { ...state, focusEnabled: !state.focusEnabled };
    case "setRules":
      return withGraph(state, { rules: action.rules });
    case "setTrace":
      return { ...state, trace: action.trace };
    case "setTab":
      return { ...state, activeTab: action.tab };
    case "setImpactPrompt":
      return { ...state, impactPrompt: action.prompt };

    case "impactStarted":
      return { ...state, impact: { ...state.impact, status: "running", error: undefined }, story: { ...state.story, enabled: false, isPlaying: false } };
    case "impactSucceeded":
      return { ...state, impact: { status: "idle", result: action.result } };
    case "impactFailed":
      return { ...state, impact: { ...state.impact, status: "error", error: action.error } };
    case "clearImpact":
      return { ...state, impact: { status: "idle", result: null } };
    case "applyImpact": {
      const result = state.impact.result;
      if (!result) return state;
      const next = withGraph(state, { nodes: replaceCode(state.graph.nodes, new Map(result.diffs.map((d) => [d.nodeId, d.after]))) });
      return { ...next, impact: { status: "idle", result: null }, notice: { tone: "info", message: `Applied ${result.diffs.length} file change(s) to the in-memory model. Export to download them.` } };
    }

    case "toggleStory": {
      const enabled = !state.story.enabled && state.graph.commits.length > 0;
      return {
        ...state,
        story: { ...state.story, enabled, isPlaying: false },
        activeTab: enabled ? "story" : state.activeTab,
        impact: enabled ? { status: "idle", result: null } : state.impact,
        notice: !state.story.enabled && state.graph.commits.length === 0 ? { tone: "info", message: "No commit history yet — paste `git log --name-status` in the Story tab." } : state.notice,
      };
    }
    case "setStoryIndex": {
      const index = Math.max(0, Math.min(action.index, state.graph.commits.length - 1));
      return { ...state, story: { ...state.story, index, enabled: true } };
    }
    case "setStoryPlaying":
      return { ...state, story: { ...state.story, isPlaying: action.isPlaying, enabled: action.isPlaying || state.story.enabled } };
    case "storyNarrationStarted":
      return { ...state, story: { ...state.story, status: "running" } };
    case "storyNarrated":
      return { ...state, story: { ...state.story, status: "idle", narrative: action.narrative } };
    case "storyNarrationFailed":
      return { ...state, story: { ...state.story, status: "error" } };
    case "setCommits":
      return {
        ...withGraph(state, { commits: action.commits }),
        story: { enabled: true, index: 0, isPlaying: false, narrative: null, status: "idle" },
        activeTab: "story",
      };

    case "addDraftNode":
      return { ...withGraph(state, { nodes: [...state.graph.nodes, action.node] }), selectedNodeId: action.node.id };
    case "addDraftEdge": {
      const exists = state.graph.edges.some((e) => e.source === action.edge.source && e.target === action.edge.target);
      return exists ? state : { ...withGraph(state, { edges: [...state.graph.edges, action.edge] }), activeTab: "builder" };
    }
    case "removeDraftEdge":
      return withGraph(state, { edges: state.graph.edges.filter((e) => !(e.id === action.edgeId && e.isDraft)) });
    case "removeDraftNode":
      return {
        ...withGraph(state, {
          nodes: state.graph.nodes.filter((n) => !(n.id === action.nodeId && n.data.isDraft)),
          edges: state.graph.edges.filter((e) => e.source !== action.nodeId && e.target !== action.nodeId),
        }),
        selectedNodeId: state.selectedNodeId === action.nodeId ? null : state.selectedNodeId,
      };

    case "scaffoldStarted":
      return { ...state, scaffold: { ...state.scaffold, status: "running", error: undefined } };
    case "scaffoldSucceeded":
      return { ...state, scaffold: { status: "idle", result: action.result } };
    case "scaffoldFailed":
      return { ...state, scaffold: { ...state.scaffold, status: "error", error: action.error } };
    case "applyScaffold": {
      const result = state.scaffold.result;
      if (!result) return state;
      const code = new Map([...result.files.map((f) => [f.nodeId, f.content] as const), ...result.diffs.map((d) => [d.nodeId, d.after] as const)]);
      const paths = new Map(result.files.map((f) => [f.nodeId, f.path]));
      const nodes = replaceCode(state.graph.nodes, code).map((n) =>
        n.data.isDraft ? { ...n, data: { ...n.data, isDraft: false, filePath: paths.get(n.id) ?? n.data.filePath } } : n,
      );
      const edges = state.graph.edges.map((e) => (e.isDraft ? { ...e, isDraft: false } : e));
      return {
        ...withGraph(state, { nodes, edges }),
        scaffold: { status: "idle", result: null },
        notice: { tone: "info", message: `Committed ${result.files.length} new component(s) to the model. Use Export Code Base to download the files.` },
      };
    }

    case "notify":
      return { ...state, notice: action.notice };
  }
}

export function useWorkspace() {
  return useReducer(workspaceReducer, undefined, () => freshState(findSample(DEFAULT_REPOSITORY_ID)!));
}
