"use client";

import clsx from "clsx";
import { FileArchive, GitBranch, Loader2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { clampMaxFiles, MAX_GRAPH_FILES, MAX_MAPPABLE_FILES, MIN_MAPPED_FILES } from "@/lib/engines/heuristicGraph";

type Props = {
  open: boolean;
  isBusy: boolean;
  error: string | null;
  onClose: () => void;
  onUploadFile: (file: File, maxFiles: number) => void;
  onGithubUrl: (url: string, maxFiles: number) => void;
};

export function ImportDialog({ open, isBusy, error, onClose, onUploadFile, onGithubUrl }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [url, setUrl] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [maxFiles, setMaxFiles] = useState(MAX_GRAPH_FILES);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      onCancel={(e) => {
        e.preventDefault();
        if (!isBusy) onClose();
      }}
      className="m-auto w-[min(520px,calc(100vw-2rem))] rounded-2xl border border-zinc-800 bg-zinc-950/95 p-0 text-zinc-100 shadow-2xl shadow-black/60 backdrop:bg-black/60 backdrop:backdrop-blur-sm"
    >
      <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3">
        <h2 className="text-sm font-semibold">Map a codebase</h2>
        <button type="button" aria-label="Close" disabled={isBusy} onClick={onClose} className="rounded-md p-1 text-zinc-500 hover:bg-zinc-800 hover:text-zinc-100">
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="space-y-4 p-5">
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragging(true);
          }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            const file = e.dataTransfer.files[0];
            if (file && !isBusy) onUploadFile(file, clampMaxFiles(maxFiles));
          }}
          className={clsx(
            "flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed px-4 py-8 text-center transition",
            isDragging ? "border-violet-500 bg-violet-500/10" : "border-zinc-700 hover:border-zinc-500",
            isBusy && "pointer-events-none opacity-50",
          )}
        >
          <FileArchive className="h-8 w-8 text-zinc-500" />
          <span className="text-sm text-zinc-300">Drop a repository .zip or a CodeArchitect .json export</span>
          <span className="text-[11px] text-zinc-500">Parsed in your browser · up to 50 MB · node_modules/build output ignored</span>
          <input
            type="file"
            accept=".zip,.json"
            className="sr-only"
            disabled={isBusy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUploadFile(file, clampMaxFiles(maxFiles));
              e.target.value = "";
            }}
          />
        </label>

        <div className="flex items-center gap-3 text-[11px] uppercase tracking-wider text-zinc-600">
          <span className="h-px flex-1 bg-zinc-800" /> or <span className="h-px flex-1 bg-zinc-800" />
        </div>

        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (url.trim() && !isBusy) onGithubUrl(url.trim(), clampMaxFiles(maxFiles));
          }}
        >
          <div className="flex flex-1 items-center gap-2 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 focus-within:border-violet-500">
            <GitBranch className="h-4 w-4 shrink-0 text-zinc-500" />
            <input
              type="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://github.com/owner/repo"
              disabled={isBusy}
              className="w-full bg-transparent py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
            />
          </div>
          <button type="submit" disabled={isBusy || !url.trim()} className="rounded-lg bg-violet-600 px-3 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-50">
            Analyze
          </button>
        </form>

        <div className="space-y-1">
          <label className="flex items-center justify-between gap-3 text-xs text-zinc-400">
            Map up to
            <span className="flex items-center gap-2">
              <input
                type="number"
                min={MIN_MAPPED_FILES}
                max={MAX_MAPPABLE_FILES}
                step={50}
                value={maxFiles}
                onChange={(e) => setMaxFiles(Number(e.target.value))}
                onBlur={() => setMaxFiles(clampMaxFiles(maxFiles))}
                disabled={isBusy}
                className="w-20 rounded-md border border-zinc-700 bg-zinc-900 px-2 py-1 text-right text-zinc-100 focus:border-violet-500 focus:outline-none"
              />
              files
            </span>
          </label>
          <p className="text-[11px] leading-snug text-zinc-600">The most relevant files are kept. A bigger map takes longer to draw ({MAX_MAPPABLE_FILES.toLocaleString()} at most). With an AI model configured, grouping into components uses at most 60 files.</p>
        </div>

        {isBusy && (
          <p className="flex items-center gap-2 text-xs text-zinc-400">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Mapping components and dependencies…
          </p>
        )}
        {error && <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">{error}</p>}
      </div>
    </dialog>
  );
}
