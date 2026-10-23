# CodeArchitect: Blast Radius (VS Code)

See what a change to the file you are editing can break, without leaving the editor.

- **Architecture map:** `CodeArchitect: Show architecture map` opens the interactive graph beside your code. It selects the file you have open, glows the files that depend on it (amber = direct, lighter = indirect) and dims the rest; click a file for its details and **Open in editor**. For Python and MATLAB projects it is a data-flow graph with **Where it comes from / What it affects** traces over the data files.
- **Status bar:** `N files affected` for the active file (direct and indirect dependents), with change-risk and what drives it in the tooltip. Click for the list; pick a file to open it.
- **CodeLens:** `used by N files` above each exported symbol (TypeScript, JavaScript, Go, Java, Rust). Click it to see exactly which files, and which of the file's importers do *not* use the symbol.
- **Who uses this symbol?** (`CodeArchitect: Who uses this symbol?`): a symbol-level blast radius. Importers that do not use the symbol are listed as spared, so you know what a rename really touches.
- **Export shareable architecture page:** one self-contained `.html` file of the whole workspace (diagram, search, reading order, per-file details). It embeds your source code, so share it only where that is fine.

The map is built locally from your workspace files and re-built shortly after you save, create or delete a file. Nothing is uploaded.

## Settings

| Setting | Default | |
|---|---|---|
| `codearchitect.maxFiles` | 800 | Most files to map. Larger workspaces map the most architecturally relevant files; the status-bar tooltip says how many were left out. |
| `codearchitect.codeLens` | true | Show the `used by N files` lens. |
| `codearchitect.statusBarClick` | `list` | What clicking `N files affected` does: `list` or `map` (the architecture map). |
| `codearchitect.showTitleBarButton` | false | Add a button to the editor's title bar that opens the architecture map. |

## Limits

- The analysis is lexical (no type checker): see `docs/engines.md` in the repository for what each language does and does not follow.
- Only the first workspace folder is mapped.
- Python and MATLAB files are mapped for the shareable page, but have no CodeLens.

## Build and install

From the repository root (after `npm install`):

```bash
npm run ext:package
code --install-extension extensions/vscode/codearchitect.vsix
```

Or, in VS Code, open the **Extensions** view, click the **`…`** menu, choose **Install from VSIX…** and pick `extensions/vscode/codearchitect.vsix`. Then reload the window and open a source file: the status bar shows `N files affected`.

`ext:package` bundles the extension and packs it with `@vscode/vsce` (fetched on demand). To try it without installing, run `npm run ext:build`, open `extensions/vscode` in VS Code and press F5.

Full instructions, update and uninstall commands and troubleshooting: [docs/vscode-extension.md](https://github.com/imhussain001/codearchitect-ai/blob/main/docs/vscode-extension.md).
