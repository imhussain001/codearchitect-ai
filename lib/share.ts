import { renderSvg } from "@/lib/export";
import { buildGuide } from "@/lib/engines/guide";
import { analyzeHealth } from "@/lib/engines/health";
import { KIND_META, kindLabelFor } from "@/lib/ui";
import { buildRenderGraph } from "@/lib/viewModel";
import type { ArchitectureGraph } from "@/lib/types";

/**
 * A single, self-contained HTML page of an architecture map: no server, no network, no
 * dependencies. Open it from an email, a wiki attachment or a CI artifact. It has a pan/zoom
 * diagram, search, a reading-order guide and a details panel per component (code, uses,
 * used-by, risk).
 */

const MAX_DISPLAY_CODE_LINES = 200;
const SHARE_FORMAT = "codearchitect-share/v1";

/** JSON safe to place inside a `<script>` element: no `</script>`, `<!--` or line-separator surprises. */
function embedJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(new RegExp(String.fromCharCode(0x2028), "g"), "\\u2028")
    .replace(new RegExp(String.fromCharCode(0x2029), "g"), "\\u2029");
}

const escapeHtml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type ShareData = {
  format: typeof SHARE_FORMAT;
  name: string;
  description: string;
  grade: string;
  /** True when the map has data files (script projects), which turns on the data-flow trace. */
  hasData: boolean;
  score: number;
  kinds: Record<string, { label: string; color: string }>;
  nodes: Array<{
    id: string;
    label: string;
    kind: string;
    filePath: string;
    description: string;
    exports: string[];
    code: string;
    score: number;
    reasons: string[];
  }>;
  edges: Array<{ s: string; t: string; rel: string; label?: string }>;
  guide: { headline: string; path: Array<{ id: string; role: string; why: string }>; omitted: number };
};

const CODE_LANGUAGES = /^(tsx?|jsx?|mjs|cjs|py|go|java|rs|m)$/i;

/**
 * Script projects have data *files* as nodes (a CSV, a figure), which turns on the data-flow trace.
 * A web project's "data" layer (a database, a cache) is code, so it does not.
 */
function hasDataFiles(graph: ArchitectureGraph): boolean {
  return graph.nodes.some((n) => n.data.kind === "data" && n.id.startsWith("data-") && !CODE_LANGUAGES.test(n.data.language));
}

export function buildShareData(graph: ArchitectureGraph): ShareData {
  const real = { ...graph, nodes: graph.nodes.filter((n) => !n.data.isDraft), edges: graph.edges.filter((e) => !e.isDraft) };
  const health = analyzeHealth(real);
  const guide = buildGuide(real);
  const kinds = Object.fromEntries(
    (Object.keys(KIND_META) as Array<keyof typeof KIND_META>).filter((k) => real.nodes.some((n) => n.data.kind === k)).map((k) => [k, { label: kindLabelFor(graph, k), color: KIND_META[k].hex }]),
  );
  return {
    format: SHARE_FORMAT,
    name: graph.name,
    description: graph.description ?? "",
    grade: health.grade,
    hasData: hasDataFiles(real),
    score: health.overall,
    kinds,
    nodes: real.nodes.map((n) => ({
      id: n.id,
      label: n.data.label,
      kind: n.data.kind,
      filePath: n.data.filePath,
      description: /detected by path heuristics/.test(n.data.description) ? "" : n.data.description,
      exports: n.data.exports,
      code: n.data.code.split("\n").slice(0, MAX_DISPLAY_CODE_LINES).join("\n"),
      score: health.nodes[n.id]?.score ?? 0,
      reasons: health.nodes[n.id]?.reasons ?? [],
    })),
    edges: real.edges.map((e) => ({ s: e.source, t: e.target, rel: e.relation, ...(e.label ? { label: e.label } : {}) })),
    guide: { headline: guide.headline, path: guide.path.map((s) => ({ id: s.nodeId, role: s.role, why: s.why })), omitted: guide.omitted },
  };
}

