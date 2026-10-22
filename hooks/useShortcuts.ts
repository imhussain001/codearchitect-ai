"use client";

import { useEffect, type Dispatch } from "react";
import type { WorkspaceAction } from "@/hooks/useWorkspace";
import { FOCUS_SEARCH_EVENT } from "@/lib/ui";

type Options = {
  dispatch: Dispatch<WorkspaceAction>;
  /** The tour owns the keyboard while it is open. */
  tourOpen: boolean;
  /** Esc clears an active trace. */
  hasTrace: boolean;
  openTour: () => void;
};

/**
 * Global shortcuts: `/` or Ctrl/Cmd+K search, `F` focus mode, `?` tour, `Esc` clear a trace.
 * All except Ctrl/Cmd+K are ignored while typing in a field.
 */
export function useShortcuts({ dispatch, tourOpen, hasTrace, openTour }: Options) {
  useEffect(() => {
    if (tourOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping = Boolean(target && (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable));
      const focusSearch = () => window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        focusSearch();
        return;
      }
      if (isTyping || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key === "Escape" && hasTrace) {
        dispatch({ type: "setTrace", trace: null });
      } else if (event.key === "/") {
        event.preventDefault();
        focusSearch();
      } else if (event.key.toLowerCase() === "f") {
        dispatch({ type: "toggleFocus" });
      } else if (event.key === "?") {
        openTour();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [dispatch, tourOpen, hasTrace, openTour]);
}
