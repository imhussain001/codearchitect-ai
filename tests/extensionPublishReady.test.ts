import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What `vsce publish` and the Visual Studio Marketplace need, checked ahead of time so a publish
 * does not fail (or ship a broken listing) after you have already logged in.
 */
const manifest = JSON.parse(readFileSync("extensions/vscode/package.json", "utf8")) as Record<string, unknown> & {
  publisher: string;
  name: string;
  version: string;
  displayName: string;
  description: string;
  icon: string;
  categories: string[];
  repository: { url: string };
};
const readme = readFileSync("extensions/vscode/README.md", "utf8");
const MARKETPLACE_CATEGORIES = ["Programming Languages", "Snippets", "Linters", "Themes", "Debuggers", "Formatters", "Keymaps", "SCM Providers", "Other", "Extension Packs", "Language Packs", "Data Science", "Machine Learning", "Visualization", "Notebooks", "Education", "Testing", "AI", "Chat"];

describe("Marketplace manifest", () => {
  it("has the identity fields the Marketplace requires, in the right shape", () => {
    expect(manifest.publisher).toMatch(/^[A-Za-z0-9][A-Za-z0-9-]*$/); // a Marketplace publisher ID
    expect(manifest.name).toMatch(/^[a-z0-9][a-z0-9-]*$/); // lower-case, no spaces
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(manifest.displayName.length).toBeGreaterThan(0);
    expect(manifest.description.length).toBeGreaterThan(20);
  });

  it("uses only categories the Marketplace knows", () => {
    expect(manifest.categories.length).toBeGreaterThan(0);
    for (const c of manifest.categories) expect(MARKETPLACE_CATEGORIES, c).toContain(c);
  });

  it("is not marked private, which would stop it from being published", () => {
    expect(manifest.private).toBeUndefined();
  });

  it("links to the project and says who owns it", () => {
    expect(manifest.repository.url).toContain("github.com/imhussain001/codearchitect-ai");
    expect(String(manifest.homepage)).toContain("github.com/imhussain001/codearchitect-ai");
    expect((manifest.bugs as { url: string }).url).toContain("/issues");
    expect(manifest.license).toBe("Apache-2.0");
  });
});

describe("Marketplace listing assets", () => {
  it("has a PNG icon of at least 128 x 128 (SVG is not allowed)", () => {
    expect(manifest.icon).toMatch(/\.png$/);
    const path = `extensions/vscode/${manifest.icon}`;
    expect(existsSync(path)).toBe(true);
    const png = readFileSync(path);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(png.readUInt32BE(16)).toBeGreaterThanOrEqual(128); // width
    expect(png.readUInt32BE(20)).toBeGreaterThanOrEqual(128); // height
    expect(png.readUInt32BE(16)).toBe(png.readUInt32BE(20)); // square
  });

  it("ships a README, a CHANGELOG and the license files", () => {
    for (const f of ["README.md", "CHANGELOG.md", "LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"]) expect(existsSync(`extensions/vscode/${f}`), f).toBe(true);
  });

  it("keeps the README valid for the Marketplace: no relative links or images, no SVG images", () => {
    const links = [...readme.matchAll(/!?\[[^\]]*\]\(([^)\s]+)[^)]*\)/g)].map((m) => m[1]!);
    for (const link of links) {
      if (link.startsWith("#")) continue; // in-page anchors are fine
      expect(link, `${link} must be absolute`).toMatch(/^https:\/\//);
    }
    expect(readme).not.toMatch(/!\[[^\]]*\]\([^)]*\.svg/i);
  });

  it("lists the changelog entry for the version being published", () => {
    expect(readFileSync("extensions/vscode/CHANGELOG.md", "utf8")).toContain(`## ${manifest.version}`);
  });
});

describe("publish scripts and guide", () => {
  const scripts = (JSON.parse(readFileSync("package.json", "utf8")) as { scripts: Record<string, string> }).scripts;

  it("checks everything before it publishes", () => {
    expect(scripts["ext:publish"]).toContain("ext:check");
    expect(scripts["ext:publish"]).toContain("vsce publish");
    expect(scripts["ext:check"]).toContain("extensionPublishReady");
  });

  it("has a guide that covers the steps only the owner can do", () => {
    const guide = readFileSync("docs/publishing-the-extension.md", "utf8");
    for (const part of ["marketplace.visualstudio.com/manage", "Personal Access Token", "Marketplace", "Manage", "vsce login", "ext:publish", manifest.publisher]) expect(guide, part).toContain(part);
  });
});