export function renderShareHtml(graph: ArchitectureGraph): string {
  const data = buildShareData(graph);
  const real = { ...graph, nodes: graph.nodes.filter((n) => !n.data.isDraft), edges: graph.edges.filter((e) => !e.isDraft) };
  const { nodes, edges } = buildRenderGraph({ graph: real, impact: null, story: { enabled: false, index: 0 } });
  const drawing = renderSvg(nodes, edges, { kindLabels: graph.kindLabels }).svg.replace(/ width="\d+" height="\d+"/, ' width="100%" height="100%"');
  const title = escapeHtml(`${graph.name}: architecture`);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<header>
  <div class="brand"><strong>${escapeHtml(graph.name)}</strong><span class="sub">Health ${data.grade} · ${data.nodes.length} components · ${data.edges.length} dependencies</span></div>
  <input id="search" type="search" placeholder="Search components (press /)" aria-label="Search components" autocomplete="off">
</header>
<main>
  <section id="stage" aria-label="Architecture diagram">
    <div id="diagram">${drawing}</div>
    <div id="zoom" role="group" aria-label="Zoom"><button id="zin" aria-label="Zoom in">+</button><button id="zout" aria-label="Zoom out">−</button><button id="zfit" aria-label="Fit to screen">Fit</button></div>
    <p id="hint">Drag to pan · scroll to zoom · click a component</p>
  </section>
  <aside id="panel" aria-live="polite"></aside>
</main>
<script id="data" type="application/json">${embedJson(data)}</script>
<script>${SCRIPT}</script>
</body>
</html>
`;
}

const STYLE = `
:root{--bg:#09090b;--panel:#111114;--line:#27272a;--text:#e4e4e7;--muted:#a1a1aa;--accent:#a78bfa;color-scheme:dark}
@media (prefers-color-scheme:light){:root{--bg:#fafafa;--panel:#fff;--line:#e4e4e7;--text:#18181b;--muted:#52525b;--accent:#6d28d9;color-scheme:light}#diagram{background:#09090b}}
*{box-sizing:border-box}html,body{height:100%;margin:0}
body{display:flex;flex-direction:column;background:var(--bg);color:var(--text);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
header{display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:space-between;padding:10px 16px;border-bottom:1px solid var(--line)}
.brand{display:flex;flex-direction:column}.brand .sub{color:var(--muted);font-size:12px}
#search{min-width:220px;flex:0 1 320px;padding:7px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel);color:var(--text);font:inherit}
main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 400px}
#stage{position:relative;min-height:0;background:#09090b}
#diagram{position:absolute;inset:0;cursor:grab;touch-action:none}#diagram.drag{cursor:grabbing}
#diagram svg{display:block;width:100%;height:100%}
g.node{cursor:pointer;transition:opacity .15s}g.node.sel{filter:drop-shadow(0 0 8px #a78bfa)}
g.node.trace{filter:drop-shadow(0 0 7px #22d3ee)}ol.trace-steps{margin:6px 0 0;padding:0;list-style:none}ol.trace-steps li{margin:0 0 6px}.tstep{display:flex;gap:8px;align-items:baseline;width:100%;text-align:left;padding:4px 6px;border-radius:6px;border:1px solid transparent;background:transparent;color:var(--text);font:inherit;font-size:12px;cursor:pointer}.tstep:hover{border-color:var(--accent)}.tstep i{font-style:normal;color:var(--muted);font-size:11px}
g.node.imp-direct{filter:drop-shadow(0 0 7px #f59e0b)}g.node.imp-indirect{filter:drop-shadow(0 0 5px #fcd34d)}g.node.dim{opacity:.16}
.actions{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0}.action{padding:5px 10px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;font-size:12px;cursor:pointer}.action:hover{border-color:var(--accent)}.action.on{border-color:#f59e0b;color:#fbbf24}
#zoom{position:absolute;right:12px;bottom:12px;display:flex;gap:6px}
#zoom button{min-width:34px;height:34px;border-radius:8px;border:1px solid #3f3f46;background:#18181b;color:#e4e4e7;font:inherit;cursor:pointer}
#hint{position:absolute;left:12px;bottom:8px;margin:0;font-size:11px;color:#71717a;pointer-events:none}
#panel{min-height:0;overflow:auto;padding:16px;border-left:1px solid var(--line);background:var(--panel)}
h2{margin:0 0 4px;font-size:16px}h3{margin:16px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
p{margin:0 0 8px}.muted{color:var(--muted)}.path{font-family:ui-monospace,Consolas,monospace;font-size:12px;color:var(--muted);word-break:break-all}
.chip{display:inline-block;margin:0 6px 6px 0;padding:2px 8px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--text);font:12px ui-monospace,Consolas,monospace;cursor:pointer}
span.chip{cursor:default}button.chip:hover{border-color:var(--accent)}
.kind{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:600;border:1px solid currentColor}
ol.steps{list-style:none;margin:0;padding:0}ol.steps li{margin:0 0 8px}
.step{display:block;width:100%;text-align:left;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;cursor:pointer}
.step:hover{border-color:var(--accent)}.step b{display:block}.step span{display:block;margin-top:2px;font-size:12px;color:var(--muted)}
pre{margin:0;padding:10px;max-height:340px;overflow:auto;border-radius:8px;border:1px solid var(--line);background:#09090b;color:#d4d4d8;font:12px/1.5 ui-monospace,Consolas,monospace}
.back{margin-bottom:10px;padding:3px 8px;border-radius:6px;border:1px solid var(--line);background:transparent;color:var(--text);font:inherit;font-size:12px;cursor:pointer}
.warn{color:#fbbf24;font-size:12px}
@media (max-width:820px){main{grid-template-columns:1fr;grid-template-rows:minmax(260px,45vh) minmax(0,1fr)}#panel{border-left:0;border-top:1px solid var(--line)}}
`;

/** Client script. No backticks or template placeholders: it is embedded in a template literal above. */
/**
 * Data-flow tracing for the page: the same walk as \`traceProvenance\` (lib/engines/provenance.ts),
 * as plain JavaScript with no DOM so a test can run it against the engine and compare.
 * \`writes\` edges point from a producer to what it produces; every other edge points from a user to what it uses.
 */
export const TRACE_JS = `
function buildFlow(D) {
  var out = {}, inc = {};
  D.edges.forEach(function (e) {
    (out[e.s] = out[e.s] || []).push(e);
    (inc[e.t] = inc[e.t] || []).push(e);
  });
  return { out: out, inc: inc };
}
function traceFrom(D, flow, id, mode) {
  var byId = {};
  D.nodes.forEach(function (n) { byId[n.id] = n; });
  var isData = function (x) { return byId[x].kind === 'data'; };
  var depth = {}; depth[id] = 0;
  var queue = [id];
  function visit(from, to) {
    if (byId[to] && depth[to] === undefined) { depth[to] = depth[from] + 1; queue.push(to); }
  }
  for (var head = 0; head < queue.length; head++) {
    var x = queue[head];
    var inn = flow.inc[x] || [], outt = flow.out[x] || [];
    if (mode === 'upstream') {
      if (isData(x)) inn.forEach(function (e) { if (e.rel === 'writes') visit(x, e.s); });
      else outt.forEach(function (e) { if (e.rel !== 'writes') visit(x, e.t); });
    } else {
      inn.forEach(function (e) { if (e.rel !== 'writes') visit(x, e.s); });
      if (!isData(x)) outt.forEach(function (e) { if (e.rel === 'writes') visit(x, e.t); });
    }
  }
  var hasWriter = function (x) { return (flow.inc[x] || []).some(function (e) { return e.rel === 'writes'; }); };
  var roleOf = function (x) {
    if (x === id) return 'target';
    if (!isData(x)) return 'code';
    return hasWriter(x) ? 'produced' : 'input';
  };
  var rank = { input: 0, code: 1, produced: 2, target: 3 };
  var steps = Object.keys(depth).map(function (x) { return { id: x, depth: depth[x], role: roleOf(x) }; });
  steps.sort(function (a, b) {
    return (mode === 'upstream' ? b.depth - a.depth : a.depth - b.depth) || rank[a.role] - rank[b.role] || byId[a.id].label.localeCompare(byId[b.id].label);
  });
  return steps;
}
`;

const SCRIPT = `${TRACE_JS}
(function () {
  var D = JSON.parse(document.getElementById('data').textContent);
  var byId = {}; D.nodes.forEach(function (n) { byId[n.id] = n; });
  // uses/usedBy: code coupling (calls, imports, reads). Data flow is kept apart: reads/writes per file.
  var uses = {}, usedBy = {}, callsOf = {}, calledBy = {}, readsOf = {}, readBy = {}, writesOf = {}, writtenBy = {};
  function add(map, key, value) { (map[key] = map[key] || []).push(value); }
  D.edges.forEach(function (e) {
    if (!byId[e.s] || !byId[e.t]) return;
    if (e.rel === 'writes') { add(writesOf, e.s, e.t); add(writtenBy, e.t, e.s); return; } // a producer does not depend on its product
    add(uses, e.s, e.t); add(usedBy, e.t, e.s);
    if (e.rel === 'reads') { add(readsOf, e.s, e.t); add(readBy, e.t, e.s); } else { add(callsOf, e.s, e.t); add(calledBy, e.t, e.s); }
  });
  var flow = buildFlow(D);
  var trace = null;
  var panel = document.getElementById('panel');
  var svg = document.querySelector('#diagram svg');
  var stage = document.getElementById('diagram');
  var selected = null;
  var impactOn = false;
  // Inside a VS Code webview this gives a way to ask the editor to open a file; elsewhere it is null.
  var vscodeApi = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : null;
  var READABLE_WIDTH = 700;

  function el(tag, props, kids) {
    var node = document.createElement(tag);
    for (var k in props) { if (k === 'class') node.className = props[k]; else if (k === 'text') node.textContent = props[k]; else node.setAttribute(k, props[k]); }
    (kids || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }
  function uniq(list) { return list.filter(function (v, i) { return list.indexOf(v) === i; }); }
  function chipList(ids) {
    var wrap = el('div');
    if (!ids.length) { wrap.appendChild(el('p', { class: 'muted', text: 'None' })); return wrap; }
    uniq(ids).forEach(function (id) {
      var b = el('button', { class: 'chip', type: 'button', text: byId[id].label });
      b.addEventListener('click', function () { select(id, true); });
      wrap.appendChild(b);
    });
    return wrap;
  }

  /* ---- viewBox pan / zoom ---- */
  var base = svg.getAttribute('viewBox').split(' ').map(Number);
  var view = base.slice();
  function apply() { svg.setAttribute('viewBox', view.join(' ')); }
  function zoomAt(factor, cx, cy) {
    var nw = Math.min(base[2] * 4, Math.max(base[2] / 8, view[2] * factor));
    var f = nw / view[2];
    view = [cx - (cx - view[0]) * f, cy - (cy - view[1]) * f, nw, view[3] * f];
    apply();
  }
  function toSvg(clientX, clientY) {
    var r = svg.getBoundingClientRect();
    var scale = Math.max(view[2] / r.width, view[3] / r.height);
    return [view[0] + (clientX - r.left - (r.width - view[2] / scale) / 2) * scale, view[1] + (clientY - r.top - (r.height - view[3] / scale) / 2) * scale, scale];
  }
  stage.addEventListener('wheel', function (e) { e.preventDefault(); var p = toSvg(e.clientX, e.clientY); zoomAt(e.deltaY < 0 ? 0.85 : 1.18, p[0], p[1]); }, { passive: false });
  var drag = null, moved = 0, pinch = null;
  var pointers = {};
  function pointerList() { return Object.keys(pointers).map(function (k) { return pointers[k]; }); }
  function distance(p, q) { return Math.sqrt((p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y)); }
  stage.addEventListener('pointerdown', function (e) {
    pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var all = pointerList();
    if (all.length === 2) { pinch = { dist: distance(all[0], all[1]) }; drag = null; moved = 99; return; } // two fingers: zoom, never a tap
    drag = { x: e.clientX, y: e.clientY, v: view.slice() }; moved = 0;
  });
  window.addEventListener('pointermove', function (e) {
    if (pointers[e.pointerId]) pointers[e.pointerId] = { x: e.clientX, y: e.clientY };
    var all = pointerList();
    if (pinch && all.length === 2) {
      var d = distance(all[0], all[1]);
      if (pinch.dist > 0 && d > 0) {
        var mid = toSvg((all[0].x + all[1].x) / 2, (all[0].y + all[1].y) / 2);
        zoomAt(pinch.dist / d, mid[0], mid[1]); // fingers apart (d grows) -> zoom in
      }
      pinch.dist = d;
      return;
    }
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    if (moved > 4) stage.classList.add('drag');
    var s = toSvg(0, 0)[2];
    view = [drag.v[0] - dx * s, drag.v[1] - dy * s, drag.v[2], drag.v[3]];
    apply();
  });
  function endPointer(e) {
    delete pointers[e.pointerId];
    var rest = pointerList();
    pinch = null;
    // One finger left after a pinch: carry on dragging from where it is, without a jump.
    drag = rest.length === 1 ? { x: rest[0].x, y: rest[0].y, v: view.slice() } : null;
    stage.classList.remove('drag');
  }
  window.addEventListener('pointerup', endPointer);
  window.addEventListener('pointercancel', endPointer);
  if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
    document.getElementById('hint').textContent = 'Drag to pan · pinch or use + / − to zoom · tap a component';
  }
  function center(id) {
    var g = svg.querySelector('g.node[data-id="' + id + '"]');
    if (!g) return;
    var b = g.getBBox();
    // On a large map, zoom in far enough to read the component; never zoom out.
    var r = svg.getBoundingClientRect();
    var w = Math.min(view[2], READABLE_WIDTH), h = w * (r.height / r.width);
    view = [b.x + b.width / 2 - w / 2, b.y + b.height / 2 - h / 2, w, h];
    apply();
  }
  document.getElementById('zin').addEventListener('click', function () { zoomAt(0.8, view[0] + view[2] / 2, view[1] + view[3] / 2); });
  document.getElementById('zout').addEventListener('click', function () { zoomAt(1.25, view[0] + view[2] / 2, view[1] + view[3] / 2); });
  document.getElementById('zfit').addEventListener('click', function () { view = base.slice(); apply(); });

  /* ---- selection ---- */
  svg.addEventListener('click', function (e) {
    if (moved > 4) return;
    var g = e.target.closest ? e.target.closest('g.node') : null;
    if (g) select(g.getAttribute('data-id'), false); else showGuide();
  });
  function select(id, recenter) {
    selected = id;
    trace = null;
    svg.querySelectorAll('g.node').forEach(function (g) { g.classList.toggle('sel', g.getAttribute('data-id') === id); });
    if (recenter) center(id);
    applyImpact();
    showNode(byId[id]);
  }

  /* ---- blast radius: everything that depends on the selected component, nearest first ---- */
  function impactOf(id) {
    var depth = {}; depth[id] = 0;
    var queue = [id];
    while (queue.length) {
      var x = queue.shift();
      (usedBy[x] || []).forEach(function (p) { if (depth[p] === undefined) { depth[p] = depth[x] + 1; queue.push(p); } });
    }
    return depth;
  }
  var SVG_NS = 'http://www.w3.org/2000/svg';
  function clearBadges() { svg.querySelectorAll('.tbadge').forEach(function (b) { b.remove(); }); }
  function applyImpact() {
    svg.querySelectorAll('g.node').forEach(function (g) { g.classList.remove('imp-direct', 'imp-indirect', 'dim', 'trace'); });
    clearBadges();
    // A data-flow trace takes precedence over the blast-radius glow.
    if (trace) {
      var order = {};
      trace.steps.forEach(function (s, i) { order[s.id] = i + 1; });
      svg.querySelectorAll('g.node').forEach(function (g) {
        var id = g.getAttribute('data-id');
        if (order[id] === undefined) return void g.classList.add('dim');
        g.classList.add('trace');
        var box = g.querySelector('rect');
        if (!box) return;
        var cx = Number(box.getAttribute('x')), cy = Number(box.getAttribute('y'));
        var badge = document.createElementNS(SVG_NS, 'g');
        badge.setAttribute('class', 'tbadge');
        var disc = document.createElementNS(SVG_NS, 'circle');
        disc.setAttribute('cx', cx); disc.setAttribute('cy', cy); disc.setAttribute('r', 12); disc.setAttribute('fill', '#06b6d4');
        var num = document.createElementNS(SVG_NS, 'text');
        num.setAttribute('x', cx); num.setAttribute('y', cy + 4); num.setAttribute('text-anchor', 'middle');
        num.setAttribute('font-size', '12'); num.setAttribute('font-weight', '700'); num.setAttribute('fill', '#09090b');
        num.textContent = String(order[id]);
        badge.appendChild(disc); badge.appendChild(num); g.appendChild(badge);
      });
      return;
    }
    if (!impactOn || !selected) return;
    var depth = impactOf(selected);
    svg.querySelectorAll('g.node').forEach(function (g) {
      var id = g.getAttribute('data-id');
      if (id === selected) return;
      var d = depth[id];
      g.classList.add(d === undefined ? 'dim' : d === 1 ? 'imp-direct' : 'imp-indirect');
    });
  }

  /* ---- panels ---- */
  function showGuide() {
    selected = null;
    trace = null;
    svg.querySelectorAll('g.node.sel').forEach(function (g) { g.classList.remove('sel'); });
    applyImpact();
    panel.textContent = '';
    panel.appendChild(el('h2', { text: D.name }));
    if (D.description) panel.appendChild(el('p', { class: 'muted', text: D.description }));
    panel.appendChild(el('p', { text: D.guide.headline }));
    panel.appendChild(el('h3', { text: 'Suggested reading order' }));
    var list = el('ol', { class: 'steps' });
    D.guide.path.forEach(function (s, i) {
      var n = byId[s.id];
      var b = el('button', { class: 'step', type: 'button' }, [el('b', { text: (i + 1) + '. ' + n.label }), el('span', { text: s.why })]);
      b.addEventListener('click', function () { select(s.id, true); });
      list.appendChild(el('li', {}, [b]));
    });
    panel.appendChild(list);
    if (D.guide.omitted) panel.appendChild(el('p', { class: 'muted', text: '...and ' + D.guide.omitted + ' more components. Use search to find them.' }));
  }
  function showNode(n) {
    panel.textContent = '';
    var back = el('button', { class: 'back', type: 'button', text: '< Reading order' });
    back.addEventListener('click', showGuide);
    panel.appendChild(back);
    panel.appendChild(el('h2', { text: n.label }));
    var kind = D.kinds[n.kind] || { label: n.kind, color: '#a1a1aa' };
    var k = el('span', { class: 'kind', text: kind.label }); k.style.color = kind.color;
    panel.appendChild(k);
    panel.appendChild(el('p', { class: 'path', text: n.filePath }));
    var total = Object.keys(impactOf(n.id)).length - 1;
    var impactBtn = el('button', { class: 'action' + (impactOn ? ' on' : ''), type: 'button', text: (impactOn ? 'Hide' : 'Highlight') + ' what depends on this (' + total + ')' });
    impactBtn.addEventListener('click', function () { impactOn = !impactOn; applyImpact(); showNode(n); });
    var actions = el('div', { class: 'actions' }, [impactBtn]);
    if (vscodeApi) {
      var openBtn = el('button', { class: 'action', type: 'button', text: 'Open in editor' });
      openBtn.addEventListener('click', function () { vscodeApi.postMessage({ type: 'open', path: n.filePath }); });
      actions.appendChild(openBtn);
    }
    panel.appendChild(actions);
    if (n.description) panel.appendChild(el('p', { text: n.description }));
    panel.appendChild(el('h3', { text: 'Change risk ' + n.score + ' / 100' }));
    panel.appendChild(el('p', { class: n.score >= 35 ? 'warn' : 'muted', text: n.reasons.length ? n.reasons.join(' - ') : 'Few connections, low risk.' }));
    if (D.hasData) panel.appendChild(traceSection(n));
    var groups = n.kind === 'data'
      ? [['Written by', writtenBy], ['Read by', readBy]]
      : D.hasData ? [['Used by', calledBy], ['Calls', callsOf], ['Reads', readsOf], ['Writes', writesOf]] : [['Used by', usedBy], ['Uses', uses]];
    groups.forEach(function (g) { panel.appendChild(el('h3', { text: g[0] })); panel.appendChild(chipList(g[1][n.id] || [])); });
    if (n.exports.length) {
      panel.appendChild(el('h3', { text: 'Exports' }));
      var ex = el('div'); n.exports.forEach(function (x) { ex.appendChild(el('span', { class: 'chip', text: x })); }); panel.appendChild(ex);
    }
    if (n.kind !== 'data' || n.code.trim()) {
      panel.appendChild(el('h3', { text: 'Source' }));
      panel.appendChild(el('pre', { text: n.code }));
    }
  }

  var ROLE_TEXT = { input: 'raw input', produced: 'produced file', code: 'code', target: 'selected' };
  function names(steps) { return steps.map(function (s) { return byId[s.id].label; }).join(', '); }
  /** "Where it comes from" / "What it affects": numbered on the map, listed here. */
  function traceSection(n) {
    var wrap = el('div');
    wrap.appendChild(el('h3', { text: 'Data flow' }));
    var row = el('div', { class: 'actions' });
    [['upstream', 'Where it comes from'], ['downstream', 'What it affects']].forEach(function (m) {
      var on = !!trace && trace.id === n.id && trace.mode === m[0];
      var b = el('button', { class: 'action' + (on ? ' on' : ''), type: 'button', text: m[1] });
      b.addEventListener('click', function () {
        trace = on ? null : { id: n.id, mode: m[0], steps: traceFrom(D, flow, n.id, m[0]) };
        applyImpact();
        showNode(n);
      });
      row.appendChild(b);
    });
    wrap.appendChild(row);
    if (!trace || trace.id !== n.id) return wrap;

    var others = trace.steps.filter(function (s) { return s.id !== n.id; });
    var summary;
    if (trace.mode === 'upstream') {
      var raw = others.filter(function (s) { return s.role === 'input'; });
      summary = others.length ? n.label + ' comes from ' + others.length + ' other component' + (others.length === 1 ? '' : 's') + (raw.length ? ', starting from ' + raw.length + ' raw input file' + (raw.length === 1 ? '' : 's') + ': ' + names(raw) + '.' : ', with no raw input file in the map.') : 'Nothing in the map leads to ' + n.label + '.';
    } else {
      var results = others.filter(function (s) { return byId[s.id].kind === 'data'; });
      summary = results.length ? results.length + ' result file' + (results.length === 1 ? '' : 's') + ' would be out of date if ' + n.label + ' changed: ' + names(results) + '.' : 'Nothing is produced downstream of ' + n.label + '.';
    }
    wrap.appendChild(el('p', { text: summary }));
    var list = el('ol', { class: 'trace-steps' });
    trace.steps.forEach(function (s, i) {
      var b = el('button', { class: 'tstep', type: 'button' }, [el('span', { text: (i + 1) + '. ' + byId[s.id].label }), el('i', { text: ROLE_TEXT[s.role] })]);
      b.addEventListener('click', function () { center(s.id); });
      list.appendChild(el('li', {}, [b]));
    });
    wrap.appendChild(list);
    return wrap;
  }

  /* ---- search ---- */
  var search = document.getElementById('search');
  function matches(n, q) { return n.label.toLowerCase().indexOf(q) >= 0 || n.filePath.toLowerCase().indexOf(q) >= 0 || n.exports.some(function (x) { return x.toLowerCase().indexOf(q) >= 0; }); }
  search.addEventListener('input', function () {
    var q = search.value.trim().toLowerCase();
    svg.querySelectorAll('g.node').forEach(function (g) {
      var n = byId[g.getAttribute('data-id')];
      g.style.opacity = !q || matches(n, q) ? '' : '0.15';
    });
  });
  search.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var q = search.value.trim().toLowerCase();
    var hit = q && D.nodes.filter(function (n) { return matches(n, q); })[0];
    if (hit) select(hit.id, true);
  });
  window.addEventListener('keydown', function (e) {
    if (e.key === '/' && document.activeElement !== search) { e.preventDefault(); search.focus(); }
    if (e.key === 'Escape') { search.value = ''; search.dispatchEvent(new Event('input')); search.blur(); showGuide(); }
  });

  /* ---- VS Code bridge: the editor tells the map which file is open ---- */
  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.type !== 'focus') return;
    var hit = D.nodes.filter(function (n) { return n.filePath === m.path; })[0];
    if (!hit) return;
    impactOn = true;
    select(hit.id, true);
  });
  if (vscodeApi) vscodeApi.postMessage({ type: 'ready' });

  showGuide();
})();
`;
