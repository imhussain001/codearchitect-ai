"use client";

import { useCallback, useEffect, useState, type Dispatch } from "react";
import type { WorkspaceAction } from "@/hooks/useWorkspace";
import { hasSeenTour, markTourSeen, type TourStep } from "@/lib/tour";

/**
 * Guided-tour state: opens once on a first visit, can be replayed, and remembers
 * that it was seen. localStorage may be blocked, so it must never be required.
 */
export function useGuidedTour(dispatch: Dispatch<WorkspaceAction>) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let storage: Storage | null = null;
    try {
      storage = window.localStorage;
    } catch {
      storage = null;
    }
    if (!hasSeenTour(storage)) setOpen(true);
  }, []);

  const close = useCallback(() => {
    setOpen(false);
    try {
      markTourSeen(window.localStorage);
    } catch {
      // storage unavailable: the tour simply shows again next visit
    }
  }, []);

  /** Some steps need a particular drawer tab open so their target is visible. */
  const enterStep = useCallback((step: TourStep) => step.tab && dispatch({ type: "setTab", tab: step.tab }), [dispatch]);

  return { open, setOpen, close, enterStep };
}
