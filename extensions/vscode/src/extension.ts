import * as vscode from "vscode";
import { renderShareHtml } from "@/lib/share";
import { ArchIndex, type FileRef, type WorkspaceFile } from "./core";

/**
 * Thin VS Code adapter over `core.ts`: it reads each workspace folder, keeps one `ArchIndex` per
 * folder fresh, and shows what it knows in the status bar, as CodeLens and in quick picks. All the
 * analysis is in the core (unit-tested without an editor).
 *
 * Folders are mapped separately: a path means "relative to its own folder", and two folders can
 * hold a `src/auth.ts` each without clashing. Dependencies *between* folders are not followed.
 */

const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact", "go", "java", "rust", "python"];
const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,go,java,rs,py,m}";
const EXCLUDE_GLOB = "**/{node_modules,dist,build,out,.next,.git,target,vendor,venv,.venv,__pycache__,coverage}/**";
const MAX_FILE_BYTES = 200 * 1024;
const READ_BUDGET_FACTOR = 2; // read up to this many times maxFiles, then let the mapper choose the most relevant
const REBUILD_DEBOUNCE_MS = 800;

type Settings = { maxFiles: number; codeLens: boolean; statusBarClick: "list" | "map" };

const readSettings = (): Settings => {
  const config = vscode.workspace.getConfiguration("codearchitect");
  return {
    maxFiles: Math.max(20, config.get<number>("maxFiles", 800)),
    codeLens: config.get<boolean>("codeLens", true),
    statusBarClick: config.get<string>("statusBarClick", "list") === "map" ? "map" : "list",
  };
};

/** Path of a file relative to the workspace folder that contains it. */
const relPath = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false).split("\\").join("/");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const keyOf = (folder: vscode.WorkspaceFolder) => folder.uri.toString();

