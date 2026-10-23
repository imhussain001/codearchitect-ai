# VS Code extension

The extension puts the blast radius of the file you are editing into VS Code, so you can see what a change can break before you make it. It is built from this repository (it is not published on the Marketplace), and it runs entirely on your machine: the map is built locally from your workspace files and nothing is uploaded.

## What it adds

| Where | What you see |
|---|---|
| **Status bar** (left) | `N files affected`: files that use the active file directly or indirectly. Hover for the layer, direct and indirect counts, change-risk (0 to 100) and what drives it. A risky file turns the item amber. Click it for the list. |
| **CodeLens** above each export | `used by N files`, `may be used by N files` (usage could not be narrowed) or `no other file uses this`. Click it to open the list of files. TypeScript, JavaScript, Go, Java and Rust. |
| **Architecture map** (graph) | `CodeArchitect: Show architecture map` opens the interactive graph in a tab beside your code, like the web app's canvas: pan and zoom, search, a reading order, and a details panel per file. It follows the file you have open: that file is selected, files that depend on it directly glow amber, indirect ones glow lighter, and unrelated files dim. **Open in editor** in the details panel opens the file; the *Hide/Highlight what depends on this* button toggles the glow. **For Python and MATLAB projects the map is a data-flow graph**: scripts, the functions they call, and every CSV, MAT, JSON or image file they read or write, laid out entry scripts → analysis → plots → data. Click a data file and use **Where it comes from** (numbered path back to the raw inputs) or **What it affects** (the results that go stale if it changes); script details list what each one *Reads* and *Writes*. |
| **Command Palette** | `CodeArchitect: Show architecture map`, `CodeArchitect: Show blast radius of this file`, `CodeArchitect: Who uses this symbol?`, `CodeArchitect: Export shareable architecture page`, `CodeArchitect: Re-map the workspace`. |

**Who uses this symbol?** is the symbol-level version: pick a symbol (or place the cursor on one) and the list shows the files that use it, the files affected through them, and a third group, *Import the file but do not use it*, which a rename does not touch.

**Export shareable architecture page** writes `<folder>-architecture.html` into the workspace: one self-contained file (diagram, search, reading order, per-file details) that you can attach to an email or a PR. It embeds your source code, so share it only where that is fine.

## Install

