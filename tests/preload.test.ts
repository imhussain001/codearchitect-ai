import { describe, expect, it } from "vitest";
import { parsePreload, shouldApplyPreload } from "@/lib/preload";
import { authMicroservice } from "@/lib/mockData";

const payload = (stamp = "t1") => JSON.stringify({ stamp, graph: authMicroservice });

describe("parsePreload", () => {
  it("accepts a stamped graph", () => {
    const parsed = parsePreload(payload());
    expect(parsed.stamp).toBe("t1");
    expect(parsed.graph.nodes).toHaveLength(authMicroservice.nodes.length);
  });

  it.each([
    ["not json", "{oops", /not valid JSON/],
    ["no stamp", JSON.stringify({ graph: authMicroservice }), /no stamp/],
    ["a bad graph", JSON.stringify({ stamp: "x", graph: { nodes: 1 } }), /invalid/],
  ])("rejects %s with a readable message", (_label, text, message) => {
    expect(() => parsePreload(text)).toThrow(message);
  });
});

describe("shouldApplyPreload", () => {
  it("applies a new launch once, then leaves the tab's edits alone on reload", () => {
    const p = parsePreload(payload("t1"));
    expect(shouldApplyPreload(p, null)).toBe(true);
    expect(shouldApplyPreload(p, "t1")).toBe(false);
    expect(shouldApplyPreload(parsePreload(payload("t2")), "t1")).toBe(true);
  });
});
