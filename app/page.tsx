"use client";

import { ReactFlowProvider, type Connection } from "@xyflow/react";
import clsx from "clsx";
import { AlertTriangle, Info, X, XCircle } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArchitectureCanvas, type CenterRequest } from "@/components/ArchitectureCanvas";
import type { NodeActions } from "@/components/CustomNode";
import { ImportDialog } from "@/components/ImportDialog";
import { InspectorPanel } from "@/components/InspectorPanel";
import { GuidedTour } from "@/components/GuidedTour";
import { CUSTOM_UPLOAD_OPTION, TopNav } from "@/components/TopNav";
import { useGuidedTour } from "@/hooks/useGuidedTour";
import { useShortcuts } from "@/hooks/useShortcuts";
import { useWorkspace, type Notice } from "@/hooks/useWorkspace";
import { fetchEngine, requestImpact, requestRepoFromFiles, requestRepoFromGithub, requestScaffold, requestStory } from "@/lib/apiClient";
import { analyzeHealth } from "@/lib/engines/health";
import { traceProvenance } from "@/lib/engines/provenance";
import { evaluateRules } from "@/lib/engines/rules";
import { commitsFromGitLog } from "@/lib/engines/story";
import { kebabCase } from "@/lib/engines/localScaffold";
import { findSample, SAMPLE_PROMPTS, SAMPLE_REPOSITORIES } from "@/lib/mockData";
import { exportCodebase, readUpload } from "@/lib/portability";
import type { ArchitectureGraph, ArchNode, EngineInfo, NodeKind } from "@/lib/types";
import { buildRenderGraph } from "@/lib/viewModel";

const STORY_STEP_MS = 2600;
const DRAFT_VERTICAL_GAP_PX = 200;

const NOTICE_STYLE: Record<Notice["tone"], { box: string; icon: typeof Info }> = {
  info: { box: "border-sky-500/30 bg-sky-950/80 text-sky-100", icon: Info },
  warning: { box: "border-amber-500/30 bg-amber-950/80 text-amber-100", icon: AlertTriangle },
  error: { box: "border-red-500/30 bg-red-950/80 text-red-100", icon: XCircle },
};

