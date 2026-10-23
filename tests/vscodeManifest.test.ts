import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync("extensions/vscode/package.json", "utf8")) as {
  engines: { vscode: string };
  contributes: {
    commands: Array<{ command: string; title: string; icon?: string }>;
    menus: Record<string, Array<{ command: string; when?: string; group?: string }>>;
    configuration: { properties: Record<string, { type: string; default: unknown; enum?: string[]; description: string }> };
  };
};
const source = readFileSync("extensions/vscode/src/extension.ts", "utf8");

describe("extension manifest", () => {
  const declared = manifest.contributes.commands.map((c) => c.command);

  it("declares every command the code registers, and registers every command it declares", () => {
    const registered = [...source.matchAll(/registerCommand\("([^"]+)"/g)].map((m) => m[1]!);
    expect(registered.sort()).toEqual([...declared].sort());
  });

  it("gives every command a 'CodeArchitect:' title", () => {
    for (const c of manifest.contributes.commands) expect(c.title).toMatch(/^CodeArchitect: /);
  });

  it("offers the map in the editor title bar only when the setting is on", () => {
    const [item] = manifest.contributes.menus["editor/title"]!;
    expect(item!.command).toBe("codearchitect.showGraph");
    expect(item!.when).toContain("config.codearchitect.showTitleBarButton");
    expect(manifest.contributes.commands.find((c) => c.command === "codearchitect.showGraph")!.icon).toBeTruthy();
    expect(manifest.contributes.configuration.properties["codearchitect.showTitleBarButton"]!.default).toBe(false);
  });

  it("makes the status-bar click a choice between the list and the map, defaulting to today's behaviour", () => {
    const p = manifest.contributes.configuration.properties["codearchitect.statusBarClick"]!;
    expect(p.enum).toEqual(["list", "map"]);
    expect(p.default).toBe("list");
  });

  it("documents every setting the code reads", () => {
    const read = [...source.matchAll(/config\.get<[^>]+>\("([^"]+)"/g)].map((m) => `codearchitect.${m[1]}`);
    for (const key of read) expect(Object.keys(manifest.contributes.configuration.properties), key).toContain(key);
  });

  it("keeps the minimum VS Code version in step with the pinned API types", () => {
    expect(manifest.engines.vscode).toBe("^1.85.0");
    const types = JSON.parse(readFileSync("package.json", "utf8")).devDependencies["@types/vscode"] as string;
    expect(types.replace(/^[^\d]*/, "").startsWith("1.85")).toBe(true);
  });
});
