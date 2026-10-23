import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderShareHtml } from "@/lib/share";
import { authMicroservice } from "@/lib/mockData";

const read = (path: string) => readFileSync(path, "utf8");
const json = (path: string) => JSON.parse(read(path)) as Record<string, unknown>;

/**
 * Ownership and license are part of the deliverable, so they are checked like code: if someone
 * edits the license text, drops the author, or lets the packaged extension drift from the root
 * files, one of these says so.
 */
describe("license", () => {
  const license = read("LICENSE");

  it("is the unmodified Apache License, Version 2.0", () => {
    expect(license.trim().startsWith("Apache License")).toBe(true);
    expect(license).toContain("Version 2.0, January 2004");
    expect(license).toContain("TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION");
    expect(license.trim().endsWith("limitations under the License.")).toBe(true);
    // The canonical file is 11,358 bytes; a different size means the text was changed.
    expect(Buffer.byteLength(license)).toBe(11_358);
  });

  it("is declared the same way everywhere", () => {
    expect(json("package.json").license).toBe("Apache-2.0");
    expect(json("extensions/vscode/package.json").license).toBe("Apache-2.0");
  });

  it("ships with the extension, identical to the root files", () => {
    expect(read("extensions/vscode/LICENSE")).toBe(license);
    expect(read("extensions/vscode/NOTICE")).toBe(read("NOTICE"));
  });
});

describe("ownership", () => {
  it("names the owner in NOTICE, AUTHORS and both package manifests", () => {
    expect(read("NOTICE")).toContain("Copyright 2026 Hussain Tak");
    expect(read("NOTICE")).toContain("https://github.com/imhussain001");
    expect(read("AUTHORS.md")).toContain("Hussain Tak");
    for (const manifest of [json("package.json"), json("extensions/vscode/package.json")]) {
      expect(manifest.author).toEqual({ name: "Hussain Tak", url: "https://github.com/imhussain001" });
    }
  });

  it("is stated in both READMEs", () => {
    for (const file of ["README.md", "extensions/vscode/README.md"]) {
      const text = read(file);
      expect(text, file).toContain("License and ownership");
      expect(text, file).toContain("Hussain Tak");
      expect(text, file).toContain("Apache");
    }
  });

  it("is carried by the app, the CLI and the pages it generates", () => {
    expect(read("app/layout.tsx")).toContain('creator: "Hussain Tak"');
    expect(read("scripts/cli/main.ts")).toContain("Copyright 2026 Hussain Tak");
    const page = renderShareHtml(authMicroservice);
    expect(page).toContain("Made with CodeArchitect AI");
    expect(page).toContain("Hussain Tak");
    expect(page).toContain('<meta name="author" content="Hussain Tak">');
  });
});

describe("third-party notices", () => {
  it("list every direct production dependency, so a new one cannot be added unnoticed", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    const dependencies = Object.keys((json("package.json").dependencies ?? {}) as Record<string, string>);
    expect(dependencies.length).toBeGreaterThan(0);
    for (const name of dependencies) expect(notices, `${name} missing: run \`npm run notices\``).toContain(`| ${name} |`);
  });

  it("explain the dual-licensed and data packages, and credit the owner", () => {
    const notices = read("THIRD_PARTY_NOTICES.md");
    expect(notices).toContain("MIT OR GPL-3.0-or-later");
    expect(notices).toContain("Copyright 2026 Hussain Tak");
  });

  it("describe what the extension bundle contains", () => {
    expect(read("extensions/vscode/THIRD_PARTY_NOTICES.md")).toContain("Copyright 2026 Hussain Tak");
  });
});
