# Changelog

## 0.1.0 (first release, preview)

- Status bar: how many files a change to the open file affects (directly and indirectly), with change-risk and what drives it. Choose what a click does with `codearchitect.statusBarClick` (the list, or the map).
- CodeLens above exported symbols: "used by N files" for TypeScript, JavaScript, Python, Go, Java and Rust.
- **CodeArchitect: Who uses this symbol?** A symbol-level blast radius: the files that use a symbol, the files affected through them, and the importers that do not use it.
- **CodeArchitect: Show architecture map**: the interactive graph beside your code. It follows the open file, glows the files that depend on it, and shows data-flow traces for Python and MATLAB projects. Optional title-bar button (`codearchitect.showTitleBarButton`).
- **CodeArchitect: Export shareable architecture page**: one self-contained HTML file of the workspace.
- Multi-root workspaces: each folder is mapped separately. Links between folders are not followed.
- The map is built locally from your files and refreshed shortly after you save. Nothing is uploaded.
