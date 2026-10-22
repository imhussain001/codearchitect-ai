import { describe, expect, it } from "vitest";
import { createMemoryStore, fingerprint, isDirty, restoreLast, saveWorkspace } from "@/lib/persistence";
import { workspaceReducer, type WorkspaceState } from "@/hooks/useWorkspace";
import { authMicroservice } from "@/lib/mockData";
import type { ArchitectureGraph } from "@/lib/types";

const moved = (g: ArchitectureGraph): ArchitectureGraph => ({ ...g, nodes: g.nodes.map((n, i) => (i === 0 ? { ...n, position: { x: n.position.x + 40, y: n.position.y } } : n)) });
const recoded = (g: ArchitectureGraph): ArchitectureGraph => ({ ...g, nodes: g.nodes.map((n, i) => (i === 0 ? { ...n, data: { ...n.data, code: `${n.data.code}\n// edit` } } : n)) });

describe("fingerprint / isDirty", () => {
  it("is stable for an unchanged graph and for a structural copy", () => {
    expect(fingerprint(authMicroservice)).toBe(fingerprint(structuredClone(authMicroservice)));
    expect(isDirty(structuredClone(authMicroservice), authMicroservice)).toBe(false);
  });

  it("notices moved nodes, edited code, drafts and rule changes", () => {
    expect(isDirty(moved(authMicroservice), authMicroservice)).toBe(true);
    expect(isDirty(recoded(authMicroservice), authMicroservice)).toBe(true);
    expect(isDirty({ ...authMicroservice, rules: [{ id: "r", type: "no-cycles", severity: "warn" } as never] }, authMicroservice)).toBe(true);
    const draft = { ...authMicroservice.nodes[0]!, id: "draft-x", data: { ...authMicroservice.nodes[0]!.data, isDraft: true } };
    expect(isDirty({ ...authMicroservice, nodes: [...authMicroservice.nodes, draft] }, authMicroservice)).toBe(true);
  });

  it("ignores sub-pixel layout noise", () => {
    const jitter = { ...authMicroservice, nodes: authMicroservice.nodes.map((n) => ({ ...n, position: { x: n.position.x + 0.2, y: n.position.y - 0.2 } })) };
    expect(isDirty(jitter, authMicroservice)).toBe(false);
  });
});

describe("saveWorkspace / restoreLast", () => {
  it("does not keep an unchanged sample, but remembers it as the last workspace", async () => {
    const store = createMemoryStore();
    expect(await saveWorkspace(store, authMicroservice, { builtIn: true, original: authMicroservice })).toBe("clean");
    expect(await store.get(authMicroservice.id)).toBeNull();
    expect(await store.getLastId()).toBe(authMicroservice.id);
    expect(await restoreLast(store)).toBeNull();
  });

  it("keeps an edited sample and restores it", async () => {
    const store = createMemoryStore();
    const edited = recoded(authMicroservice);
    expect(await saveWorkspace(store, edited, { builtIn: true, original: authMicroservice }, 123)).toBe("saved");
    const restored = (await restoreLast(store))!;
    expect(restored.savedAt).toBe(123);
    expect(restored.original).toBeNull();
    expect(isDirty(restored.graph, edited)).toBe(false);
  });

  it("always keeps an imported graph, with its original for Reset", async () => {
    const store = createMemoryStore();
    const imported = { ...authMicroservice, id: "imported-1", name: "Mine" };
    expect(await saveWorkspace(store, imported, { builtIn: false, original: imported })).toBe("saved");
    const restored = (await restoreLast(store))!;
    expect(restored.name).toBe("Mine");
    expect(restored.original?.id).toBe("imported-1");
  });

  it("drops the saved copy once an edited sample is back to its original", async () => {
    const store = createMemoryStore();
    await saveWorkspace(store, recoded(authMicroservice), { builtIn: true, original: authMicroservice });
    await saveWorkspace(store, authMicroservice, { builtIn: true, original: authMicroservice });
    expect(await store.get(authMicroservice.id)).toBeNull();
  });

  it("stores a copy, so later mutation of the live graph cannot alter the record", async () => {
    const store = createMemoryStore();
    const live = structuredClone(recoded(authMicroservice));
    await saveWorkspace(store, live, { builtIn: true, original: authMicroservice });
    live.nodes[0]!.data.code = "changed after save";
    expect((await store.get(live.id))!.graph.nodes[0]!.data.code).not.toBe("changed after save");
  });
});

describe("restoring through the reducer", () => {
  it("loadGraph resets selection and overlays but keeps the restored edits", async () => {
    const store = createMemoryStore();
    const edited = moved(authMicroservice);
    await saveWorkspace(store, edited, { builtIn: true, original: authMicroservice });
    const restored = (await restoreLast(store))!;
    const state = workspaceReducer({ graph: authMicroservice, selectedNodeId: "x" } as unknown as WorkspaceState, { type: "loadGraph", graph: restored.graph });
    expect(state.selectedNodeId).toBeNull();
    expect(state.graph.nodes[0]!.position.x).toBe(edited.nodes[0]!.position.x);
  });
});
