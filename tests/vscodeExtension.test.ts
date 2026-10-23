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
  lensSelector: null as unknown,
  lens: null as null | { provideCodeLenses(doc: unknown): Array<{ range: { start: { line: number } }; command: { title: string; command: string; arguments: unknown[] } }> },
  status: { text: "", tooltip: undefined as unknown, command: undefined as unknown, shown: false },
  activeEditor: undefined as unknown,
  pickedItems: [] as Array<{ label: string; ref?: { path: string } }>,
  pickChoice: undefined as unknown,
  messages: [] as string[],
  written: new Map<string, string>(),
  panel: null as null | {
    html: string;
    title: string;
    posted: Array<{ type: string; path?: string }>;
    options: unknown;
    onMessage: ((m: unknown) => unknown) | null;
  },
  editorChanged: null as null | (() => void),
  config: {} as Record<string, unknown>,
  folders: [] as Array<{ name: string; uri: { fsPath: string; scheme: string; toString(): string } }>,
  allFiles: {} as Record<string, string>,
  findCalls: [] as string[],
  saved: null as null | ((d: unknown) => void),
  foldersChanged: null as null | (() => void),
  fileCreated: null as null | ((u: unknown) => void),
  fileDeleted: null as null | ((u: unknown) => void),
  configChanged: null as null | ((e: { affectsConfiguration: (s: string) => boolean }) => void),
  opened: [] as string[],
};

vi.mock("vscode", () => {
  class Uri {
    constructor(public fsPath: string, public scheme = "file") {}
    toString() {
      return this.fsPath;
    }
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
    ViewColumn: { Beside: -2 },
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
      onDidChangeActiveTextEditor: (cb: () => void) => {
        state.editorChanged = cb;
        return disposable;
      },
      createWebviewPanel: (_id: string, title: string, _column: unknown, options: unknown) => {
        const record = { html: "", title, posted: [] as Array<{ type: string; path?: string }>, options, onMessage: null as null | ((m: unknown) => unknown) };
        state.panel = record;
        return {
          set title(v: string) {
            record.title = v;
          },
          get title() {
            return record.title;
          },
          webview: {
            set html(v: string) {
              record.html = v;
            },
            get html() {
              return record.html;
            },
            postMessage: async (m: { type: string; path?: string }) => void record.posted.push(m),
            onDidReceiveMessage: (cb: (m: unknown) => unknown) => {
              record.onMessage = cb;
              return disposable;
            },
          },
          onDidDispose: () => disposable,
          reveal() {},
          dispose() {},
        };
      },
      showInformationMessage: async (m: string) => void state.messages.push(m),
      showWarningMessage: async (m: string) => void state.messages.push(m),
      showQuickPick: async (items: Array<{ label: string; ref?: { path: string } }>) => {
        state.pickedItems = items;
        return state.pickChoice;
      },
      showTextDocument: async (uri: { fsPath: string }) => void state.opened.push(uri.fsPath),
    },
    workspace: {
      get workspaceFolders() {
        return state.folders;
      },
      asRelativePath: (uri: { fsPath: string }) => {
        const folder = state.folders.find((f) => uri.fsPath.startsWith(`${f.uri.fsPath}/`));
        return folder ? uri.fsPath.slice(folder.uri.fsPath.length + 1) : uri.fsPath;
      },
      getWorkspaceFolder: (uri: { fsPath: string }) => state.folders.find((f) => uri.fsPath.startsWith(`${f.uri.fsPath}/`)),
      getConfiguration: () => ({ get: (k: string, d: unknown) => (k in state.config ? state.config[k] : d) }),
      findFiles: async (pattern: { base: { uri: { fsPath: string } } }) => {
        const root = pattern.base.uri.fsPath;
        state.findCalls.push(root);
        return Object.keys(state.allFiles).filter((p) => p.startsWith(`${root}/`)).map((p) => new Uri(p));
      },
      fs: {
        readFile: async (uri: { fsPath: string }) => new TextEncoder().encode(state.allFiles[uri.fsPath] ?? ""),
        writeFile: async (uri: { fsPath: string }, bytes: Uint8Array) => void state.written.set(uri.fsPath, new TextDecoder().decode(bytes)),
      },
      onDidSaveTextDocument: (cb: (d: unknown) => void) => {
        state.saved = cb;
        return disposable;
      },
      onDidChangeWorkspaceFolders: (cb: () => void) => {
        state.foldersChanged = cb;
        return disposable;
      },
      onDidChangeConfiguration: (cb: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
        state.configChanged = cb;
        return disposable;
      },
      createFileSystemWatcher: () => ({
        onDidCreate: (cb: (u: unknown) => void) => ((state.fileCreated = cb), disposable),
        onDidDelete: (cb: (u: unknown) => void) => ((state.fileDeleted = cb), disposable),
        dispose() {},
      }),
    },
    commands: {
      registerCommand: (id: string, fn: Handler) => {
        state.commands.set(id, fn);
        return disposable;
      },
    },
    languages: {
      registerCodeLensProvider: (sel: unknown, provider: typeof state.lens) => {
        state.lensSelector = sel;
        state.lens = provider;
        return disposable;
      },
    },
    env: { openExternal: async () => true },
  };
});

