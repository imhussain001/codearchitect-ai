import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * The layout is CSS, which a unit test cannot render, and there is no browser test suite. This
 * guards the specific choices that keep the app usable on a phone (checked by hand in a
 * 375px browser): if one is removed, the test says what it was for.
 */
const read = (path: string) => readFileSync(path, "utf8");

describe("phone-width layout", () => {
  const nav = read("components/TopNav.tsx");
  const canvas = read("components/ArchitectureCanvas.tsx");
  const page = read("app/page.tsx");

  it("shortens the header on a phone: no subtitle, short button labels, no save text", () => {
    expect(nav).toContain('className="hidden text-[10px] text-zinc-500 sm:block"'); // subtitle
    expect(nav).toContain('<span className="sm:hidden">Simulate</span>');
    expect(nav).toContain('<span className="sm:hidden">Story</span>');
    expect(nav).toContain('<span className="hidden sm:inline">Simulate Blast Radius</span>');
    expect(nav).toContain('<span className="hidden sm:inline">Toggle Time-Machine Story</span>');
    expect(nav).toMatch(/saveStatus === "saving" && <span className="hidden sm:inline">/);
  });

  it("keeps the diagram clear on a phone: no minimap, one scrolling legend row, no status legend", () => {
    expect(canvas).toContain("!hidden"); // minimap
    expect(canvas).toContain("sm:!block");
    expect(canvas).toContain("overflow-x-auto whitespace-nowrap"); // kind legend scrolls instead of wrapping
    expect(canvas).toMatch(/hidden flex-wrap[^"]*sm:flex/); // status legend only from tablet width up
  });

  it("gives the inspector room on a phone by shrinking the canvas", () => {
    expect(page).toContain("h-[45vh]");
    expect(page).toContain("sm:h-[55vh]");
  });

  it("keeps the tour legend target present at every width", () => {
    expect(canvas).toContain('data-tour="legend"');
  });
});
