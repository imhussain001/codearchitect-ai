"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createIndexedDbStore, isDirty, restoreLast, saveWorkspace, type SavedWorkspace, type WorkspaceStore } from "@/lib/persistence";
import { findSample } from "@/lib/mockData";
import type { ArchitectureGraph } from "@/lib/types";

const SAVE_DEBOUNCE_MS = 600;

export type SaveStatus = "idle" | "saving" | "saved" | "unavailable";

type Inputs = {
  graph: ArchitectureGraph;
  /** The graph as it was imported, when the current graph is an import. */
  importedGraph: ArchitectureGraph | null;
  /** Called once at startup with the last saved workspace, if there is one. */
  onRestore: (saved: SavedWorkspace) => void;
  /** Load the original (unedited) version of the current graph. */
  onReset: (original: ArchitectureGraph) => void;
  store?: WorkspaceStore;
};

/**
 * Saves the workspace to this browser shortly after each change and restores it on the next
 * visit. Saving waits until the restore attempt has finished, so the shipped sample can never
 * overwrite a saved session. If storage is unavailable the app keeps working, unsaved.
 */
export function useAutosave({ graph, importedGraph, onRestore, onReset, store: injected }: Inputs) {
  const storeRef = useRef<WorkspaceStore | null>(null);
  const [ready, setReady] = useState(false);
  const [status, setStatus] = useState<SaveStatus>("idle");
  const restoreRef = useRef(onRestore);
  restoreRef.current = onRestore;

  const sample = findSample(graph.id);
  const original = sample ?? (importedGraph?.id === graph.id ? importedGraph : graph);
  const builtIn = sample !== undefined;
  const dirty = isDirty(graph, original);

  useEffect(() => {
    let cancelled = false;
    storeRef.current = injected ?? createIndexedDbStore();
    restoreLast(storeRef.current)
      .then((saved) => !cancelled && saved && restoreRef.current(saved))
      .catch(() => !cancelled && setStatus("unavailable"))
      .finally(() => !cancelled && setReady(true));
    return () => {
      cancelled = true;
    };
  }, [injected]);

  useEffect(() => {
    const store = storeRef.current;
    if (!ready || !store || status === "unavailable") return;
    setStatus("saving");
    const timer = setTimeout(() => {
      saveWorkspace(store, graph, { builtIn, original }).then(
        () => setStatus("saved"),
        () => setStatus("unavailable"),
      );
    }, SAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // `original` is derived from `graph`/`importedGraph`, which are listed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, importedGraph, ready]);

  const reset = useCallback(() => onReset(original), [onReset, original]);

  /** The saved version of a workspace, or null (also when storage is unavailable). */
  const loadSaved = useCallback(async (id: string): Promise<SavedWorkspace | null> => {
    try {
      return (await storeRef.current?.get(id)) ?? null;
    } catch {
      return null;
    }
  }, []);

  return { status, dirty, reset, loadSaved };
}
