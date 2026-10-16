"use client";

import clsx from "clsx";
import { GitCommitHorizontal, History, Loader2, Pause, Play, SkipBack, SkipForward, Sparkles, Upload } from "lucide-react";
import { useState } from "react";
import type { AsyncStatus } from "@/hooks/useWorkspace";
import type { ArchitectureGraph, StoryNarrative } from "@/lib/types";

type Props = {
  graph: ArchitectureGraph;
  enabled: boolean;
  index: number;
  isPlaying: boolean;
  narrative: StoryNarrative | null;
  narrationStatus: AsyncStatus;
  onToggle: () => void;
  onIndexChange: (index: number) => void;
  onPlayingChange: (isPlaying: boolean) => void;
  onNarrate: () => void;
  onImportGitLog: (text: string) => void;
};

const GIT_LOG_HINT = "git log --name-status --date=short";

function GitLogImporter({ onImport, defaultOpen }: { onImport: (text: string) => void; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const [text, setText] = useState("");
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/40">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-zinc-300 hover:text-white">
        <Upload className="h-3.5 w-3.5" /> Import git history
      </button>
      {open && (
        <div className="space-y-2 border-t border-zinc-800 p-3">
          <p className="text-[11px] text-zinc-500">
            Paste the output of <code className="rounded bg-zinc-800 px-1 font-mono text-zinc-300">{GIT_LOG_HINT}</code>. Changed files are matched to components by path.
          </p>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            spellCheck={false}
            placeholder={"commit 4be771d…\nAuthor: …\nDate:   2026-03-19\n\n    feat(auth): stateless JWT sessions\n\nA\tsrc/server/auth/jwt.ts"}
            className="w-full rounded-md border border-zinc-700 bg-zinc-950 px-2 py-1.5 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-700 focus:border-violet-500 focus:outline-none"
          />
          <button
            type="button"
            disabled={!text.trim()}
            onClick={() => onImport(text)}
            className="rounded-md bg-violet-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-violet-500 disabled:opacity-50"
          >
            Build timeline
          </button>
        </div>
      )}
    </div>
  );
}

export function StoryPanel(props: Props) {
  const { graph, enabled, index, isPlaying, narrative, narrationStatus } = props;
  const commits = graph.commits;
  const label = (id: string) => graph.nodes.find((n) => n.id === id)?.data.label ?? id;
  const storyFor = (hash: string) => narrative?.phases.find((p) => p.hash === hash);

  if (commits.length === 0) {
    return (
      <div className="space-y-4">
        <div className="flex flex-col items-center gap-2 py-6 text-center text-zinc-500">
          <History className="h-8 w-8 text-zinc-600" />
          <p className="text-sm">No commit history for this repository yet.</p>
        </div>
        <GitLogImporter onImport={props.onImportGitLog} defaultOpen />
      </div>
    );
  }

  const last = commits.length - 1;
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-zinc-400">
            Time machine {enabled ? <span className="text-emerald-400">· on</span> : <span className="text-zinc-600">· off</span>}
          </span>
          <button type="button" onClick={props.onToggle} className="text-[11px] text-zinc-400 underline-offset-2 hover:text-zinc-100 hover:underline">
            {enabled ? "Show current state" : "Replay history on canvas"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous commit" disabled={index === 0} onClick={() => props.onIndexChange(index - 1)} className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <SkipBack className="h-4 w-4" />
          </button>
          <button
            type="button"
            aria-label={isPlaying ? "Pause" : "Play"}
            onClick={() => {
              if (!isPlaying && index === last) props.onIndexChange(0);
              props.onPlayingChange(!isPlaying);
            }}
            className="rounded-full bg-violet-600 p-2 text-white shadow-lg shadow-violet-900/40 hover:bg-violet-500"
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <button type="button" aria-label="Next commit" disabled={index === last} onClick={() => props.onIndexChange(index + 1)} className="rounded-md p-1.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40">
            <SkipForward className="h-4 w-4" />
          </button>
          <input
            type="range"
            min={0}
            max={last}
            value={index}
            onChange={(e) => props.onIndexChange(Number(e.target.value))}
            aria-label="Commit timeline"
            className="flex-1 accent-violet-500"
          />
          <span className="w-12 text-right font-mono text-[11px] text-zinc-500">
            {index + 1}/{commits.length}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <h3 className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">Architecture evolution</h3>
        <button
          type="button"
          onClick={props.onNarrate}
          disabled={narrationStatus === "running"}
          className="flex items-center gap-1 rounded-md border border-violet-500/40 bg-violet-500/10 px-2 py-1 text-[11px] font-medium text-violet-200 hover:bg-violet-500/20 disabled:opacity-50"
        >
          {narrationStatus === "running" ? <Loader2 className="h-3 w-3 animate-spin" /> : <Sparkles className="h-3 w-3" />}
          {narrative?.engine === "claude" ? "Re-narrate" : "Narrate with Claude"}
        </button>
      </div>
      {narrative && <p className="rounded-lg border border-violet-500/20 bg-violet-500/5 px-3 py-2 text-xs leading-relaxed text-violet-100/90">{narrative.overview}</p>}

      <ol className="relative space-y-1 border-l border-zinc-800 pl-4">
        {commits.map((commit, i) => {
          const story = storyFor(commit.hash);
          const isCurrent = enabled && i === index;
          const isFuture = enabled && i > index;
          return (
            <li key={commit.hash} className={clsx("relative transition-opacity", isFuture && "opacity-40")}>
              <span className={clsx("absolute -left-[22px] top-3 h-3 w-3 rounded-full border-2 border-zinc-950", isCurrent ? "bg-violet-400 ring-4 ring-violet-500/20" : "bg-zinc-600")} />
              <button
                type="button"
                onClick={() => props.onIndexChange(i)}
                className={clsx("w-full rounded-lg px-3 py-2 text-left transition", isCurrent ? "bg-violet-500/10 ring-1 ring-violet-500/30" : "hover:bg-zinc-800/40")}
              >
                <div className="flex items-center gap-2 text-[11px] text-zinc-500">
                  <GitCommitHorizontal className="h-3.5 w-3.5" />
                  <span className="font-mono text-zinc-400">{commit.hash}</span>
                  <span>{commit.date}</span>
                  <span className="truncate">· {commit.author}</span>
                </div>
                <div className="mt-0.5 text-sm font-semibold text-zinc-100">{story?.phase ?? commit.phase}</div>
                <div className="font-mono text-[11px] text-zinc-400">{commit.message}</div>
                {(isCurrent || !enabled) && <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">{story?.narrative ?? commit.narrative}</p>}
                {(commit.addedNodeIds.length > 0 || commit.modifiedNodeIds.length > 0) && (
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {commit.addedNodeIds.map((id) => (
                      <span key={`a-${id}`} className="rounded bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-300 ring-1 ring-inset ring-emerald-500/30">+ {label(id)}</span>
                    ))}
                    {commit.modifiedNodeIds.map((id) => (
                      <span key={`m-${id}`} className="rounded bg-sky-500/10 px-1.5 py-0.5 text-[10px] text-sky-300 ring-1 ring-inset ring-sky-500/30">~ {label(id)}</span>
                    ))}
                  </div>
                )}
              </button>
            </li>
          );
        })}
      </ol>

      <GitLogImporter onImport={props.onImportGitLog} defaultOpen={false} />
    </div>
  );
}
