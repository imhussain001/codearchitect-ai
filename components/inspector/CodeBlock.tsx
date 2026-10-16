"use client";

import { Check, Copy } from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";

const TOKEN =
  /(\/\/.*$|#.*$)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(import|from|export|default|const|let|var|async|await|function|return|if|else|type|new|throw|for|of|in|class|interface|extends|try|catch|finally|def|self|None|True|False|null|undefined|true|false)\b|\b(\d+(?:\.\d+)?)\b/g;

/** Lightweight lexical highlighting: comments, strings, keywords, numbers. Rendered as React nodes (no innerHTML). */
export function highlightLine(line: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(TOKEN)) {
    const index = match.index ?? 0;
    if (index > last) out.push(line.slice(last, index));
    const [text, comment, string, keyword] = match;
    const className = comment ? "text-zinc-500 italic" : string ? "text-emerald-300" : keyword ? "text-violet-300" : "text-amber-300";
    out.push(
      <span key={index} className={className}>
        {text}
      </span>,
    );
    last = index + text.length;
  }
  if (last < line.length) out.push(line.slice(last));
  return out;
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          setCopied(false);
        }
      }}
      className="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-zinc-400 transition hover:bg-zinc-800 hover:text-zinc-100"
    >
      {copied ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
      {copied ? "Copied" : label}
    </button>
  );
}

export function CodeBlock({ code, title }: { code: string; title?: string }) {
  const lines = code.split("\n");
  return (
    <div className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-950/80">
      <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
        <span className="truncate font-mono text-[11px] text-zinc-400">{title}</span>
        <CopyButton text={code} />
      </div>
      <pre className="scrollbar-thin max-h-[420px] overflow-auto py-2 font-mono text-[12px] leading-5">
        <code className="grid grid-cols-[auto_1fr]">
          {lines.map((line, i) => (
            <Fragment key={i}>
              <span className="select-none pl-3 pr-3 text-right text-zinc-600">{i + 1}</span>
              <span className="whitespace-pre pr-4 text-zinc-200">{highlightLine(line)}</span>
            </Fragment>
          ))}
        </code>
      </pre>
    </div>
  );
}