const editorFor = (rel: string, root = "/ws") => ({ document: { uri: { fsPath: `${root}/${rel}`, scheme: "file", toString: () => `${root}/${rel}` }, lineCount: 10, getText: () => "", getWordRangeAtPosition: () => undefined, languageId: "typescript" }, selection: { active: {} } });
const folder = (name: string, root: string) => ({ name, uri: { fsPath: root, scheme: "file", toString: () => root } });
const underRoot = (root: string, map: Record<string, string>) => Object.fromEntries(Object.entries(map).map(([p, c]) => [`${root}/${p}`, c]));
const settle = () => new Promise((r) => setTimeout(r, 50));

let previousSubscriptions: Array<{ dispose?: () => void }> = [];

async function start(setup: { folders?: ReturnType<typeof folder>[]; allFiles?: Record<string, string> } = {}) {
  state.commands.clear();
  state.messages = [];
  state.panel = null;
  state.config = {};
  state.folders = setup.folders ?? [folder("demo", "/ws")];
  state.allFiles = setup.allFiles ?? underRoot("/ws", files);
  state.findCalls = [];
  state.activeEditor = editorFor("src/auth.ts");
  const { activate } = await import("../extensions/vscode/src/extension");
  for (const d of previousSubscriptions) d.dispose?.();
  const context = { subscriptions: [] as Array<{ dispose?: () => void }> };
  previousSubscriptions = context.subscriptions;
  activate(context as never);
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
    expect([...state.commands.keys()].sort()).toEqual(["codearchitect.exportShare", "codearchitect.refresh", "codearchitect.showBlastRadius", "codearchitect.showGraph", "codearchitect.showUsers"]);
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

describe("map panel", () => {
  const run = (id: string) => (state.commands.get(id) as Handler)();

  it("opens a scripts-enabled webview that contains the map", async () => {
    await start();
    await settle();
    await run("codearchitect.showGraph");
    expect(state.panel).not.toBeNull();
    expect((state.panel!.options as { enableScripts: boolean }).enableScripts).toBe(true);
    expect(state.panel!.html.startsWith("<!doctype html>")).toBe(true);
    expect(state.panel!.html).toContain('data-id="src-auth"');
  });

  it("tells the map which file is open when it reports ready, and when the editor changes", async () => {
    await start();
    await settle();
    await run("codearchitect.showGraph");
    await state.panel!.onMessage!({ type: "ready" });
    expect(state.panel!.posted).toEqual([{ type: "focus", path: "src/auth.ts" }]);

    state.activeEditor = editorFor("src/login.ts");
    state.editorChanged!();
    expect(state.panel!.posted.at(-1)).toEqual({ type: "focus", path: "src/login.ts" });

    state.activeEditor = editorFor("README.md"); // not part of the map: nothing to focus
    const before = state.panel!.posted.length;
    state.editorChanged!();
    expect(state.panel!.posted).toHaveLength(before);
  });

  it("opens a mapped file when the page asks, and ignores anything else", async () => {
    await start();
    await settle();
    await run("codearchitect.showGraph");
    state.opened = [];
    await state.panel!.onMessage!({ type: "open", path: "src/session.ts" });
    expect(state.opened).toEqual(["/ws/src/session.ts"]);
    await state.panel!.onMessage!({ type: "open", path: "../../etc/passwd" });
    await state.panel!.onMessage!({ type: "open", path: 42 });
    await state.panel!.onMessage!({ type: "something-else" });
    expect(state.opened).toEqual(["/ws/src/session.ts"]);
  });

  it("re-renders the page when the map is rebuilt", async () => {
    await start();
    await settle();
    await run("codearchitect.showGraph");
    state.panel!.html = "stale";
    await run("codearchitect.refresh");
    await settle();
    expect(state.panel!.html.startsWith("<!doctype html>")).toBe(true);
  });
});

describe("status bar click option", () => {
  const refresh = async () => {
    await (state.commands.get("codearchitect.refresh") as Handler)();
    await settle();
  };

  it("opens the list by default", async () => {
    await start();
    await refresh();
    expect(state.status.command).toBe("codearchitect.showBlastRadius");
    expect(JSON.stringify(state.status.tooltip)).toContain("Click for the list");
  });

  it("opens the map when the setting says so, and switches without a re-map", async () => {
    await start();
    await refresh();
    state.config = { statusBarClick: "map" };
    state.configChanged!({ affectsConfiguration: (s) => s === "codearchitect" });
    expect(state.status.command).toBe("codearchitect.showGraph");
    expect(JSON.stringify(state.status.tooltip)).toContain("Click for the architecture map");

    state.config = { statusBarClick: "list" };
    state.configChanged!({ affectsConfiguration: (s) => s === "codearchitect" });
    expect(state.status.command).toBe("codearchitect.showBlastRadius");
  });

  it("treats an unknown value as the default", async () => {
    await start();
    await refresh();
    state.config = { statusBarClick: "banana" };
    state.configChanged!({ affectsConfiguration: () => true });
    expect(state.status.command).toBe("codearchitect.showBlastRadius");
  });
});

describe("CodeLens languages", () => {
  it("covers Python along with the other mapped languages", async () => {
    await start();
    const languages = (state.lensSelector as Array<{ language: string }>).map((s) => s.language);
    expect(languages).toEqual(expect.arrayContaining(["typescript", "javascript", "go", "java", "rust", "python"]));
  });
});

describe("multi-root workspaces", () => {
  // Two folders that both have src/auth.ts: in /ws it has 2 dependents, in /ws2 it has 3.
  const ws2Files = {
    "src/auth.ts": `export function verifyToken(t: string) { return !!t; }\n`,
    "src/api.ts": `import { verifyToken } from "./auth";\nexport const api = () => verifyToken("a");\n`,
    "src/cli.ts": `import { verifyToken } from "./auth";\nexport const cli = () => verifyToken("b");\n`,
    "src/admin.ts": `import { verifyToken } from "./auth";\nexport const admin = () => verifyToken("c");\n`,
  };
  const twoFolders = () => ({ folders: [folder("demo", "/ws"), folder("demo2", "/ws2")], allFiles: { ...underRoot("/ws", files), ...underRoot("/ws2", ws2Files) } });
  const run = (id: string, ...args: unknown[]) => (state.commands.get(id) as (...a: unknown[]) => unknown)(...args);
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it("answers from the folder the file belongs to, even when two folders share a relative path", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();

    state.activeEditor = editorFor("src/auth.ts", "/ws2");
    state.editorChanged!();
    expect(state.status.text).toContain("3 files affected");
    expect(JSON.stringify(state.status.tooltip)).toContain("demo2");
    expect(JSON.stringify(state.status.tooltip)).toContain("links between folders are not followed");

    state.activeEditor = editorFor("src/auth.ts", "/ws");
    state.editorChanged!();
    expect(state.status.text).toContain("2 files affected");
  });

  it("opens the chosen file in its own folder", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    state.activeEditor = editorFor("src/auth.ts", "/ws2");
    state.pickChoice = { label: "Api", ref: { path: "src/api.ts" } };
    state.opened = [];
    await run("codearchitect.showBlastRadius");
    expect(state.pickedItems.filter((i) => i.ref).map((i) => i.ref!.path).sort()).toEqual(["src/admin.ts", "src/api.ts", "src/cli.ts"]);
    expect(state.opened).toEqual(["/ws2/src/api.ts"]);
  });

  it("gives CodeLens from the document's own folder and tells the command which folder", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    const doc = (editorFor("src/auth.ts", "/ws2") as { document: unknown }).document;
    const lenses = state.lens!.provideCodeLenses(doc);
    expect(lenses[0]!.command.title).toBe("used by 3 files");
    expect(lenses[0]!.command.arguments).toEqual(["src/auth.ts", "verifyToken", "/ws2"]);
  });

  it("uses the folder it is told about, not the active editor's", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    state.activeEditor = editorFor("src/auth.ts", "/ws"); // active file is in the other folder
    state.pickChoice = { label: "Cli", ref: { path: "src/cli.ts" } };
    state.opened = [];
    await run("codearchitect.showUsers", "src/auth.ts", "verifyToken", "/ws2");
    expect(state.pickedItems.filter((i) => i.ref).map((i) => i.ref!.path).sort()).toEqual(["src/admin.ts", "src/api.ts", "src/cli.ts"]);
    expect(state.opened).toEqual(["/ws2/src/cli.ts"]);
  });

  it("switches the map to the folder of the file you open", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    await run("codearchitect.showGraph");
    expect(state.panel!.html).toContain('data-id="src-login"'); // folder /ws
    expect(state.panel!.html).not.toContain('data-id="src-admin"');
    expect(state.panel!.title).toBe("CodeArchitect map: demo");

    state.activeEditor = editorFor("src/auth.ts", "/ws2");
    state.editorChanged!();
    expect(state.panel!.html).toContain('data-id="src-admin"'); // folder /ws2
    expect(state.panel!.html).not.toContain('data-id="src-login"');
    expect(state.panel!.title).toBe("CodeArchitect map: demo2");

    await state.panel!.onMessage!({ type: "ready" });
    expect(state.panel!.posted.at(-1)).toEqual({ type: "focus", path: "src/auth.ts" });
    state.opened = [];
    await state.panel!.onMessage!({ type: "open", path: "src/admin.ts" });
    expect(state.opened).toEqual(["/ws2/src/admin.ts"]);
    await state.panel!.onMessage!({ type: "open", path: "src/session.ts" }); // exists only in the other folder
    expect(state.opened).toEqual(["/ws2/src/admin.ts"]);
  });

  it("re-maps only the folder where a file was saved", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    state.findCalls = [];
    state.saved!({ uri: (editorFor("src/api.ts", "/ws2") as { document: { uri: unknown } }).document.uri, languageId: "typescript" });
    await wait(1100);
    expect(state.findCalls).toEqual(["/ws2"]);
  });

  it("forgets a folder that is closed", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    state.activeEditor = editorFor("src/auth.ts", "/ws2");
    state.editorChanged!();
    expect(state.status.shown).toBe(true);

    state.folders = [folder("demo", "/ws")];
    state.foldersChanged!();
    await wait(1100);
    state.editorChanged!();
    expect(state.status.shown).toBe(false);
  });

  it("exports the active file's folder, and asks which folder when none is open", async () => {
    await start(twoFolders());
    await run("codearchitect.refresh");
    await settle();
    state.activeEditor = editorFor("src/auth.ts", "/ws2");
    await run("codearchitect.exportShare");
    expect(state.written.has("/ws2/demo2-architecture.html")).toBe(true);
    expect(state.written.get("/ws2/demo2-architecture.html")).toContain("data-id=\"src-admin\"");

    state.written.clear();
    state.activeEditor = undefined;
    state.pickChoice = { label: "demo", description: "/ws", key: "/ws" };
    await run("codearchitect.exportShare");
    expect([...state.written.keys()]).toEqual(["/ws/demo-architecture.html"]);
  });

  it("keeps single-folder behaviour: no folder name in the tooltip, no multi-root note", async () => {
    await start();
    await run("codearchitect.refresh");
    await settle();
    expect(JSON.stringify(state.status.tooltip)).not.toContain("links between folders");
    expect(JSON.stringify(state.status.tooltip)).not.toContain("demo");
  });
});