You need [Node.js](https://nodejs.org) 20 or newer, VS Code 1.85 or newer, and a copy of this repository with its dependencies installed (`npm install`).

### 1. Build the extension package

Run this in the repository folder (see the README's Quick start for how to get there on Windows):

```bash
npm run ext:package
```

It bundles the extension and packs it with `@vscode/vsce` (downloaded on demand), producing `extensions/vscode/codearchitect.vsix` (about 140 KB).

### 2. Install it, either way

**From the command line** (the `code` command comes with VS Code; on macOS run *Shell Command: Install 'code' command in PATH* once from the Command Palette):

```bash
code --install-extension extensions/vscode/codearchitect.vsix
```

**From the VS Code window:**

1. Open the **Extensions** view (`Ctrl+Shift+X`, `Cmd+Shift+X` on macOS).
2. Click the **`…`** menu at the top of the view and choose **Install from VSIX…**.
3. Pick `extensions/vscode/codearchitect.vsix`.

(The Command Palette entry **Extensions: Install from VSIX…** does the same.)

### 3. Check that it works

1. Reload the window if VS Code asks you to (`Developer: Reload Window`).
2. In the Extensions view, search for **CodeArchitect**; it should be listed as installed.
3. Open a folder that contains TypeScript, JavaScript, Python, Go, Java, Kotlin, C#, Ruby or Rust code and open one of its files.
4. After a moment the status bar shows `N files affected`. Open the Command Palette (`Ctrl+Shift+P`) and type `CodeArchitect` to see the five commands; run **CodeArchitect: Show architecture map** to see the graph.

The first mapping happens at startup, and again shortly after you save, create or delete a source file. **View → Output → CodeArchitect** shows how long it took and how many files were mapped.

## Multi-root workspaces

Every folder of a multi-root workspace is mapped on its own, each with its own `codearchitect.maxFiles` budget. What you see always comes from the folder that contains the file you have open:

- The status bar, the lists and the CodeLens use that folder's map, so two folders that both have a `src/auth.ts` do not get mixed up. The status-bar tooltip names the folder.
- **Show architecture map** shows the open file's folder (the tab is titled `CodeArchitect map: <folder>`) and **switches** to the other folder's map when you open a file there.
- **Export shareable architecture page** exports the open file's folder and writes the page into it; with no file open it asks which folder.
- Saving, creating or deleting a file re-maps only that file's folder; adding or removing a folder re-maps the workspace.
- **Not followed:** dependencies *between* folders. Each folder's map shows its own files only.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `codearchitect.maxFiles` | `800` | Most files to map. Larger workspaces map the most architecturally relevant files; the status-bar tooltip says how many were left out. |
| `codearchitect.codeLens` | `true` | Show the `used by N files` lens. |
| `codearchitect.statusBarClick` | `list` | What clicking `N files affected` does: `list` shows the affected files, `map` opens the architecture map beside the code. The other stays in the Command Palette. |
| `codearchitect.showTitleBarButton` | `false` | Add a button (a small hierarchy icon) at the top right of the editor that opens the architecture map. Shown for TypeScript, JavaScript, Go, Java, Rust, Python and MATLAB files. |

**To change a setting:** `File → Preferences → Settings` (`Ctrl+,`), search for `CodeArchitect`, and pick a value; the status bar updates immediately. Or edit `settings.json` (`Ctrl+Shift+P` → *Preferences: Open User Settings (JSON)*):

```json
{
  "codearchitect.statusBarClick": "map",
  "codearchitect.showTitleBarButton": true
}
```

## Publishing to the Marketplace

The extension is ready to publish (icon, manifest, changelog and license files are in place and checked by `npm run ext:check`). Publishing needs a Marketplace publisher account and a token that only you can create: see [Publishing the extension](publishing-the-extension.md).

## Update or remove it

After pulling new changes, rebuild and reinstall over the old version:

```bash
npm run ext:package
code --install-extension extensions/vscode/codearchitect.vsix --force
```

To remove it:

```bash
code --uninstall-extension imhussain001.codearchitect-vscode
```

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `'code' is not recognized` | The `code` command is not on your PATH. On Windows, reinstall VS Code with *Add to PATH* ticked, or use the full path (`%LOCALAPPDATA%\Programs\Microsoft VS Code\bin\code`). On macOS use *Shell Command: Install 'code' command in PATH*. Or use the **Install from VSIX…** route above. |
| No status-bar item | The file is not part of the map (not a supported language, in `node_modules`, a test file, or over the `maxFiles` limit), or mapping is still running. Check **Output → CodeArchitect**, or run `CodeArchitect: Re-map the workspace`. |
| Numbers look too low | The analysis is lexical. Dependencies the scanner cannot see (reflection, dependency injection by type, generated code) are missing. See each language's limits in [Analysis engines](engines.md). |
| Slow on a huge workspace | Lower `codearchitect.maxFiles`, or open the sub-folder you are working in. |
| A file in a multi-root workspace shows nothing | The file's own folder is still mapping, or the file is outside every workspace folder. Run `CodeArchitect: Re-map the workspace`. |
| A dependency between two workspace folders is missing | Folders are mapped separately; links *between* folders are not followed (a package in one folder importing a sibling folder's code, for example). |

## Limits

- The analysis is lexical (no type checker), so it shows where to look rather than proving what breaks.
- MATLAB files have no CodeLens (MATLAB links are by function name, not by import). Python names built at run time (`f"{name}.csv"`) cannot be resolved, and Python calls through an object (`obj.method()`) are not linked ([Research code](research-scripts.md)).
- The extension is verified against a fake VS Code API in the test suite; try it on a real project and report anything odd.

## For contributors

| Command | What it does |
|---|---|
| `npm run ext:build` | Bundles `extensions/vscode/src/extension.ts` into `extensions/vscode/dist/extension.js` (`vscode` stays external). |
| `npm run ext:package` | Builds, then produces the `.vsix`. |

To debug, run `npm run ext:build`, open the `extensions/vscode` folder in VS Code and press `F5` ("Run Extension"); a second window opens with the extension loaded. The editor-independent logic is in `extensions/vscode/src/core.ts` (tests: `tests/vscodeCore.test.ts`); the VS Code wiring is in `extensions/vscode/src/extension.ts` (tests: `tests/vscodeExtension.test.ts`, against a fake API).
