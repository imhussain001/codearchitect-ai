import type { InspectorTab } from "@/hooks/useWorkspace";

export type TourStep = {
  id: string;
  /** Value of the `data-tour` attribute on the element to spotlight. */
  target: string;
  title: string;
  body: string;
  /** Inspector tab to open for this step so the target is visible. */
  tab?: InspectorTab;
};

export const TOUR_STORAGE_KEY = "codearchitect.tour.v1";

export const TOUR_STEPS: readonly TourStep[] = [
  {
    id: "map",
    target: "canvas",
    title: "Your codebase, as a map",
    body: "Each box is a component: a file, or a group of files with one job. An arrow from A to B means A uses B. Drag to move around and scroll to zoom.",
  },
  {
    id: "legend",
    target: "legend",
    title: "Colours and glows",
    body: "A box's border colour says what it is for: screen, API, logic or data. Later, a red or amber glow will show what a change would break.",
  },
  {
    id: "search",
    target: "search",
    title: "Find anything fast",
    body: "Type a name or file path and press Enter to jump straight to it. Press / to search from anywhere, or F to dim everything except the selected component and its neighbours.",
  },
  {
    id: "inspect",
    target: "inspector",
    title: "Click a box to understand it",
    body: "Selecting a component shows its code, what depends on it, and a plain-language summary of how much changing it would touch.",
    tab: "inspector",
  },
  {
    id: "simulate",
    target: "simulate",
    title: "Ask “what if?”",
    body: "Describe a change in your own words, like “change userId to a UUID”, then run the analysis. Components that would break glow red and the drawer lists the edits needed.",
    tab: "blast",
  },
  {
    id: "health",
    target: "tab-health",
    title: "Spot fragile areas",
    body: "Health scores every component's change-risk and finds circular dependencies, crossed layers and oversized files, with no AI needed.",
    tab: "health",
  },
  {
    id: "story",
    target: "story",
    title: "Replay the history",
    body: "Step through commits to watch the architecture grow. Paste any git log to build a timeline for your own project.",
  },
  {
    id: "builder",
    target: "tab-builder",
    title: "Design before you build",
    body: "Add a new component, drag a connection to what it needs, and generate the starter code plus the edits that wire it in.",
    tab: "builder",
  },
  {
    id: "help",
    target: "help",
    title: "That's the tour",
    body: "Open this tour again any time with the ? button, or press ? on the keyboard. To work on your own code, choose Custom Upload in the repository menu.",
  },
];

/** localStorage can throw (private mode, blocked storage); the tour must never depend on it. */
export function hasSeenTour(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(TOUR_STORAGE_KEY) === "done";
  } catch {
    return false;
  }
}

export function markTourSeen(storage: Pick<Storage, "setItem"> | null): void {
  try {
    storage?.setItem(TOUR_STORAGE_KEY, "done");
  } catch {
    // Not persisting just means the tour shows again next visit.
  }
}
