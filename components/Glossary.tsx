import { BookOpen } from "lucide-react";
import { GLOSSARY } from "@/lib/explain";

/** Collapsible plain-language definitions of the app's vocabulary. */
export function Glossary({ className }: { className?: string }) {
  return (
    <details className={`rounded-lg border border-zinc-800 bg-zinc-900/30 text-xs text-zinc-400 ${className ?? ""}`}>
      <summary className="flex cursor-pointer items-center gap-1.5 px-3 py-2 text-zinc-300">
        <BookOpen className="h-3.5 w-3.5" /> What do these words mean?
      </summary>
      <dl className="space-y-2 border-t border-zinc-800 px-3 py-2">
        {GLOSSARY.map(({ term, meaning }) => (
          <div key={term}>
            <dt className="font-medium text-zinc-200">{term}</dt>
            <dd className="leading-relaxed">{meaning}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
