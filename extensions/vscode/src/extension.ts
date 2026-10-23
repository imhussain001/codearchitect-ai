import * as vscode from "vscode";
import { renderShareHtml } from "@/lib/share";
import { ArchIndex, type FileRef, type WorkspaceFile } from "./core";

/**
 * Thin VS Code adapter over `core.ts`: it reads the workspace, keeps an `ArchIndex` fresh, and
 * shows what it knows in the status bar, as CodeLens and in quick picks. All the analysis is in
 * the core (unit-tested without an editor).
 */

const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact", "go", "java", "rust"];
const SOURCE_GLOB = "**/*.{ts,tsx,js,jsx,mjs,cjs,go,java,rs,py,m}";
const EXCLUDE_GLOB = "**/{node_modules,dist,build,out,.next,.git,target,vendor,venv,.venv,__pycache__,coverage}/**";
const MAX_FILE_BYTES = 200 * 1024;
const READ_BUDGET_FACTOR = 2; // read up to this many times maxFiles, then let the mapper choose the most relevant
const REBUILD_DEBOUNCE_MS = 800;

type Settings = { maxFiles: number; codeLens: boolean };

const readSettings = (): Settings => {
  const config = vscode.workspace.getConfiguration("codearchitect");
  return { maxFiles: Math.max(20, config.get<number>("maxFiles", 800)), codeLens: config.get<boolean>("codeLens", true) };
};

