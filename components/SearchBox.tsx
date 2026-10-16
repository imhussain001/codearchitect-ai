"use client";

import clsx from "clsx";
import { Focus, Search, X } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { searchNodes, type SearchField } from "@/lib/search";
import type { ArchNode } from "@/lib/types";
import { KIND_META } from "@/lib/ui";

/** Dispatched on `window` by the global keyboard shortcuts to focus the box. */
export const FOCUS_SEARCH_EVENT = "codearchitect:focus-search";

const MATCH_LABEL: Record<SearchField, string> = { name: "name", path: "path", export: "export", keyword: "keyword", description: "description" };

type Props = {
  nodes: ArchNode[];
  onSelect: (nodeId: string) => void;
  focusEnabled: boolean;
  hasSelection: boolean;
  onToggleFocus: () => void;
};

export function SearchBox({ nodes, onSelect, focusEnabled, hasSelection, onToggleFocus }: Props) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const labelOf = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const hits = useMemo(() => searchNodes(nodes, query), [nodes, query]);

  useEffect(() => {
    const focusInput = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
      setOpen(true);
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, focusInput);
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focusInput);
  }, []);

  const choose = (nodeId: string) => {
    onSelect(nodeId);
    setOpen(false);
    inputRef.current?.blur();
  };

  const showList = open && query.trim().length > 0;
  const activeId = hits[active] ? `${listId}-opt-${hits[active]!.nodeId}` : undefined;

  return (
    <div data-tour="search" className="flex w-[min(22rem,100%)] items-start gap-1.5">
      <div className="relative min-w-0 flex-1">
        <div className="flex items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-950/90 px-2.5 backdrop-blur focus-within:border-violet-500 focus-within:ring-2 focus-within:ring-violet-500/30">
          <Search className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
              setOpen(true);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((i) => Math.min(i + 1, Math.max(0, hits.length - 1)));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter" && hits[active]) {
                e.preventDefault();
                choose(hits[active]!.nodeId);
              } else if (e.key === "Escape") {
                if (query) setQuery("");
                else inputRef.current?.blur();
                setOpen(false);
              }
            }}
            placeholder="Search components…"
            aria-label="Search components"
            role="combobox"
            aria-expanded={showList}
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={showList ? activeId : undefined}
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1.5 text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          {query ? (
            <button type="button" aria-label="Clear search" onClick={() => { setQuery(""); inputRef.current?.focus(); }} className="rounded p-0.5 text-zinc-500 hover:text-zinc-200">
              <X className="h-3.5 w-3.5" />
            </button>
          ) : (
            <kbd className="hidden rounded border border-zinc-700 px-1 font-mono text-[10px] text-zinc-500 sm:block" title="Press / or Ctrl+K to search">/</kbd>
          )}
        </div>

        {showList && (
          <ul id={listId} role="listbox" aria-label="Matching components" className="absolute left-0 right-0 top-full z-20 mt-1 max-h-72 overflow-y-auto rounded-lg border border-zinc-700 bg-zinc-950/95 py-1 shadow-xl backdrop-blur">
            {hits.length === 0 ? (
              <li role="presentation" className="px-3 py-2 text-xs text-zinc-500">
                No component matches “{query.trim()}”. Try part of a file name or a word from its description.
              </li>
            ) : (
              hits.map((hit, i) => {
                const node = labelOf.get(hit.nodeId)!;
                return (
                  <li
                    key={hit.nodeId}
                    id={`${listId}-opt-${hit.nodeId}`}
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(hit.nodeId)}
                    onMouseEnter={() => setActive(i)}
                    className={clsx("flex cursor-pointer items-center gap-2 px-3 py-1.5", i === active && "bg-zinc-800/80")}
                  >
                    <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: KIND_META[node.data.kind].hex }} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-medium text-zinc-100">{node.data.label}</span>
                      <span className="block truncate font-mono text-[10px] text-zinc-500">{node.data.filePath}</span>
                    </span>
                    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">{MATCH_LABEL[hit.matchedOn]}</span>
                  </li>
                );
              })
            )}
          </ul>
        )}
      </div>

      <button
        type="button"
        onClick={onToggleFocus}
        aria-pressed={focusEnabled}
        title="Focus mode (F): dim everything except the selected component and what it directly connects to"
        className={clsx(
          "flex shrink-0 items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium backdrop-blur transition",
          focusEnabled ? "border-violet-500/60 bg-violet-500/20 text-violet-100" : "border-zinc-700 bg-zinc-950/90 text-zinc-300 hover:border-zinc-500",
        )}
      >
        <Focus className="h-3.5 w-3.5" /> Focus
      </button>
      {focusEnabled && !hasSelection && <span className="self-center text-[11px] text-violet-300">Click a component</span>}
    </div>
  );
}
