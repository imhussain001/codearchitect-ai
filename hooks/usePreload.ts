"use client";

import { useEffect } from "react";
import { PRELOAD_STAMP_KEY, shouldApplyPreload, type PreloadPayload } from "@/lib/preload";

/** The stamp is per tab (sessionStorage) and best-effort: if storage is blocked, the preload simply applies on each load. */
function readStamp(): string | null {
  try {
    return window.sessionStorage.getItem(PRELOAD_STAMP_KEY);
  } catch {
    return null;
  }
}

function writeStamp(stamp: string): void {
  try {
    window.sessionStorage.setItem(PRELOAD_STAMP_KEY, stamp);
  } catch {
    /* not required */
  }
}

/**
 * When the app was launched by `codearchitect view`, load that folder's graph once per launch.
 * `onPreload` returns normally to mark the preload as applied.
 */
export function usePreload(onPreload: (payload: PreloadPayload) => void, onError: (message: string) => void): void {
  useEffect(() => {
    let cancelled = false;
    fetch("/api/preload")
      .then(async (response) => {
        if (response.status === 204 || cancelled) return;
        const body = (await response.json()) as PreloadPayload & { error?: string };
        if (!response.ok) throw new Error(body.error ?? `HTTP ${response.status}`);
        if (!shouldApplyPreload(body, readStamp())) return;
        writeStamp(body.stamp);
        onPreload(body);
      })
      .catch((error) => !cancelled && onError(`Could not load the folder passed to the view command: ${error instanceof Error ? error.message : String(error)}`));
    return () => {
      cancelled = true;
    };
    // Runs once at startup; the callbacks are stable by construction in the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