const relPath = (uri: vscode.Uri) => vscode.workspace.asRelativePath(uri, false).split("\\").join("/");
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel("CodeArchitect");
  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  const lensChanged = new vscode.EventEmitter<void>();
  let index: ArchIndex | null = null;
  let building = false;
  let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  context.subscriptions.push(log, status, lensChanged);

  /* ---------- Indexing ---------- */

  async function readWorkspace(maxFiles: number): Promise<{ name: string; files: WorkspaceFile[] } | null> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return null;
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
    return { name: folder.name, files };
  }

  async function rebuild(): Promise<void> {
    if (building) return;
    building = true;
    status.text = "$(sync~spin) CodeArchitect: mapping…";
    status.show();
    const started = Date.now();
    try {
      const { maxFiles } = readSettings();
      const workspace = await readWorkspace(maxFiles);
      if (!workspace) return void status.hide();
      index = ArchIndex.build(workspace.name, workspace.files, maxFiles);
      log.appendLine(`mapped ${index.graph.nodes.length} files (${index.skipped} over the limit) in ${Date.now() - started} ms`);
      lensChanged.fire();
    } catch (error) {
      log.appendLine(`mapping failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      void vscode.window.showWarningMessage("CodeArchitect could not map this workspace. See the CodeArchitect output channel.");
    } finally {
      building = false;
      updateStatus();
    }
  }

  const scheduleRebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => void rebuild(), REBUILD_DEBOUNCE_MS);
  };

  /* ---------- Status bar ---------- */

  function updateStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (!index || !editor || editor.document.uri.scheme !== "file") return status.hide();
    const summary = index.summary(relPath(editor.document.uri));
    if (!summary) return status.hide();

    const total = summary.dependents + summary.indirectDependents;
    status.text = `$(type-hierarchy) ${plural(total, "file")} affected`;
    status.command = "codearchitect.showBlastRadius";
    const md = new vscode.MarkdownString(undefined, true);
    md.appendMarkdown(`**${summary.label}** · ${summary.layer}\n\n`);
    md.appendMarkdown(`${plural(summary.dependents, "file")} use it directly, ${summary.indirectDependents} more indirectly. It uses ${summary.dependencies}.\n\n`);
    md.appendMarkdown(`Change-risk **${summary.risk}/100** (${summary.level})${summary.reasons.length ? `: ${summary.reasons.join(", ")}` : ""}.\n\n`);
    if (index.skipped > 0) md.appendMarkdown(`_${plural(index.skipped, "file")} over the ${readSettings().maxFiles}-file limit are not mapped (setting: codearchitect.maxFiles)._\n\n`);
    md.appendMarkdown("Click for the list.");
    status.tooltip = md;
    status.backgroundColor = summary.level === "risky" ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    status.show();
  }

  /* ---------- Quick picks ---------- */

  const openRef = async (ref: FileRef) => {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return;
    await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, ref.path));
  };

  type RefItem = vscode.QuickPickItem & { ref?: FileRef };

  const refItems = (title: string, refs: FileRef[]): RefItem[] =>
    refs.length === 0
      ? []
      : [
          { label: `${title} (${refs.length})`, kind: vscode.QuickPickItemKind.Separator },
          ...refs.map((ref) => ({ label: ref.label, description: ref.path, detail: ref.symbols?.length ? `uses ${ref.symbols.join(", ")}` : undefined, ref })),
        ];

  async function pickAndOpen(title: string, items: RefItem[], empty: string): Promise<void> {
    if (items.length === 0) return void vscode.window.showInformationMessage(empty);
    const picked = await vscode.window.showQuickPick(items, { title, placeHolder: "Pick a file to open", matchOnDescription: true });
    if (picked?.ref) await openRef(picked.ref);
  }

  const activeFile = (): { uri: vscode.Uri; rel: string } | null => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.uri.scheme !== "file") return null;
    return { uri: editor.document.uri, rel: relPath(editor.document.uri) };
  };

  /* ---------- Commands ---------- */

  context.subscriptions.push(
    vscode.commands.registerCommand("codearchitect.showBlastRadius", async () => {
      const file = activeFile();
      if (!index) return void vscode.window.showInformationMessage("CodeArchitect is still mapping the workspace.");
      const radius = file && index.blastRadius(file.rel);
      if (!file || !radius) return void vscode.window.showInformationMessage("This file is not part of the mapped architecture.");
      await pickAndOpen(
        `Blast radius of ${file.rel}`,
        [...refItems("Use it directly", radius.direct), ...refItems("Affected indirectly", radius.indirect)],
        "Nothing else in the workspace depends on this file.",
      );
    }),

    vscode.commands.registerCommand("codearchitect.showUsers", async (relArg?: string, symbolArg?: string) => {
      if (!index) return void vscode.window.showInformationMessage("CodeArchitect is still mapping the workspace.");
      const rel = relArg ?? activeFile()?.rel;
      const usage = rel ? index.symbolUsage(rel) : [];
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

      const radius = index.blastRadius(rel, symbol);
      if (!radius) return;
      await pickAndOpen(
        `Changing ${symbol}`,
        [...refItems("Use it directly", radius.direct), ...refItems("Affected indirectly", radius.indirect), ...refItems("Import the file but do not use it", radius.spared)],
        `Nothing in the workspace uses ${symbol}.`,
      );
    }),

    vscode.commands.registerCommand("codearchitect.exportShare", async () => {
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (!index || !folder) return void vscode.window.showInformationMessage("CodeArchitect has nothing to export yet.");
      const target = vscode.Uri.joinPath(folder.uri, `${folder.name}-architecture.html`);
      await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(renderShareHtml(index.graph)));
      const open = "Open in browser";
      const choice = await vscode.window.showInformationMessage(`Wrote ${vscode.workspace.asRelativePath(target)}. It is one self-contained file (it embeds your source code).`, open);
      if (choice === open) await vscode.env.openExternal(target);
    }),

    vscode.commands.registerCommand("codearchitect.refresh", () => rebuild()),

    vscode.languages.registerCodeLensProvider(LANGUAGES.map((language) => ({ language, scheme: "file" })), {
      onDidChangeCodeLenses: lensChanged.event,
      provideCodeLenses(document) {
        if (!index || !readSettings().codeLens) return [];
        const rel = relPath(document.uri);
        return index.symbolUsage(rel).flatMap((usage) => {
          if (usage.line === null || usage.line >= document.lineCount) return [];
          const count = usage.users.length;
          const title = count === 0 ? "no other file uses this" : `${usage.uncertain ? "may be used by" : "used by"} ${plural(count, "file")}`;
          return [new vscode.CodeLens(new vscode.Range(usage.line, 0, usage.line, 0), { title, command: "codearchitect.showUsers", arguments: [rel, usage.name] })];
        });
      },
    }),

    vscode.window.onDidChangeActiveTextEditor(updateStatus),
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (doc.uri.scheme === "file" && LANGUAGES.includes(doc.languageId)) scheduleRebuild();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("codearchitect")) scheduleRebuild();
    }),
  );

  const watcher = vscode.workspace.createFileSystemWatcher(SOURCE_GLOB);
  context.subscriptions.push(watcher, watcher.onDidCreate(scheduleRebuild), watcher.onDidDelete(scheduleRebuild));
  context.subscriptions.push({ dispose: () => clearTimeout(rebuildTimer) });

  void rebuild();
}

export function deactivate(): void {}
