import { describe, expect, it } from "vitest";
import { diffLines } from "@/lib/diff";

describe("diffLines", () => {
  it("returns only `same` rows for identical input", () => {
    const { rows, stats } = diffLines("a\nb", "a\nb");
    expect(rows.map((r) => r.type)).toEqual(["same", "same"]);
    expect(stats).toEqual({ added: 0, removed: 0 });
  });

  it("pairs a replaced line into a single `changed` row with aligned line numbers", () => {
    const { rows, stats } = diffLines("a\nb\nc", "a\nB\nc");
    expect(rows[1]).toEqual({ type: "changed", left: { lineNo: 2, text: "b" }, right: { lineNo: 2, text: "B" } });
    expect(stats).toEqual({ added: 1, removed: 1 });
  });

  it("emits unpaired additions when the new side is longer", () => {
    const { rows } = diffLines("a", "a\nx\ny");
    expect(rows.slice(1).map((r) => [r.type, r.right?.lineNo])).toEqual([
      ["added", 2],
      ["added", 3],
    ]);
  });

  it("normalises CRLF so Windows line endings do not produce spurious changes", () => {
    expect(diffLines("a\r\nb", "a\nb").stats).toEqual({ added: 0, removed: 0 });
  });
});
