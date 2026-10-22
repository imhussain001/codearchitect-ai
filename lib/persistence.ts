import type { ArchitectureGraph } from "@/lib/types";

/**
 * Local autosave. The store is an interface so the logic here is testable with an in-memory
 * store, while the browser uses IndexedDB (graphs with code can be several MB, too big for
 * localStorage). Nothing is sent anywhere: it lives in this browser only.
 */

export type SavedWorkspace = {
  id: string;
  name: string;
  savedAt: number;
  /** The graph as the user left it. */
  graph: ArchitectureGraph;
  /** The graph as first loaded, so "Reset" can return to it. Null for samples (they ship with the app). */
  original: ArchitectureGraph | null;
};

export interface WorkspaceStore {
  get(id: string): Promise<SavedWorkspace | null>;
  put(record: SavedWorkspace): Promise<void>;
  delete(id: string): Promise<void>;
  getLastId(): Promise<string | null>;
  setLastId(id: string | null): Promise<void>;
}

export function createMemoryStore(): WorkspaceStore {
  const records = new Map<string, SavedWorkspace>();
  let lastId: string | null = null;
  return {
    get: async (id) => records.get(id) ?? null,
    put: async (record) => void records.set(record.id, structuredClone(record)),
    delete: async (id) => void records.delete(id),
    getLastId: async () => lastId,
    setLastId: async (id) => void (lastId = id),
  };
}

const DB_NAME = "codearchitect";
const DB_VERSION = 1;
const RECORDS = "workspaces";
const META = "meta";
const LAST_KEY = "lastId";

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

/** Browser store. Rejects (so callers can fall back) when IndexedDB is missing or blocked, e.g. in some private windows. */
export function createIndexedDbStore(): WorkspaceStore {
  let opened: Promise<IDBDatabase> | null = null;
  const open = () =>
    (opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") return reject(new Error("IndexedDB is not available in this browser."));
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(RECORDS, { keyPath: "id" });
        req.result.createObjectStore(META);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("Could not open IndexedDB."));
      req.onblocked = () => reject(new Error("IndexedDB is blocked by another tab."));
    }));
  const store = async (name: string, mode: IDBTransactionMode) => (await open()).transaction(name, mode).objectStore(name);

  return {
    get: async (id) => ((await request((await store(RECORDS, "readonly")).get(id))) as SavedWorkspace | undefined) ?? null,
    put: async (record) => void (await request((await store(RECORDS, "readwrite")).put(record))),
    delete: async (id) => void (await request((await store(RECORDS, "readwrite")).delete(id))),
    getLastId: async () => ((await request((await store(META, "readonly")).get(LAST_KEY))) as string | undefined) ?? null,
    setLastId: async (id) => void (id === null ? await request((await store(META, "readwrite")).delete(LAST_KEY)) : await request((await store(META, "readwrite")).put(id, LAST_KEY))),
  };
}

/* ---------- Change detection ---------- */

/** 32-bit FNV-1a: enough to tell "edited" from "not edited"; not for security. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
}

/** Stable summary of everything a user can change: layout, code, drafts, links, rules and commits. */
export function fingerprint(graph: ArchitectureGraph): string {
  const parts = [
    graph.id,
    ...graph.nodes.map((n) => `${n.id}|${Math.round(n.position.x)}|${Math.round(n.position.y)}|${n.data.isDraft ? 1 : 0}|${fnv1a(n.data.code)}`),
    "--",
    ...graph.edges.map((e) => `${e.id}|${e.source}|${e.target}|${e.relation}|${e.isDraft ? 1 : 0}`),
    "--",
    JSON.stringify(graph.rules ?? []),
    JSON.stringify(graph.commits.map((c) => c.hash)),
  ];
  return fnv1a(parts.join("\n"));
}

export const isDirty = (graph: ArchitectureGraph, original: ArchitectureGraph): boolean => fingerprint(graph) !== fingerprint(original);

/* ---------- Save / restore ---------- */

export type SaveOutcome = "saved" | "clean";

/**
 * Persist `graph`. A built-in sample is only kept once it differs from its shipped copy
 * (`original`); an unchanged sample is removed so a reload shows the shipped version. An
 * imported graph has no shipped copy, so it is always kept, with `original` stored for Reset.
 */
export async function saveWorkspace(
  store: WorkspaceStore,
  graph: ArchitectureGraph,
  source: { builtIn: boolean; original: ArchitectureGraph },
  now: number = Date.now(),
): Promise<SaveOutcome> {
  if (source.builtIn && !isDirty(graph, source.original)) {
    await store.delete(graph.id);
    await store.setLastId(graph.id);
    return "clean";
  }
  await store.put({ id: graph.id, name: graph.name, savedAt: now, graph, original: source.builtIn ? null : source.original });
  await store.setLastId(graph.id);
  return "saved";
}

/** The workspace the user was last in, or null. */
export async function restoreLast(store: WorkspaceStore): Promise<SavedWorkspace | null> {
  const id = await store.getLastId();
  return id ? store.get(id) : null;
}
