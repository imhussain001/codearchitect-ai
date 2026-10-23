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
const SCRIPT = `
(function () {
  var D = JSON.parse(document.getElementById('data').textContent);
  var byId = {}; D.nodes.forEach(function (n) { byId[n.id] = n; });
  var uses = {}, usedBy = {};
  D.edges.forEach(function (e) {
    if (!byId[e.s] || !byId[e.t]) return;
    (uses[e.s] = uses[e.s] || []).push(e.t);
    (usedBy[e.t] = usedBy[e.t] || []).push(e.s);
  });
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
  var drag = null, moved = 0;
  stage.addEventListener('pointerdown', function (e) { drag = { x: e.clientX, y: e.clientY, v: view.slice() }; moved = 0; });
  window.addEventListener('pointermove', function (e) {
    if (!drag) return;
    var dx = e.clientX - drag.x, dy = e.clientY - drag.y;
    moved = Math.max(moved, Math.abs(dx) + Math.abs(dy));
    if (moved > 4) stage.classList.add('drag');
    var s = toSvg(0, 0)[2];
    view = [drag.v[0] - dx * s, drag.v[1] - dy * s, drag.v[2], drag.v[3]];
    apply();
  });
  window.addEventListener('pointerup', function () { drag = null; stage.classList.remove('drag'); });
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
  function applyImpact() {
    svg.querySelectorAll('g.node').forEach(function (g) { g.classList.remove('imp-direct', 'imp-indirect', 'dim'); });
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
    panel.appendChild(el('h3', { text: 'Used by' })); panel.appendChild(chipList(usedBy[n.id] || []));
    panel.appendChild(el('h3', { text: 'Uses' })); panel.appendChild(chipList(uses[n.id] || []));
    if (n.exports.length) {
      panel.appendChild(el('h3', { text: 'Exports' }));
      var ex = el('div'); n.exports.forEach(function (x) { ex.appendChild(el('span', { class: 'chip', text: x })); }); panel.appendChild(ex);
    }
    panel.appendChild(el('h3', { text: 'Source' }));
    panel.appendChild(el('pre', { text: n.code }));
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
