import { buildHeuristicGraph } from "@/lib/engines/heuristicGraph";
import type { ArchitectureGraph, SourceFile } from "@/lib/types";

/**
 * A small MATLAB analysis pipeline, written for this sample. It shows the script mapper on a
 * typical research workflow: one entry script, helper functions, CSV inputs and outputs.
 */
const FILES: SourceFile[] = [
  {
    path: "run_study.m",
    content: `%% run_study.m
% Compares detailed and reduced simulation levels against a base case and
% reports the error of each level, plus an overlay plot at the boundary bus.
levels = {'base', 'lvl1', 'lvl2'};
baseFile = 'pscad_base.csv';
files = {baseFile, 'pscad_lvl1.csv', 'pscad_lvl2.csv'};

base = load_trace(baseFile);
psse = load_trace('psse_boundary.csv');

results = zeros(numel(levels), 1);
for k = 1:numel(levels)
    trace = load_trace(files{k});
    aligned = align_signals(base, trace, 0.5);
    results(k) = nrmse_percent(base.v, aligned.v);
end

T = table(levels', results, 'VariableNames', {'level', 'nrmse_pct'});
writetable(T, 'nrmse_results.csv');
plot_overlay(base, psse, 'overlay_boundary.png');
`,
  },
  {
    path: "make_report.m",
    content: `%% make_report.m
% Second stage: reads the error table written by run_study and saves the bar
% chart used in the paper.
T = readtable('nrmse_results.csv');
figure;
bar(categorical(T.level), T.nrmse_pct);
xlabel('Model level'); ylabel('NRMSE (%)');
exportgraphics(gcf, 'nrmse_bar.png');
`,
  },
  {
    path: "load_trace.m",
    content: `function trace = load_trace(file)
% LOAD_TRACE  Read a simulation CSV (time in column 1, voltage in column 2).
    data = readmatrix(file, 'NumHeaderLines', 1);
    trace.t = data(:, 1);
    trace.v = data(:, 2);
end
`,
  },
  {
    path: "align_signals.m",
    content: `function out = align_signals(ref, sig, trimSeconds)
% ALIGN_SIGNALS  Drop the first trimSeconds and resample sig onto ref's time base.
    keep = ref.t >= trimSeconds;
    out.t = ref.t(keep);
    out.v = interp1(sig.t, sig.v, out.t, 'linear', 'extrap');
end
`,
  },
  {
    path: "nrmse_percent.m",
    content: `function e = nrmse_percent(ref, est)
% NRMSE_PERCENT  Root-mean-square error as a percentage of the reference range.
    e = 100 * sqrt(mean((ref - est).^2)) / (max(ref) - min(ref));
end
`,
  },
  {
    path: "plot_overlay.m",
    content: `function plot_overlay(a, b, outFile)
% PLOT_OVERLAY  Overlay two traces and save the figure.
    figure;
    plot(a.t, a.v, 'LineWidth', 1.2); hold on;
    plot(b.t, b.v, '--');
    legend('Detailed', 'Boundary'); xlabel('Time (s)'); ylabel('Voltage (pu)');
    exportgraphics(gcf, outFile);
end
`,
  },
];

const LOADER_BY_NAME = `function trace = load_trace(file)
% LOAD_TRACE  Read a simulation CSV by column name, so the column order can change.
    T = readtable(file);
    trace.t = T.time_s;
    trace.v = T.voltage_pu;
end
`;

function build(): ArchitectureGraph {
  const built = buildHeuristicGraph("Power-Systems Study (MATLAB)", FILES);
  const idOf = (path: string) => {
    const node = built.nodes.find((n) => n.data.filePath === path);
    if (!node) throw new Error(`sample is missing ${path}`);
    return node.id;
  };
  const loaderId = idOf("load_trace.m");

  return {
    ...built,
    id: "power-systems-matlab",
    description: "MATLAB pipeline: one entry script, four helper functions and the CSV files it reads and writes.",
    warnings: undefined,
    scenarios: [
      {
        id: "csv-column-layout",
        title: "Change the CSV column layout",
        triggers: ["column", "csv.*(layout|format|header)", "layout", "header"],
        rootNodeId: "data-pscad-base-csv",
        summary:
          "Reordering or renaming columns in the PSCAD CSV files breaks anything that reads them by position. The scan sees run_study read these files, but the position-based parsing lives in load_trace, which only receives a file name, so this scenario adds it by hand. Reading by column name fixes it for good.",
        extraImpacts: [{ nodeId: loaderId, reason: "Parses the CSV by column position (column 1 = time, column 2 = voltage)." }],
        diffs: [{ nodeId: loaderId, after: LOADER_BY_NAME, rationale: "Look the columns up by header name instead of position." }],
      },
    ],
  };
}

export const powerSystemsMatlab: ArchitectureGraph = build();

export const POWER_SYSTEMS_PROMPTS = [
  "Change the CSV column layout of the PSCAD files",
  "Rename nrmse_percent to compute_nrmse",
  "Change how align_signals trims the start of each trace",
];
