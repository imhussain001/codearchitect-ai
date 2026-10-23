# Research code: MATLAB and Python scripts

CodeArchitect treats an analysis codebase (a power-systems study, a simulation pipeline, a data-science repo) as a **data-flow graph**, not just a web of imports. The question it answers is the one research code actually raises: *which scripts and functions produce this figure, and what goes stale if I change this input?*

## What you get

| You see | What it means |
|---|---|
| **Entry scripts** | Scripts nothing else calls: where a run starts (`run_study.m`, `make_report.m`). |
| **Analysis code** | The functions and modules the entry scripts call (`load_trace`, `align_signals`, `nrmse_percent`). |
| **Plots & outputs** | Files that draw figures (two or more plotting calls). |
| **Data files** | Every CSV, MAT, Excel, JSON, HDF5, NumPy or image file a script reads or writes, as nodes of their own. |
| **Edges** | *Script calls function*, *script reads file*, and *script writes file* (the arrow points from the producer to what it produces). |

The layers are laid out in pipeline order: entry scripts first, then analysis code, plots, and finally data. The layer names change to match (`kindLabels`), so the legend says *Entry scripts* and *Data files* instead of *API route* and *Database*.

## Try it in two minutes

1. Start the app (`npm run dev`) and pick **Power-Systems Study (MATLAB)** in the repository selector. It has one entry script, four helper functions and the CSV files they read and write.
2. Click **`nrmse_results.csv`** and, in the Inspector, press **Where it comes from**. The map numbers the path from the four raw `pscad_*.csv` inputs, through `run_study.m` and its helpers, to the result.
3. Click **`pscad_base.csv`** and press **What it affects**. Every result that would be out of date if that input changed lights up, across pipeline stages (`nrmse_results.csv`, then `nrmse_bar.png` through `make_report.m`).
4. Open **Blast Radius** and type *"Change the CSV column layout of the PSCAD files"*. The authored scenario shows the coupling the scan cannot see by itself (the position-based parsing inside `load_trace.m`) with a before/after diff.
5. Open **Guide** for a reading order of the pipeline.

## Use it on your own scripts

| You want to | Do this |
|---|---|
| Look at a project on your disk | `npm run view -- C:\path\to\your\project` (maps the folder and opens the app) |
| Upload a project in the browser | **Custom Upload…** and drop a `.zip` of the folder |
| See it next to your code in VS Code | Install the [extension](vscode-extension.md) and run **CodeArchitect: Show architecture map**. It shows the same data-flow map and trace in a tab beside the editor, and follows the file you have open |
| Share it with a colleague | **Export → Shareable page** (or `npm run cli -- share <folder>`): one `.html` file with the map, trace-ready details and a reading order |
| Check a pull request | `npm run cli -- pr --base main` or the bundled GitHub workflow (see below) |
| See whether it is getting messier | `npm run cli -- history .` |

Python and MATLAB files can sit in the same repository as web code, Go, Java or Rust; each language is mapped by its own module and the results share one graph.

## Provenance: where it comes from, what it affects

Select any component and choose a direction:

- **Where does this come from?** Follows *writes* backwards from a result to the code that produces it, then that code's reads and calls, and so on. Files nothing writes are the **raw inputs**. The path is numbered from raw inputs to the result.
- **What does this affect?** Follows readers and callers forward, then everything that code writes. The files reached are the **results that would be out of date**.

A change that touches code shows up in **Blast Radius** too, but the two answer different questions: blast radius is about *code coupling* (who calls this function), provenance is about *data flow* (which files depend on which inputs).

## In pull requests: stale outputs

When a PR changes a script or an input file, the architecture comment adds a line like:

> **2** output files may be out of date until the pipeline is re-run:
> `nrmse_results.csv` _(from Nrmse Percent)_, `nrmse_bar.png` _(from Nrmse Percent)_

This is advisory (it never fails the check), and it tells reviewers which CSVs and figures to regenerate. It is also in the JSON output under `blastRadius.staleOutputs`. Rules and the other checks work on script projects exactly as on any other (see [Rules, CLI and CI](cli-and-ci.md)).

## How a script file is read

1. **Comments and strings are removed first**, so a file name inside a comment is never a dependency. MATLAB `%`, `%{ … %}` and `...` and Python `#` and triple-quoted docstrings are handled; MATLAB's `'` is told apart from the transpose operator.
2. **Data files** are found from string literals that end in a data or output extension (`csv tsv mat xlsx xls txt dat json h5 parquet pkl npy npz xml`, and `png jpg pdf svg eps fig`), including names kept in cell arrays or struct fields. A reference is a **write** when its line contains a write call (`writetable`, `save`, `exportgraphics`, `to_csv`, `savefig`, `fopen(..., 'w')`, …), a **read** otherwise. A file both read and written counts as written.
3. **MATLAB function calls** are matched by name: a file's name is a callable, and a whole-word use of another file's name in code (not after a `.`, not shadowed by a local function) is a call.
4. **Python** imports are followed **by name**: `from cosim_app.state import AppState` links to the file that defines `AppState`, `from cosim_app import state` links to `cosim_app/state.py` with the attributes used through it, relative imports (`from ..x import y`) and `import a.b as x` are resolved, and a file's details list who uses each function, class or constant it defines. Imports inside a function or under `if TYPE_CHECKING:` are marked as deferred, so a deliberate cycle-breaker is not reported as a cycle. Data files are found as above.
5. **Descriptions** come from each file's header comment, **exports** from `function` definitions, **parameters** from the first signature.

The full algorithm, including the layer rules and the data-node cap, is in [Analysis engines](engines.md#script-data-flow-mapper-libenginesscriptsts) and [Provenance](engines.md#provenance-libenginesprovenancets).

## Limits you should know about

- **Names built at run time** (`['pscad_' lvl '.csv']`, `f"{name}.csv"`, `*.csv`) cannot be resolved; they are shown as *patterns*, not files.
- **Contents are never read.** A `.mat` file's variables, a CSV's columns, and cell-array indexing are invisible, so *which column* a script uses is not tracked (the sample's authored scenario exists to show exactly that gap).
- **MATLAB calls are by name only.** Method calls on objects, `feval`/function handles and calls through `eval` are not followed. Python calls inside one module are not tracked, and a name reached only through attribute access on an object (`obj.method()`) is not linked; cross-module links come from imports.
- **At most 40 data nodes** are shown; the rest are grouped into "+N more data files".
- **Absolute and network paths, URLs and unknown extensions** are ignored.
- **Simulation tools** (PSCAD/PSS/E case files, Simulink models) are not parsed; only the scripts around them and the data files they exchange.
- The analysis is a **map to look at**, not a proof: it shows where to look and what to re-run, not whether the numbers are right.