const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function Page() {
  const [state, dispatch] = useWorkspace();
  const { graph } = state;
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [importedGraph, setImportedGraph] = useState<ArchitectureGraph | null>(null);
  const [importState, setImportState] = useState<{ open: boolean; busy: boolean; error: string | null }>({ open: false, busy: false, error: null });
  const [isExporting, setIsExporting] = useState(false);
  const [centerRequest, setCenterRequest] = useState<CenterRequest | null>(null);
  const centerNonce = useRef(0);

  // Async results are discarded if the user switched repositories while waiting.
  const graphIdRef = useRef(graph.id);
  graphIdRef.current = graph.id;
  const graphRef = useRef(graph);
  graphRef.current = graph;

  const notify = useCallback((notice: Notice | null) => dispatch({ type: "notify", notice }), [dispatch]);

  useEffect(() => {
    void fetchEngine().then((info) => {
      setEngine(info);
      if (info.error) notify({ tone: "warning", message: `AI provider misconfigured — using the local engine. ${info.error}` });
    });
  }, [notify]);

  /* ---------- Story playback ---------- */
  const { isPlaying, index: storyIndex } = state.story;
  useEffect(() => {
    if (!isPlaying) return;
    if (storyIndex >= graph.commits.length - 1) {
      dispatch({ type: "setStoryPlaying", isPlaying: false });
      return;
    }
    const timer = setTimeout(() => dispatch({ type: "setStoryIndex", index: storyIndex + 1 }), STORY_STEP_MS);
    return () => clearTimeout(timer);
  }, [isPlaying, storyIndex, graph.commits.length, dispatch]);

  /* ---------- Derived canvas model ---------- */
  const healthReport = useMemo(() => analyzeHealth(graph), [graph]);
  const violations = useMemo(() => evaluateRules(graph), [graph]);
  const trace = useMemo(() => (state.trace ? traceProvenance(graph, state.trace) : null), [graph, state.trace]);
  const isHealthView = state.activeTab === "health";
  const focusNodeId = state.focusEnabled ? state.selectedNodeId : null;
  const { nodes, edges } = useMemo(
    () => buildRenderGraph({ graph, impact: state.impact.result, story: state.story, health: isHealthView ? healthReport : null, focusNodeId, selectedNodeId: state.selectedNodeId, violations: isHealthView ? violations : [], trace }),
    [graph, state.impact.result, state.story, isHealthView, healthReport, focusNodeId, state.selectedNodeId, violations, trace],
  );

  /** Select a component and pan/zoom the canvas to it. */
  const selectAndCenter = useCallback(
    (nodeId: string) => {
      dispatch({ type: "selectNode", nodeId });
      setCenterRequest({ nodeId, nonce: ++centerNonce.current });
    },
    [dispatch],
  );

  const tour = useGuidedTour(dispatch);
  useShortcuts({ dispatch, tourOpen: tour.open, hasTrace: state.trace !== null, openTour: () => tour.setOpen(true) });

  /* ---------- Handlers ---------- */
  const loadGraph = useCallback((next: ArchitectureGraph) => dispatch({ type: "loadGraph", graph: next }), [dispatch]);

  const selectRepository = (id: string) => {
    if (id === CUSTOM_UPLOAD_OPTION) {
      setImportState({ open: true, busy: false, error: null });
      return;
    }
    const next = id === importedGraph?.id ? importedGraph : findSample(id);
    if (next) loadGraph(next);
  };

  const runImpact = useCallback(async () => {
    const snapshot = graphRef.current;
    const prompt = state.impactPrompt.trim();
    if (!prompt) {
      dispatch({ type: "setTab", tab: "blast" });
      return;
    }
    dispatch({ type: "setTab", tab: "blast" });
    dispatch({ type: "impactStarted" });
    try {
      const { data, warning } = await requestImpact(snapshot, prompt, state.selectedNodeId);
      if (graphIdRef.current !== snapshot.id) return;
      dispatch({ type: "impactSucceeded", result: data });
      if (warning) notify({ tone: "warning", message: warning });
    } catch (error) {
      if (graphIdRef.current === snapshot.id) dispatch({ type: "impactFailed", error: errorMessage(error) });
    }
  }, [state.impactPrompt, state.selectedNodeId, dispatch, notify]);

  const simulateFrom = useCallback(
    (nodeId: string) => {
      dispatch({ type: "selectNode", nodeId });
      dispatch({ type: "setTab", tab: "blast" });
    },
    [dispatch],
  );

  const nodeActions = useMemo<NodeActions>(
    () => ({
      inspect: (nodeId) => {
        dispatch({ type: "selectNode", nodeId });
        dispatch({ type: "setTab", tab: "inspector" });
      },
      simulateFrom,
      copyPath: (filePath) => {
        navigator.clipboard.writeText(filePath).then(
          () => notify({ tone: "info", message: `Copied ${filePath}` }),
          () => notify({ tone: "error", message: "Clipboard access was denied." }),
        );
      },
    }),
    [dispatch, notify, simulateFrom],
  );

  const narrate = async () => {
    const snapshot = graphRef.current;
    dispatch({ type: "storyNarrationStarted" });
    try {
      const { data, warning } = await requestStory(snapshot);
      if (graphIdRef.current !== snapshot.id) return;
      dispatch({ type: "storyNarrated", narrative: data });
      if (warning) notify({ tone: "warning", message: warning });
      else if (data.engine === "local") notify({ tone: "info", message: "No AI model is configured — showing commit-derived narratives." });
    } catch (error) {
      dispatch({ type: "storyNarrationFailed" });
      notify({ tone: "error", message: errorMessage(error) });
    }
  };

  const importGitLog = (text: string) => {
    try {
      const commits = commitsFromGitLog(text, graph.nodes);
      dispatch({ type: "setCommits", commits });
      const mapped = commits.filter((c) => c.addedNodeIds.length + c.modifiedNodeIds.length > 0).length;
      notify({ tone: "info", message: `Imported ${commits.length} commits; ${mapped} touch components on this map.` });
    } catch (error) {
      notify({ tone: "error", message: errorMessage(error) });
    }
  };

  const addComponent = ({ label, kind, filePath, description }: { label: string; kind: NodeKind; filePath: string; description: string }) => {
    const base = `draft-${kebabCase(label) || "component"}`;
    let id = base;
    for (let n = 2; graph.nodes.some((node) => node.id === id); n++) id = `${base}-${n}`;
    const anchor = graph.nodes.find((node) => node.id === state.selectedNodeId);
    const lowest = Math.max(0, ...graph.nodes.map((node) => node.position.y));
    const node: ArchNode = {
      id,
      type: "component",
      position: anchor ? { x: anchor.position.x + 260, y: anchor.position.y + 40 } : { x: 260, y: lowest + DRAFT_VERTICAL_GAP_PX },
      data: { label, kind, filePath, description, language: filePath.split(".").pop() ?? "ts", code: `// ${label} — not generated yet`, exports: [], imports: [], params: [], keywords: kebabCase(label).split("-"), isDraft: true },
    };
    dispatch({ type: "addDraftNode", node });
  };

  const connect = (connection: Connection) => {
    if (!connection.source || !connection.target) return;
    dispatch({
      type: "addDraftEdge",
      edge: { id: `draft-e-${connection.source}--${connection.target}`, source: connection.source, target: connection.target, relation: "calls", isDraft: true },
    });
  };

  const generateScaffold = async () => {
    const snapshot = graphRef.current;
    dispatch({ type: "scaffoldStarted" });
    try {
      const { data, warning } = await requestScaffold(snapshot);
      if (graphIdRef.current !== snapshot.id) return;
      dispatch({ type: "scaffoldSucceeded", result: data });
      if (warning) notify({ tone: "warning", message: warning });
    } catch (error) {
      dispatch({ type: "scaffoldFailed", error: errorMessage(error) });
    }
  };

  const finishImport = (next: ArchitectureGraph, warning?: string) => {
    setImportedGraph(next);
    loadGraph(next);
    setImportState({ open: false, busy: false, error: null });
    const notes = [warning, ...(next.warnings ?? [])].filter(Boolean).join(" ");
    if (notes) notify({ tone: "warning", message: notes });
  };

  const uploadFile = async (file: File) => {
    setImportState((s) => ({ ...s, busy: true, error: null }));
    try {
      const upload = await readUpload(file);
      if (upload.kind === "graph") return finishImport(upload.graph);
      if (upload.files.length === 0) throw new Error("No supported source files found in the archive.");
      const { data, warning } = await requestRepoFromFiles(upload.name, upload.files);
      finishImport(data, [warning, upload.skipped ? `${upload.skipped} oversized file(s) skipped.` : ""].filter(Boolean).join(" ") || undefined);
    } catch (error) {
      setImportState((s) => ({ ...s, busy: false, error: errorMessage(error) }));
    }
  };

  const analyzeGithub = async (url: string) => {
    setImportState((s) => ({ ...s, busy: true, error: null }));
    try {
      const { data, warning } = await requestRepoFromGithub(url);
      finishImport(data, warning);
    } catch (error) {
      setImportState((s) => ({ ...s, busy: false, error: errorMessage(error) }));
    }
  };

  const exportAll = async () => {
    setIsExporting(true);
    try {
      await exportCodebase(graph);
    } catch (error) {
      notify({ tone: "error", message: `Export failed: ${errorMessage(error)}` });
    } finally {
      setIsExporting(false);
    }
  };

  const notice = state.notice;
  const NoticeIcon = notice ? NOTICE_STYLE[notice.tone].icon : Info;

  return (
    <div className="flex h-dvh flex-col bg-[radial-gradient(ellipse_at_top_left,_rgba(139,92,246,0.10),_transparent_50%),radial-gradient(ellipse_at_bottom_right,_rgba(14,165,233,0.08),_transparent_50%)] bg-zinc-950">
      <TopNav
        graph={graph}
        samples={SAMPLE_REPOSITORIES}
        importedGraph={importedGraph}
        engine={engine}
        isStoryOn={state.story.enabled}
        isImpactActive={state.impact.result !== null || state.impact.status === "running"}
        isExporting={isExporting}
        onSelectRepository={selectRepository}
        onSimulate={() => void runImpact()}
        onToggleStory={() => dispatch({ type: "toggleStory" })}
        onExport={() => void exportAll()}
        onHelp={() => tour.setOpen(true)}
      />

      <main className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <section data-tour="canvas" className="relative h-[55vh] min-h-0 lg:h-auto lg:basis-[65%]" aria-label="Architecture graph">
          <ReactFlowProvider>
            <ArchitectureCanvas
              graphKey={graph.id}
              kindLabels={graph.kindLabels}
              centerRequest={centerRequest}
              searchNodes={graph.nodes}
              onSearchSelect={selectAndCenter}
              focusEnabled={state.focusEnabled}
              hasSelection={state.selectedNodeId !== null}
              onToggleFocus={() => dispatch({ type: "toggleFocus" })}
              banner={
                trace && (
                  <div className="flex items-center gap-2 self-start rounded-full border border-cyan-500/50 bg-cyan-950/85 py-1 pl-3 pr-1.5 text-xs text-cyan-100 shadow-lg backdrop-blur">
                    <span>
                      {trace.mode === "upstream" ? "Where" : "What"} <b>{graph.nodes.find((n) => n.id === trace.nodeId)?.data.label}</b> {trace.mode === "upstream" ? "comes from" : "affects"} ·{" "}
                      {trace.nodeIds.length - 1} other{trace.nodeIds.length === 2 ? "" : "s"}
                    </span>
                    <button type="button" onClick={() => dispatch({ type: "setTrace", trace: null })} className="rounded-full bg-cyan-500/20 px-2 py-0.5 font-medium hover:bg-cyan-500/35">
                      Clear (Esc)
                    </button>
                  </div>
                )
              }
              nodes={nodes}
              edges={edges}
              actions={nodeActions}
              onNodesChange={(changes) => dispatch({ type: "nodesChanged", changes })}
              onSelectNode={(nodeId) => dispatch({ type: "selectNode", nodeId })}
              onConnect={connect}
              onRemoveDraftEdge={(edgeId) => dispatch({ type: "removeDraftEdge", edgeId })}
            />
          </ReactFlowProvider>

          {!trace && state.story.enabled && graph.commits[state.story.index] && (
            <div className="pointer-events-none absolute inset-x-0 top-14 flex justify-center">
              <div className="rounded-full border border-violet-500/40 bg-violet-950/80 px-3 py-1 text-xs text-violet-100 backdrop-blur">
                <span className="font-mono text-violet-300">{graph.commits[state.story.index]!.hash}</span> · {graph.commits[state.story.index]!.phase}
              </div>
            </div>
          )}

          {notice && (
            <div role="status" className={clsx("absolute bottom-4 left-16 right-48 z-10 flex max-w-xl items-start gap-2 rounded-lg border px-3 py-2 text-xs shadow-xl backdrop-blur", NOTICE_STYLE[notice.tone].box)}>
              <NoticeIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span className="flex-1 leading-relaxed">{notice.message}</span>
              <button type="button" aria-label="Dismiss" onClick={() => notify(null)} className="opacity-70 hover:opacity-100">
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </section>

        <div className="min-h-0 flex-1 lg:basis-[35%] lg:min-w-[380px]">
          <InspectorPanel
            state={state}
            dispatch={dispatch}
            samplePrompts={SAMPLE_PROMPTS[graph.id] ?? []}
            healthReport={healthReport}
            violations={violations}
            trace={trace}
            onTrace={(request) => dispatch({ type: "setTrace", trace: request })}
            onSelectAndCenter={selectAndCenter}
            onRunImpact={() => void runImpact()}
            onSimulate={simulateFrom}
            onNarrate={() => void narrate()}
            onImportGitLog={importGitLog}
            onAddComponent={addComponent}
            onGenerateScaffold={() => void generateScaffold()}
          />
        </div>
      </main>

      <GuidedTour open={tour.open} onClose={tour.close} onEnterStep={tour.enterStep} />

      <ImportDialog
        open={importState.open}
        isBusy={importState.busy}
        error={importState.error}
        onClose={() => setImportState({ open: false, busy: false, error: null })}
        onUploadFile={(file) => void uploadFile(file)}
        onGithubUrl={(url) => void analyzeGithub(url)}
      />
    </div>
  );
}
