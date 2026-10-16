import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { hasSeenTour, markTourSeen, TOUR_STEPS, TOUR_STORAGE_KEY } from "@/lib/tour";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : /\.tsx$/.test(name) ? [path] : [];
  });
}

describe("TOUR_STEPS", () => {
  it("has unique ids and non-empty copy", () => {
    expect(new Set(TOUR_STEPS.map((s) => s.id)).size).toBe(TOUR_STEPS.length);
    for (const step of TOUR_STEPS) {
      expect(step.title.length).toBeGreaterThan(3);
      expect(step.body.length).toBeGreaterThan(30);
    }
  });

  it("only targets elements that exist in the UI source", () => {
    const source = [...sourceFiles("components"), ...sourceFiles("app")].map((f) => readFileSync(f, "utf8")).join("\n");
    const tabIds = [...source.matchAll(/\{ id: "(\w+)", label: "[^"]+", hint:/g)].map((m) => m[1]);
    for (const { target } of TOUR_STEPS) {
      const isTab = target.startsWith("tab-") && tabIds.includes(target.slice(4));
      const literal = source.includes(`data-tour="${target}"`) || source.includes(`tour="${target}"`);
      expect(isTab || literal, `no element is tagged data-tour="${target}"`).toBe(true);
    }
  });
});

describe("tour persistence", () => {
  const memory = () => {
    const data = new Map<string, string>();
    return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v) };
  };

  it("remembers a finished tour", () => {
    const storage = memory();
    expect(hasSeenTour(storage)).toBe(false);
    markTourSeen(storage);
    expect(storage.getItem(TOUR_STORAGE_KEY)).toBe("done");
    expect(hasSeenTour(storage)).toBe(true);
  });

  it("never throws when storage is unavailable", () => {
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(hasSeenTour(broken)).toBe(false);
    expect(() => markTourSeen(broken)).not.toThrow();
    expect(hasSeenTour(null)).toBe(false);
    expect(() => markTourSeen(null)).not.toThrow();
  });
});