/** One mapped workspace folder. */
type Mapped = { folder: vscode.WorkspaceFolder; key: string; index: ArchIndex };

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("CodeArchitect");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  const lensChanged = new vscode.EventEmitter<void>();
  const mapped = new Map<string, Mapped>();
  const building = new Set<string>();
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  /** Folders waiting for the debounced rebuild; `"all"` when something affects every folder. */
  let pending: Set<string> | "all" = new Set();
  let panel: vscode.WebviewPanel | undefined;
  let panelKey: string | undefined;
  context.subscriptions.push(log, status, lensChanged, { dispose: () => panel?.dispose() });

  const folders = () => vscode.workspace.workspaceFolders ?? [];
  const isMultiRoot = () => folders().length > 1;
  const ctxFor = (uri: vscode.Uri): Mapped | undefined => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    return folder ? mapped.get(keyOf(folder)) : undefined;
  };

  /* ---------- Indexing ---------- */

  async function readFolder(folder: vscode.WorkspaceFolder, maxFiles: number): Promise<WorkspaceFile[]> {
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, SOURCE_GLOB), EXCLUDE_GLOB, maxFiles * READ_BUDGET_FACTOR);
    const decoder = new TextDecoder("utf-8");
    const files: WorkspaceFile[] = [];
    await Promise.all(
      uris.map(async (uri) => {
        try {
          const bytes = await vscode.workspace.fs.readFile(uri);
          if (bytes.byteLength <= MAX_FILE_BYTES) files.push({ path: relPath(uri), content: decoder.decode(bytes) });
        } catch (error) {
          log.appendLine(`skipped ${uri.fsPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }),
    );
    return files;
  }

  async function mapFolder(folder: vscode.WorkspaceFolder): Promise<void> {
    const key = keyOf(folder);
    if (building.has(key)) return;
    building.add(key);
    const started = Date.now();
    try {
      const { maxFiles } = readSettings();
      const files = await readFolder(folder, maxFiles);
      const index = ArchIndex.build(folder.name, files, maxFiles);
      mapped.set(key, { folder, key, index });
      log.appendLine(`${folder.name}: mapped ${index.graph.nodes.length} files (${index.skipped} over the limit) in ${Date.now() - started} ms`);
    } catch (error) {
      log.appendLine(`${folder.name}: mapping failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      void vscode.window.showWarningMessage(`CodeArchitect could not map ${isMultiRoot() ? `the folder ${folder.name}` : "this workspace"}. See the CodeArchitect output channel.`);
    } finally {
      building.delete(key);
    }
  }

  /** Re-map the given folders (all by default), and forget folders that are no longer open. */
  async function rebuild(only?: readonly vscode.WorkspaceFolder[]): Promise<void> {
    const open = folders();
    for (const key of [...mapped.keys()]) if (!open.some((f) => keyOf(f) === key)) mapped.delete(key);
    const targets = only ?? open;
    if (targets.length === 0) {
      status.hide();
      lensChanged.fire();
      return;
    }

    status.text = "$(sync~spin) CodeArchitect: mapping…";
    status.show();
    await Promise.all(targets.map(mapFolder));
    lensChanged.fire();
    updateStatus();
    renderPanel();
  }

  const scheduleRebuild = (folder?: vscode.WorkspaceFolder) => {
    if (!folder || pending === "all") pending = "all";
    else pending.add(keyOf(folder));
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => {
      const due = pending;
      pending = new Set();
      void rebuild(due === "all" ? undefined : folders().filter((f) => due.has(keyOf(f))));
    }, REBUILD_DEBOUNCE_MS);
  };

  /* ---------- Active file ---------- */

  const activeFile = (): { uri: vscode.Uri; rel: string; ctx: Mapped | undefined } | null => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return null;
    return { uri: editor.document.uri, rel: relPath(editor.document.uri), ctx: ctxFor(editor.document.uri) };
  };

  /* ---------- Map panel ---------- */

  const panelTitle = (ctx: Mapped) => (isMultiRoot() ? `CodeArchitect map: ${ctx.folder.name}` : "CodeArchitect map");

  /** The page reloads whenever its folder is re-mapped; it asks for the current file again once it is ready. */
  function renderPanel(): void {
    const ctx = panelKey ? mapped.get(panelKey) : undefined;
    if (!panel || !ctx) return;
    panel.title = panelTitle(ctx);
    panel.webview.html = renderShareHtml(ctx.index.graph);
  }

  /** Tell the map which file is open, so it selects it and highlights what depends on it. A file in another folder switches the map to that folder. */
  function postFocus(): void {
    const file = activeFile();
    if (!panel || !file?.ctx) return;
    if (file.ctx.key !== panelKey) {
      panelKey = file.ctx.key;
      return renderPanel(); // the page asks for the current file once it has loaded
    }
    if (file.ctx.index.nodeFor(file.rel)) void panel.webview.postMessage({ type: "focus", path: file.rel });
  }

  function showGraph(): void {
    const target = activeFile()?.ctx ?? [...mapped.values()][0];
    if (!target) return void vscode.window.showInformationMessage("CodeArchitect is still mapping the workspace.");
    if (panel) {
      panel.reveal(vscode.ViewColumn.Beside, true);
      panelKey = target.key;
      renderPanel();
      return postFocus();
    }
    panelKey = target.key;
    panel = vscode.window.createWebviewPanel("codearchitect.map", panelTitle(target), { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => ((panel = undefined), (panelKey = undefined)), null, context.subscriptions);
    panel.webview.onDidReceiveMessage(
      async (message: { type?: string; path?: string }) => {
        if (message.type === "ready") return postFocus();
        // Only paths that are part of the shown folder's map can be opened, whatever the page asks for.
        const ctx = panelKey ? mapped.get(panelKey) : undefined;
        if (message.type === "open" && ctx && typeof message.path === "string" && ctx.index.nodeFor(message.path)) await openRef({ path: message.path, label: "", depth: 0 }, ctx);
      },
      null,
      context.subscriptions,
    );
    renderPanel();
  }

  /* ---------- Status bar ---------- */

  function updateStatus(): void {
    const file = activeFile();
    if (!file?.ctx) return status.hide();
    const { index, folder } = file.ctx;
    const summary = index.summary(file.rel);
    if (!summary) return status.hide();

    const total = summary.dependents + summary.indirectDependents;
    status.text = `$(type-hierarchy) ${plural(total, "file")} affected`;
    const opensMap = readSettings().statusBarClick === "map";
    status.command = opensMap ? "codearchitect.showGraph" : "codearchitect.showBlastRadius";
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${summary.label}** · ${summary.layer}${isMultiRoot() ? ` · ${folder.name}` : ""}\n\n`);
    md.appendMarkdown(`${plural(summary.dependents, "file")} use it directly, ${summary.indirectDependents} more indirectly. It uses ${summary.dependencies}.\n\n`);
    md.appendMarkdown(`Change-risk **${summary.risk}/100** (${summary.level})${summary.reasons.length ? `: ${summary.reasons.join(", ")}` : ""}.\n\n`);
    if (index.skipped > 0) md.appendMarkdown(`_${plural(index.skipped, "file")} over the ${readSettings().maxFiles}-file limit are not mapped (setting: codearchitect.maxFiles)._\n\n`);
    if (isMultiRoot()) md.appendMarkdown("_Folders are mapped separately; links between folders are not followed._\n\n");
    md.appendMarkdown(opensMap ? "Click for the architecture map. Command Palette: _CodeArchitect: Show blast radius of this file_ for the list." : "Click for the list. Command Palette: _CodeArchitect: Show architecture map_ for the graph.");
    status.tooltip = md;
    status.backgroundColor = summary.level === "risky" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
  }

  /* ---------- Quick picks ---------- */

  const openRef = async (ref: FileRef, ctx: Mapped) => {
    await vscode.window.showTextDocument(vscode.Uri.joinPath(ctx.folder.uri, ref.path));
  };

  type RefItem = vscode.QuickPickItem & { ref?: FileRef };

  const refItems = (title: string, refs: FileRef[]): RefItem[] =>
    refs.length === 0
      ? []
      : [
          { label: `${title} (${refs.length})`, kind: vscode.QuickPickItemKind.Separator },
          ...refs.map((ref) => ({ label: ref.label, description: ref.path, detail: ref.symbols?.length ? `uses ${ref.symbols.join(", ")}` : undefined, ref })),
        ];

  async function pickAndOpen(title: string, items: RefItem[], empty: string, ctx: Mapped): Promise<void> {
    if (items.length === 0) return void vscode.window.showInformationMessage(empty);
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: "Pick a file to open", matchOnDescription: true });
    if (picked?.ref) await openRef(picked.ref, ctx);
  }

  /* ---------- Commands ---------- */

  context.subscriptions.push(
    vscode.commands.registerCommand("codearchitect.showBlastRadius", async () => {
      const file = activeFile();
      if (!file?.ctx) return void vscode.window.showInformationMessage(mapped.size === 0 ? "CodeArchitect is still mapping the workspace." : "This file is not part of the mapped architecture.");
      const radius = file.ctx.index.blastRadius(file.rel);
      if (!radius) return void vscode.window.showInformationMessage("This file is not part of the mapped architecture.");
      await pickAndOpen(
        `Blast radius of ${file.rel}`,
        [...refItems("Use it directly", radius.direct), ...refItems("Affected indirectly", radius.indirect)],
        "Nothing else in the workspace depends on this file.",
        file.ctx,
      );
    }),

    vscode.commands.registerCommand("codearchitect.showUsers", async (relArg?: string, symbolArg?: string, folderKeyArg?: string) => {
      const ctx = folderKeyArg ? mapped.get(folderKeyArg) : activeFile()?.ctx;
      if (!ctx) return void vscode.window.showInformationMessage("CodeArchitect is still mapping the workspace.");
      const rel = relArg ?? activeFile()?.rel;
      const usage = rel ? ctx.index.symbolUsage(rel) : [];
      if (!rel || usage.length === 0) return void vscode.window.showInformationMessage("No exported symbols found in this file.");

      let symbol = symbolArg;
      if (!symbol) {
        const editor = vscode.window.activeTextEditor;
        const word = editor?.document.getText(editor.document.getWordRangeAtPosition(editor.selection.active) ?? undefined);
        symbol = usage.find((u) => u.name === word)?.name;
      }
      if (!symbol) {
        const choice = await vscode.window.showQuickPick(
          usage.map((u) => ({ label: u.name, description: `used by ${u.users.length}` })),
          { title: "Which symbol?" },
        );
        symbol = choice?.label;
      }
      if (!symbol) return;

      const radius = ctx.index.blastRadius(rel, symbol);
      if (!radius) return;
      await pickAndOpen(
        `Changing ${symbol}`,
        [...refItems("Use it directly", radius.direct), ...refItems("Affected indirectly", radius.indirect), ...refItems("Import the file but do not use it", radius.spared)],
        `Nothing in the workspace uses ${symbol}.`,
        ctx,
      );
    }),

    vscode.commands.registerCommand("codearchitect.exportShare", async () => {
      let ctx = activeFile()?.ctx;
      if (!ctx && mapped.size > 1) {
        // No file open to say which folder: ask.
        const choice = await vscode.window.showQuickPick([...mapped.values()].map((m) => ({ label: m.folder.name, description: m.folder.uri.fsPath, key: m.key })), { title: "Export which folder?" });
        ctx = choice ? mapped.get(choice.key) : undefined;
        if (!ctx) return;
      }
      ctx ??= [...mapped.values()][0];
      if (!ctx) return void vscode.window.showInformationMessage("CodeArchitect has nothing to export yet.");
      const target = vscode.Uri.joinPath(ctx.folder.uri, `${ctx.folder.name}-architecture.html`);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(renderShareHtml(ctx.index.graph)));
      const open = "Open in browser";
      const choice = await vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(target)}. It is one self-contained file (it embeds your source code).`, open);
      if (choice === open) await vscode.env.openExternal(target);
    }),

    vscode.commands.registerCommand("codearchitect.showGraph", showGraph),

    vscode.commands.registerCommand("codearchitect.refresh", () => rebuild()),

    vscode.languages.registerCodeLensProvider(LANGUAGES.map((language) => ({ language, scheme: "file" })), {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(document) {
        const ctx = ctxFor(document.uri);
        if (!ctx || !readSettings().codeLens) return [];
        const rel = relPath(document.uri);
        return ctx.index.symbolUsage(rel).flatMap((usage) => {
          if (usage.line === null || usage.line >= document.lineCount) return [];
          const count = usage.users.length;
          const title = count === 0 ? "no other file uses this" : `${usage.uncertain ? "may be used by" : "used by"} ${plural(count, "file")}`;
          return [new vscode.CodeLens(new vscode.Range(usage.line, 0, usage.line, 0), { title, command: "codearchitect.showUsers", arguments: [rel, usage.name, ctx.key] })];
        });
      },
    }),

    vscode.window.onDidChangeActiveTextEditor(() => {
      updateStatus();
      postFocus();
    }),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme !== "file" || !LANGUAGES.includes(doc.languageId)) return;
      const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
      if (folder) scheduleRebuild(folder);
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration("codearchitect")) return;
      updateStatus(); // the click action can change without a re-map
      scheduleRebuild();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => scheduleRebuild()),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
  const onFileSetChange = (uri: vscode.Uri) => {
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder) scheduleRebuild(folder);
  };
  context.subscriptions.push(watcher, watcher.onDidCreate(onFileSetChange), watcher.onDidDelete(onFileSetChange));
  context.subscriptions.push({ dispose: () => clearTimeout(rebuildTimer) });

  void rebuild();
}

export function deactivate(): void {}
