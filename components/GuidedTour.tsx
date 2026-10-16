"use client";

import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { TOUR_STEPS, type TourStep } from "@/lib/tour";

const SPOTLIGHT_PADDING_PX = 6;
const CARD_MAX_WIDTH_PX = 352;
const CARD_ESTIMATED_HEIGHT_PX = 210;
const VIEWPORT_MARGIN_PX = 12;
/** A target taller than this share of the viewport (the canvas) gets the card inside it instead of beside it. */
const LARGE_TARGET_SHARE = 0.6;
/** Re-measure shortly after a step changes: the drawer may still be switching tabs. */
const REMEASURE_DELAY_MS = 150;

type Rect = { top: number; left: number; width: number; height: number };

function measure(step: TourStep): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return null;
  return { top: r.top, left: r.left, width: r.width, height: r.height };
}

function placeCard(rect: Rect | null, vw: number, vh: number): { top: number; left: number } {
  const width = Math.min(CARD_MAX_WIDTH_PX, vw - 2 * VIEWPORT_MARGIN_PX);
  const clampLeft = (left: number) => Math.max(VIEWPORT_MARGIN_PX, Math.min(left, vw - width - VIEWPORT_MARGIN_PX));
  if (!rect) return { top: Math.max(VIEWPORT_MARGIN_PX, (vh - CARD_ESTIMATED_HEIGHT_PX) / 2), left: clampLeft((vw - width) / 2) };

  const centerX = rect.left + rect.width / 2;
  if (rect.height > vh * LARGE_TARGET_SHARE) {
    return { top: vh - CARD_ESTIMATED_HEIGHT_PX - 2 * VIEWPORT_MARGIN_PX, left: clampLeft(centerX - width / 2) };
  }
  const below = rect.top + rect.height + SPOTLIGHT_PADDING_PX + VIEWPORT_MARGIN_PX;
  if (below + CARD_ESTIMATED_HEIGHT_PX < vh) return { top: below, left: clampLeft(centerX - width / 2) };
  const above = rect.top - SPOTLIGHT_PADDING_PX - VIEWPORT_MARGIN_PX - CARD_ESTIMATED_HEIGHT_PX;
  if (above > 0) return { top: above, left: clampLeft(centerX - width / 2) };
  return { top: vh - CARD_ESTIMATED_HEIGHT_PX - 2 * VIEWPORT_MARGIN_PX, left: clampLeft(centerX - width / 2) };
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Called when a step needs a particular drawer tab open. */
  onEnterStep: (step: TourStep) => void;
};

export function GuidedTour({ open, onClose, onEnterStep }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const nextRef = useRef<HTMLButtonElement>(null);
  const returnFocusTo = useRef<Element | null>(null);
  const step = TOUR_STEPS[index]!;
  const isLast = index === TOUR_STEPS.length - 1;

  const update = useCallback(() => {
    setRect(measure(step));
    setViewport({ width: window.innerWidth, height: window.innerHeight });
  }, [step]);

  // Opening always starts from the first step and remembers where focus was.
  useEffect(() => {
    if (!open) return;
    setIndex(0);
    returnFocusTo.current = document.activeElement;
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    onEnterStep(step);
    update();
    const timer = setTimeout(update, REMEASURE_DELAY_MS);
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
    // `onEnterStep` is intentionally not a dependency: it only switches tabs and must run once per step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, step, update]);

  useEffect(() => {
    if (open) nextRef.current?.focus();
  }, [open, index]);

  const close = useCallback(() => {
    onClose();
    if (returnFocusTo.current instanceof HTMLElement) returnFocusTo.current.focus();
  }, [onClose]);

  const go = useCallback(
    (delta: number) => {
      const next = index + delta;
      if (next < 0) return;
      if (next >= TOUR_STEPS.length) close();
      else setIndex(next);
    },
    [index, close],
  );

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
      else if (event.key === "ArrowRight") go(1);
      else if (event.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, close, go]);

  if (!open) return null;

  const card = placeCard(rect, viewport.width || window.innerWidth, viewport.height || window.innerHeight);
  const cardWidth = Math.min(CARD_MAX_WIDTH_PX, (viewport.width || window.innerWidth) - 2 * VIEWPORT_MARGIN_PX);

  return (
    <div className="pointer-events-none fixed inset-0 z-50">
      {rect ? (
        <div
          aria-hidden="true"
          className="absolute rounded-xl ring-2 ring-violet-400 transition-all duration-200 motion-reduce:transition-none"
          style={{
            top: rect.top - SPOTLIGHT_PADDING_PX,
            left: rect.left - SPOTLIGHT_PADDING_PX,
            width: rect.width + 2 * SPOTLIGHT_PADDING_PX,
            height: rect.height + 2 * SPOTLIGHT_PADDING_PX,
            boxShadow: "0 0 0 9999px rgba(9, 9, 11, 0.62)",
          }}
        />
      ) : (
        <div aria-hidden="true" className="absolute inset-0 bg-zinc-950/60" />
      )}

      <div
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        className="pointer-events-auto absolute rounded-xl border border-zinc-700 bg-zinc-900/95 p-4 text-zinc-100 shadow-2xl shadow-black/60 backdrop-blur"
        style={{ top: card.top, left: card.left, width: cardWidth }}
      >
        <div className="mb-1 flex items-center justify-between gap-2">
          <span className="text-[11px] font-medium uppercase tracking-wider text-violet-300" aria-live="polite">
            Step {index + 1} of {TOUR_STEPS.length}
          </span>
          <button type="button" onClick={close} aria-label="Close the tour" className="rounded p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>
        <h2 id="tour-title" className="text-sm font-semibold">
          {step.title}
        </h2>
        <p id="tour-body" className="mt-1 text-xs leading-relaxed text-zinc-300">
          {step.body}
        </p>
        <div className="mt-3 flex items-center justify-between gap-2">
          <button type="button" onClick={close} className="text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline">
            {isLast ? "Close" : "Skip tour"}
          </button>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => go(-1)}
              disabled={index === 0}
              className="flex items-center gap-0.5 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
            >
              <ChevronLeft className="h-3.5 w-3.5" /> Back
            </button>
            <button ref={nextRef} type="button" onClick={() => go(1)} className="flex items-center gap-0.5 rounded-md bg-violet-600 px-3 py-1 text-xs font-medium text-white hover:bg-violet-500">
              {isLast ? "Done" : "Next"} {!isLast && <ChevronRight className="h-3.5 w-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
