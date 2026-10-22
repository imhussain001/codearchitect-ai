import { GraphSchema } from "@/lib/graphSchema";
import type { ArchitectureGraph } from "@/lib/types";

/**
 * A graph handed to the app by `codearchitect view`. The CLI writes it to a file and the
 * server exposes it at /api/preload. `stamp` changes on every launch, so a reload in the
 * same tab does not throw away the user's edits, but a fresh launch always shows fresh code.
 */
export type PreloadPayload = { stamp: string; graph: ArchitectureGraph };

export const PRELOAD_ENV = "CODEARCHITECT_PRELOAD_FILE";
export const PRELOAD_STAMP_KEY = "codearchitect.preload.stamp";

export function parsePreload(text: string): PreloadPayload {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error("The preload file is not valid JSON.");
  }
  const { stamp, graph } = (json ?? {}) as { stamp?: unknown; graph?: unknown };
  if (typeof stamp !== "string" || stamp === "") throw new Error("The preload file has no stamp.");
  const parsed = GraphSchema.safeParse(graph);
  if (!parsed.success) throw new Error(`The preload graph is invalid: ${parsed.error.issues[0]?.path.join(".") || "root"}.`);
  return { stamp, graph: parsed.data as ArchitectureGraph };
}

/** Apply a preload unless this browser tab already applied this exact launch. */
export const shouldApplyPreload = (payload: PreloadPayload, lastAppliedStamp: string | null): boolean => payload.stamp !== lastAppliedStamp;
