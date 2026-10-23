import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Runs the real `activate()` against a small fake of the VS Code API. It cannot prove the
 * extension looks right in the editor, but it does prove the wiring: commands are registered,
 * the workspace is read and mapped, and the status bar, CodeLens and quick picks show what the
 * core computed.
 */

const files: Record<string, string> = {
  "src/auth.ts": `export function verifyToken(t: string) { return !!t; }\nexport function issueToken() { return "x"; }\n`,
  "src/session.ts": `import { verifyToken } from "./auth";\nexport const session = () => verifyToken("a");\n`,
  "src/login.ts": `import { issueToken } from "./auth";\nexport const login = () => issueToken();\n`,
};

type Handler = (...args: unknown[]) => unknown;
const state = {
  commands: new Map<string, Handler>(),
  lens: null as null | { provideCodeLenses(doc: unknown): Array<{ range: { start: { line: number } }; command: { title: string; command: string; arguments: unknown[] } }> },
  status: { text: "", tooltip: undefined as unknown, command: undefined as unknown, shown: false },
  activeEditor: undefined as unknown,
  pickedItems: [] as Array<{ label: string; ref?: { path: string } }>,
  pickChoice: undefined as unknown,
  messages: [] as string[],
  written: new Map<string, string>(),
  opened: [] as string[],
};

vi.mock("vscode", () => {
  class Uri {
    constructor(public fsPath: string, public scheme = "file") {}
    static file = (p: string) => new Uri(p);
    static joinPath = (base: Uri, ...parts: string[]) => new Uri([base.fsPath, ...parts].join("/"));
  }
  class Range {
    start: { line: number };
    constructor(sl: number, _sc: number, _el: number, _ec: number) {
      this.start = { line: sl };
    }
  }
  class CodeLens {
    constructor(public range: Range, public command: { title: string; command: string; arguments: unknown[] }) {}
  }
  class EventEmitter {
    event = () => ({ dispose() {} });
    fire() {}
    dispose() {}
  }
  class MarkdownString {
    value = "";
    appendMarkdown(t: string) {
      this.value += t;
      return this;
    }
  }
  const disposable = { dispose() {} };
  return {
    Uri,
    Range,
    CodeLens,
    EventEmitter,
    MarkdownString,
    ThemeColor: class {
      constructor(public id: string) {}
    },
    RelativePattern: class {
      constructor(public base: unknown, public pattern: string) {}
    },
    StatusBarAlignment: { Left: 1 },
    QuickPickItemKind: { Separator: -1 },
    window: {
      createOutputChannel: () => ({ appendLine() {}, dispose() {} }),
      createStatusBarItem: () => ({
        set text(v: string) {
          state.status.text = v;
        },
        get text() {
          return state.status.text;
        },
        set tooltip(v: unknown) {
          state.status.tooltip = v;
        },
        set command(v: unknown) {
          state.status.command = v;
        },
        set backgroundColor(_v: unknown) {},
        show: () => void (state.status.shown = true),
        hide: () => void (state.status.shown = false),
        dispose() {},
      }),
      get activeTextEditor() {
        return state.activeEditor;
      },
      onDidChangeActiveTextEditor: () => disposable,
      showInformationMessage: async (m: string) => void state.messages.push(m),
      showWarningMessage: async (m: string) => void state.messages.push(m),
      showQuickPick: async (items: Array<{ label: string; ref?: { path: string } }>) => {
        state.pickedItems = items;
        return state.pickChoice;
      },
      showTextDocument: async (uri: { fsPath: string }) => void state.opened.push(uri.fsPath),
    },
    workspace: {
      workspaceFolders: [{ name: "demo", uri: new Uri("/ws") }],
      asRelativePath: (uri: { fsPath: string }) => uri.fsPath.replace(/^\/ws\//, ""),
      getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
      findFiles: async () => Object.keys(files).map((p) => new Uri(`/ws/${p}`)),
      fs: {
        readFile: async (uri: { fsPath: string }) => new TextEncoder().encode(files[uri.fsPath.replace(/^\/ws\//, "")] ?? ""),
        writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => void state.written.set(uri.fsPath, new TextDecoder().decode(bytes)),
      },
      onDidSaveTextDocument: () => disposable,
      onDidChangeConfiguration: () => disposable,
      createFileSystemWatcher: () => ({ onDidCreate: () => disposable, onDidDelete: () => disposable, dispose() {} }),
    },
    commands: {
      registerCommand: (id: string, fn: Handler) => {
        state.commands.set(id, fn);
        return disposable;
      },
    },
    languages: {
      registerCodeLensProvider: (_sel: unknown, provider: typeof state.lens) => {
        state.lens = provider;
        return disposable;
      },
    },
    env: { openExternal: async () => true },
  };
});

const editorFor = (rel: string) => ({ document: { uri: { fsPath: `/ws/${rel}`, scheme: "file" }, lineCount: 10, getText: () => "", getWordRangeAtPosition: () => undefined, languageId: "typescript" }, selection: { active: {} } });
const settle = () => new Promise((r) => setTimeout(r, 50));

async function start() {
  state.commands.clear();
  state.messages = [];
  state.activeEditor = editorFor("src/auth.ts");
  const { activate } = await import("../extensions/vscode/src/extension");
  activate({ subscriptions: [] } as never);
  await settle();
}

describe("extension activation", () => {
  beforeEach(() => {
    state.written.clear();
    state.opened = [];
    state.pickChoice = undefined;
  });

  it("registers its commands and the CodeLens provider", async () => {
    await start();
    expect([...state.commands.keys()].sort()).toEqual(["codearchitect.exportShare", "codearchitect.refresh", "codearchitect.showBlastRadius", "codearchitect.showUsers"]);
    expect(state.lens).not.toBeNull();
  });

  it("shows how many files a change to the active file affects", async () => {
    await start();
    // Re-evaluate for the active editor after the map exists.
    await (state.commands.get("codearchitect.refresh") as Handler)();
    await settle();
    expect(state.status.shown).toBe(true);
    expect(state.status.text).toContain("2 files affected");
    expect(state.status.command).toBe("codearchitect.showBlastRadius");
  });

  it("puts a 'used by' CodeLens on each export", async () => {
    await start();
    await settle();
    const lenses = state.lens!.provideCodeLenses(state.activeEditor && (state.activeEditor as { document: unknown }).document);
    const titles = Object.fromEntries(lenses.map((l) => [l.command.arguments[1] as string, l.command.title]));
    expect(titles["verifyToken"]).toBe("used by 1 file");
    expect(titles["issueToken"]).toBe("used by 1 file");
    expect(lenses[0]!.command.command).toBe("codearchitect.showUsers");
  });

  it("lists dependents in a quick pick and opens the one chosen", async () => {
    await start();
    await settle();
    state.pickChoice = { label: "Session", ref: { path: "src/session.ts" } };
    await (state.commands.get("codearchitect.showBlastRadius") as Handler)();
    const refs = state.pickedItems.filter((i) => i.ref).map((i) => i.ref!.path).sort();
    expect(refs).toEqual(["src/login.ts", "src/session.ts"]);
    expect(state.opened).toEqual(["/ws/src/session.ts"]);
  });

  it("narrows to one symbol and lists the importer that does not use it as spared", async () => {
    await start();
    await settle();
    await (state.commands.get("codearchitect.showUsers") as Handler)("src/auth.ts", "verifyToken");
    const labels = state.pickedItems.map((i) => i.label);
    expect(state.pickedItems.filter((i) => i.ref).map((i) => i.ref!.path)).toEqual(["src/session.ts", "src/login.ts"]);
    expect(labels.some((l) => l.startsWith("Import the file but do not use it"))).toBe(true);
  });

  it("writes a self-contained architecture page into the workspace", async () => {
    await start();
    await settle();
    await (state.commands.get("codearchitect.exportShare") as Handler)();
    const html = state.written.get("/ws/demo-architecture.html");
    expect(html).toBeTruthy();
    expect(html!.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("verifyToken");
  });

  it("says so, rather than failing, for a file that is not mapped", async () => {
    await start();
    await settle();
    state.activeEditor = editorFor("README.md");
    await (state.commands.get("codearchitect.showBlastRadius") as Handler)();
    expect(state.messages.at(-1)).toContain("not part of the mapped architecture");
  });
});
