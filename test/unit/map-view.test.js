'use strict';
// The map view: the rail destination, the canvas, and the warming state.
//
// The pure rules live in public/graph-model.js and are pressed by
// test/unit/graph-model.test.js. This file presses what is left: the vendored
// layout library and its load order, the view's rendering and event handling
// against a recording canvas, and the way the view leaves when the reader
// does.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf-8');
const INDEX_SRC = read('public', 'index.html');

// ===== THE VENDORED LAYOUT =====
//
// d3-force's UMD build declares d3-quadtree, d3-dispatch and d3-timer as
// externals and reads them off the d3 global at call time, so all four files
// must ship and the three siblings must load first. The README is held to the
// files on disk rather than trusted: a table that says one hash while the
// file says another is the exact drift a provenance record exists to catch.
describe('the vendored layout library', () => {
  const VENDOR = path.join(ROOT, 'public', 'vendor', 'd3-force');
  const PACKAGES = [
    ['d3-quadtree', '3.0.1'],
    ['d3-dispatch', '3.0.1'],
    ['d3-timer', '3.0.1'],
    ['d3-force', '3.0.0'],
  ];
  const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

  test('the four files ship with their licence and a provenance record', () => {
    for (const [name] of PACKAGES) {
      assert.ok(fs.existsSync(path.join(VENDOR, `${name}.min.js`)), `${name}.min.js ships`);
    }
    const licence = fs.readFileSync(path.join(VENDOR, 'LICENSE.txt'), 'utf-8');
    assert.match(licence, /Permission to use, copy, modify, and\/or distribute this software for any purpose/,
      'the licence file carries the ISC text');
    assert.match(licence, /Mike Bostock/, 'and names the copyright holder');
    const readme = fs.readFileSync(path.join(VENDOR, 'README.md'), 'utf-8');
    assert.match(readme, /Upstream/, 'the README names the upstream');
  });

  test('the provenance table records both registry hashes and the hash of every extracted file, and the file hashes are true', () => {
    const readme = fs.readFileSync(path.join(VENDOR, 'README.md'), 'utf-8');
    for (const [name, version] of PACKAGES) {
      const section = readme.slice(readme.indexOf(`| ${name} |`));
      assert.ok(section.length > 0, `the README carries a provenance row for ${name}`);
      assert.match(readme, new RegExp(`\\| ${name} \\| ${version.replace(/\./g, '\\.')} \\|`),
        `the row names the version vendored for ${name}`);
      // The registry publishes SHA-1 as forty hex characters and SHA-512 as
      // base64; the table records both so either can be checked.
      const row = readme.split('\n').find(l => l.startsWith(`| ${name} | ${version}`));
      assert.ok(row, `one row per package for ${name}`);
      assert.match(row, /`[0-9a-f]{40}`/, `${name}'s row carries the tarball SHA-1`);
      assert.match(row, /`[A-Za-z0-9+/]{86}==`/, `${name}'s row carries the tarball SHA-512`);
      const expected = sha256(path.join(VENDOR, `${name}.min.js`));
      assert.ok(row.includes(expected),
        `${name}'s row records the SHA-256 of the extracted file as it is on disk (${expected})`);
    }
    assert.match(readme, /checked\s+against\s+the\s+registry'?s\s+(own\s+)?metadata/i,
      'the README states that both hashes were checked against the registry metadata');
    assert.match(readme, /\b20\d\d-\d\d-\d\d\b/, 'and dates the check');
  });

  test('index.html loads quadtree, dispatch and timer before force, and all four before the view', () => {
    const scripts = [...INDEX_SRC.replace(/<!--[\s\S]*?-->/g, '').matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
    const at = (src) => {
      const i = scripts.indexOf(src);
      assert.ok(i !== -1, `index.html loads ${src}`);
      return i;
    };
    const quadtree = at('/vendor/d3-force/d3-quadtree.min.js');
    const dispatch = at('/vendor/d3-force/d3-dispatch.min.js');
    const timer = at('/vendor/d3-force/d3-timer.min.js');
    const force = at('/vendor/d3-force/d3-force.min.js');
    assert.ok(quadtree < force && dispatch < force && timer < force,
      'the three siblings load before force, which reads them off the d3 global when called');
    const viewScript = at('/views/graph.js');
    assert.ok(force < viewScript, 'the layout library loads before the view that calls it');
    const modelScript = at('/graph-model.js');
    assert.ok(modelScript < viewScript, 'and so does the model the view is built on');
    assert.ok(viewScript < at('/app.js'), 'and the view before the client that hands the rail to it');
  });

  test('loaded in that order into one window, the four files compose one d3 object with the layout on it', () => {
    const dom = new JSDOM('<!doctype html><body></body>', { runScripts: 'outside-only' });
    for (const name of ['d3-quadtree', 'd3-dispatch', 'd3-timer', 'd3-force']) {
      dom.window.eval(fs.readFileSync(path.join(VENDOR, `${name}.min.js`), 'utf-8'));
    }
    const d3 = dom.window.d3;
    for (const fn of ['forceSimulation', 'forceManyBody', 'forceLink', 'forceX', 'forceY', 'forceCollide', 'forceRadial', 'quadtree', 'dispatch', 'timer']) {
      assert.strictEqual(typeof d3[fn], 'function', `d3.${fn} is callable`);
    }
    // A simulation actually ticks with the siblings wired: forceManyBody
    // reaches for quadtree and the timer on construction.
    const nodes = [{ x: 0, y: 0 }, { x: 1, y: 1 }];
    const sim = d3.forceSimulation(nodes).force('charge', d3.forceManyBody()).stop();
    sim.tick(3);
    assert.ok(Number.isFinite(nodes[0].x) && nodes[0].x !== nodes[1].x, 'three ticks of repulsion moved the two nodes apart');
    dom.window.close();
  });
});

// ===== THE INDEX ARRIVING =====
//
// The server announces its index warm-up on the system channel. The map and
// the open file's connections both drew a warming state in its absence, so
// its arrival is news for two surfaces, and the client's dispatch is what
// carries it to them. The arm is cut out of app.js and RUN rather than
// matched, so a dispatch that names the wrong state or drops one surface
// fails here by behaviour.
describe('the index reporting ready redraws the active map and the open file\'s connections', () => {
  const APP_SRC = read('public', 'app.js');
  function searchIndexArm() {
    const system = /case 'system':([\s\S]*?)\n    case '/.exec(APP_SRC);
    assert.ok(system, 'app.js no longer carries a system case');
    const arm = /^\s*if\(d\.subtype==='search_index'.*$/m.exec(system[1]);
    assert.ok(arm, 'app.js no longer carries the search_index arm inside the system case');
    // eslint-disable-next-line no-new-func
    return new Function('d', 'mapIndexReady', 'fileConnectionsIndexReady', arm[0]);
  }

  test('ready calls both redraws; indexing calls neither', () => {
    const arm = searchIndexArm();
    const calls = [];
    const map = () => calls.push('map');
    const files = () => calls.push('files');
    arm({ type: 'system', subtype: 'search_index', state: 'ready' }, map, files);
    assert.deepStrictEqual(calls.sort(), ['files', 'map']);
    calls.length = 0;
    arm({ type: 'system', subtype: 'search_index', state: 'indexing' }, map, files);
    assert.deepStrictEqual(calls, [], 'the start of a warm-up redraws nothing: there is nothing new to draw');
    arm({ type: 'system', subtype: 'done', state: 'ready' }, map, files);
    assert.deepStrictEqual(calls, [], 'and another subtype carrying a state word is not the index');
  });

  test('the arm survives a surface that has not loaded, so the dispatch cannot throw on a page without the map', () => {
    const arm = searchIndexArm();
    assert.doesNotThrow(() => arm({ type: 'system', subtype: 'search_index', state: 'ready' }, undefined, undefined));
  });
});

// ===== THE RAIL DESTINATION =====
//
// A rail destination is a lockstep edit across the page and the client, and
// the doors manifest holds most of it. What it does not hold is the order
// and the name: Map sits last, under Files (and under Pins once that slot
// exists), is labelled Map, and is keyed `map` everywhere. The prototype
// keyed it `graph` and labelled it Map, and that mismatch is the one thing a
// reader of the rail would never see and a reader of the code would trip on.
describe('the rail destination is keyed map, labelled Map, and last', () => {
  const APP_SRC = read('public', 'app.js');
  const page = INDEX_SRC.replace(/<!--[\s\S]*?-->/g, '');
  const rail = [...page.matchAll(/<button class="nav-item[^"]*" data-nav="([\w-]+)"/g)].map(m => m[1]);

  test('Map is the last main-rail entry, directly below Files or below the Pins slot when that exists', () => {
    assert.ok(rail.length >= 6, `sanity: the rail carries ${rail.length} entries`);
    const main = rail.filter(n => n !== 'settings');
    assert.strictEqual(main[main.length - 1], 'map', `Map is last among ${main.join(', ')}`);
    const files = main.indexOf('files');
    assert.ok(files !== -1, 'Files is on the rail');
    const between = main.slice(files + 1, main.length - 1);
    assert.ok(between.every(n => n === 'pins'), `nothing but the Pins slot sits between Files and Map (found ${between.join(', ') || 'nothing'})`);
  });

  test('the entry is labelled Map and its handler goes through switchNav', () => {
    const button = /<button class="nav-item" data-nav="map" onclick="switchNav\('map'\)" data-tooltip="Map">/.exec(page);
    assert.ok(button, 'the rail button is keyed map, labelled Map, and switches through the one router');
    assert.ok(/<div id="sidebar-map" class="hidden"><\/div>/.test(page), 'the (empty) sidebar panel exists so the router can address it');
    assert.ok(/<div id="view-map" class="hidden view-panel"/.test(page), 'the pane exists for showView to reveal');
  });

  test('map is in every list the mechanism reads, and graph survives in none of them', () => {
    const navTable = /const NAV_FOR_VIEW = \{([\s\S]*?)\n\};/.exec(APP_SRC);
    assert.ok(navTable, 'app.js carries NAV_FOR_VIEW');
    assert.match(navTable[1], /\n  map: 'map',/, 'the map view lands the rail on the map section');
    const panels = /\[([^\]]*)\]\.forEach\(s=>document\.getElementById\(`sidebar-\$\{s\}`\)/.exec(APP_SRC);
    assert.ok(panels, 'app.js carries the one panel list');
    assert.ok(panels[1].includes("'map'"), 'the panel list names the map panel');
    const panes = /function showView\(v\) \{ currentView=v; \[([^\]]*)\]\.forEach/.exec(APP_SRC);
    assert.ok(panes, 'app.js carries the one pane list');
    assert.ok(panes[1].includes("'map'"), 'the pane list names the map pane');
    assert.ok(/else if\(nav==='map'\)/.test(APP_SRC), 'switchNav has an arm for map');
    for (const [label, src] of [['index.html', page], ['app.js', APP_SRC]]) {
      assert.ok(!/data-nav="graph"|sidebar-graph|view-graph|nav==='graph'|\bgraph: 'graph'|'graph'\]/.test(src),
        `no graph id survives in ${label}'s nav wiring`);
    }
  });
});

// ===== THE VIEW =====
//
// Rendering and events only, on the model. The shell below is the map pane
// cut out of index.html (so the markup the view builds into is the real one),
// a recording canvas context in place of the one jsdom does not have, a fake
// d3 whose simulation records what is asked of it and ticks on demand, and
// every app-owned global the view reaches for. What runs is the real view.
function recordingContext() {
  const calls = [];
  const state = { globalAlpha: 1, globalCompositeOperation: 'source-over', fillStyle: '', strokeStyle: '', lineWidth: 1, font: '', textAlign: '', textBaseline: '' };
  const snapshot = () => ({ alpha: state.globalAlpha, composite: state.globalCompositeOperation, fill: state.fillStyle, stroke: state.strokeStyle });
  return new Proxy(state, {
    get(t, prop) {
      if (prop === 'calls') return calls;
      if (prop in t) return t[prop];
      if (prop === 'measureText') return (text) => ({ width: String(text).length * 6 });
      if (typeof prop === 'symbol') return undefined;
      return (...args) => { calls.push({ name: prop, args, ...snapshot() }); };
    },
    set(t, prop, v) { t[prop] = v; return true; },
  });
}

function fakeD3() {
  const chain = () => {
    const o = {};
    for (const m of ['strength', 'distanceMax', 'theta', 'distance', 'radius', 'iterations', 'x', 'y', 'id']) o[m] = () => o;
    return o;
  };
  const sims = [];
  return {
    sims,
    forceSimulation(nodes) {
      // A layout separates nodes; this fake does the least that a hit-test
      // needs: every node on its own point.
      nodes.forEach((n, i) => { n.x += (i % 4) * 80; n.y += Math.floor(i / 4) * 80; });
      const sim = {
        nodes, stopped: 0, forces: {}, handlers: {}, alphaValue: 0,
        force(name, f) { sim.forces[name] = f; return sim; },
        alphaDecay(v) { sim.decay = v; return sim; },
        velocityDecay() { return sim; },
        alpha() { return sim.alphaValue; },
        on(name, fn) { sim.handlers[name] = fn; return sim; },
        stop() { sim.stopped += 1; return sim; },
        restart() { return sim; },
        tick() { for (const [name, fn] of Object.entries(sim.handlers)) if (name.startsWith('tick')) fn(); },
        end() { for (const [name, fn] of Object.entries(sim.handlers)) if (name.startsWith('end')) fn(); },
      };
      sims.push(sim);
      return sim;
    },
    forceManyBody: chain, forceLink: chain, forceX: chain, forceY: chain, forceCollide: chain, forceRadial: chain,
  };
}

const VIEW_PAYLOAD = {
  indexed: true, warming: false,
  nodes: [
    { path: 'Hub.md', name: 'Hub.md', modified: 5000 }, { path: 'A.md', name: 'A.md', modified: 4000 },
    { path: 'B.md', name: 'B.md', modified: 3000 }, { path: 'C.md', name: 'C.md', modified: 2000 },
    { path: 'pair/One.md', name: 'One.md', modified: 1000 }, { path: 'pair/Two.md', name: 'Two.md', modified: 900 },
    { path: 'Lonely.md', name: 'Lonely.md', modified: 800 }, { path: 'inbox/Scratch.md', name: 'Scratch.md', modified: null },
  ],
  links: [
    { src: 'Hub.md', target: 'A', kind: 'wikilink', resolved: 'A.md' },
    { src: 'Hub.md', target: 'B', kind: 'wikilink', resolved: 'B.md' },
    { src: 'Hub.md', target: 'C', kind: 'wikilink', resolved: 'C.md' },
    { src: 'A.md', target: 'Hub', kind: 'wikilink', resolved: 'Hub.md' },
    { src: 'A.md', target: 'B', kind: 'wikilink', resolved: 'B.md' },
    { src: 'pair/One.md', target: 'Two', kind: 'wikilink', resolved: 'pair/Two.md' },
    { src: 'B.md', target: 'Nowhere', kind: 'wikilink', resolved: null },
  ],
};

function mapShell(opts = {}) {
  const pane = /<div id="view-map" class="hidden view-panel">[\s\S]*?\n    <\/div>\n    <!-- Editor -->/.exec(INDEX_SRC);
  assert.ok(pane, 'index.html no longer carries the map pane');
  const dom = new JSDOM(`<!doctype html><body>
    <aside class="sidebar"><div id="sidebar-map" class="hidden"></div><div id="sidebar-files" class="hidden"></div></aside>
    ${pane[0].replace('<!-- Editor -->', '')}
    <div id="view-editor" class="hidden view-panel"></div>
  </body>`, { url: 'http://localhost/' + (opts.search || '') });
  const w = dom.window;
  const ctx = recordingContext();
  w.HTMLCanvasElement.prototype.getContext = () => ctx;
  w.HTMLElement.prototype.getBoundingClientRect = function () { return { left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }; };
  const d3 = fakeD3();
  const opened = [];
  const rafs = { pending: new Map(), next: 1, cancelled: [] };
  const listeners = { added: [], removed: [] };
  const origAdd = w.addEventListener.bind(w), origRemove = w.removeEventListener.bind(w);
  // jsdom registers a few internal handlers of its own on the window; they
  // are not the view's and are told apart by their private-field bodies.
  const ours = (fn) => !String(fn).includes('this.#');
  w.addEventListener = (type, fn, o) => { if (ours(fn)) listeners.added.push([type, fn]); origAdd(type, fn, o); };
  w.removeEventListener = (type, fn, o) => { if (ours(fn)) listeners.removed.push([type, fn]); origRemove(type, fn, o); };
  const dAdd = w.document.addEventListener.bind(w.document), dRemove = w.document.removeEventListener.bind(w.document);
  w.document.addEventListener = (type, fn, o) => { listeners.added.push(['document:' + type, fn]); dAdd(type, fn, o); };
  w.document.removeEventListener = (type, fn, o) => { listeners.removed.push(['document:' + type, fn]); dRemove(type, fn, o); };
  let payload = opts.payload || VIEW_PAYLOAD;
  const fetches = [];
  // The one computed style the view reads. Light swaps the node colour so a
  // re-read is observable, and each recency probe answers with its step.
  const styleReads = { count: 0 };
  const theme = () => (w.document.body.classList.contains('light') ? 'light' : 'dark');
  const tokens = () => ({
    '--text-2': theme() === 'light' ? 'text2-light' : 'text2-dark', '--text-1': 'text1', '--card': 'card', '--elevated': 'ground',
    '--accent': 'accent', '--graph-edge': theme() === 'light' ? 'edge-light' : 'edge-dark', '--graph-dim': '0.18', '--radius-sm': '4px', '--label': '11px',
  });
  const getComputedStyle = (el) => {
    styleReads.count += 1;
    const t = tokens();
    const m = el && el.className && /graph-recency-(\d)/.exec(el.className);
    return { color: m ? `step${m[1]}-${theme()}` : t['--text-2'], fontFamily: 'sans', getPropertyValue: (k) => t[k] || '' };
  };
  const NAV = { map: 'map', editor: 'files' };
  const stubs = {
    window: w, document: w.document, MutationObserver: w.MutationObserver, HTMLCanvasElement: w.HTMLCanvasElement,
    MouseEvent: w.MouseEvent, WheelEvent: w.WheelEvent,
    location: w.location, d3, getComputedStyle,
    requestAnimationFrame: (fn) => { const id = rafs.next++; rafs.pending.set(id, fn); return id; },
    cancelAnimationFrame: (id) => { rafs.cancelled.push(id); rafs.pending.delete(id); },
    fetch: () => { fetches.push(payload); return Promise.resolve({ ok: true, json: () => Promise.resolve(payload) }); },
    // The real showView reveals one pane and sets the section; the section
    // reveals one sidebar panel. The two classes are what the view watches.
    showView: (v) => {
      for (const el of w.document.querySelectorAll('.view-panel')) el.classList.add('hidden');
      w.document.getElementById('view-' + v).classList.remove('hidden');
      for (const el of w.document.querySelectorAll('.sidebar > div')) el.classList.add('hidden');
      const nav = NAV[v];
      if (nav) w.document.getElementById('sidebar-' + nav).classList.remove('hidden');
    },
    openWorkspaceFilePath: (p) => opened.push(p),
  };
  for (const [k, v] of Object.entries(stubs)) global[k] = v;
  const settle = () => new Promise((r) => setTimeout(r, 0)).then(() => new Promise((r) => setTimeout(r, 0)));
  // Leave the map before the window goes, so the view's module state never
  // outlives the shell it was built in.
  const cleanup = async () => {
    w.document.getElementById('sidebar-map').classList.add('hidden');
    await settle();
    for (const k of Object.keys(stubs)) delete global[k];
    w.close();
  };
  const flushFrames = () => { for (const [id, fn] of [...rafs.pending]) { rafs.pending.delete(id); fn(); } };
  const sim = () => d3.sims[d3.sims.length - 1];
  const canvas = () => w.document.querySelector('#graph-body canvas');
  const readout = () => w.document.getElementById('graph-readout').textContent;
  const mouse = (type, x, y, extra) => canvas().dispatchEvent(new w.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, ...extra }));
  const setPayload = (p) => { payload = p; };
  return { w, doc: w.document, ctx, d3, opened, rafs, listeners, fetches, styleReads, cleanup, settle, flushFrames, sim, canvas, readout, mouse, setPayload };
}

const view = require('../../public/views/graph.js');

// Every node drawn (at any zoom) so a test about a specific node can find it.
async function openZoomedIn(s) {
  view.showMapView();
  await s.settle();
  for (let i = 0; i < 12; i++) view.mapZoomIn();
  s.flushFrames();
}

describe('arrival: one fetch, one canvas, no sidebar', () => {
  test('arriving fetches the graph once and builds one canvas filling the pane', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      assert.strictEqual(s.fetches.length, 1, 'one fetch per arrival');
      const canvases = s.doc.querySelectorAll('#view-map canvas');
      assert.strictEqual(canvases.length, 1, 'one Canvas 2D element');
      assert.strictEqual(canvases[0].width, 800, 'sized to the pane it fills');
      assert.strictEqual(canvases[0].height, 600);
      assert.ok(!s.doc.getElementById('view-map').classList.contains('hidden'), 'the pane is shown');
      assert.ok(!s.doc.getElementById('sidebar-map').classList.contains('hidden'), 'the (empty) map panel is the visible one; the stylesheet hides the aside while it is');
      assert.strictEqual(s.d3.sims.length, 1, 'one simulation started');
      assert.strictEqual(s.sim().nodes.length, 8, 'over every node');
    } finally { await s.cleanup(); }
  });

  test('the readout counts files, connections and the unlinked, and states the hidden count with the phrase that zoom reveals them', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      s.flushFrames();
      assert.match(s.readout(), /^8 files · 5 connections · 2 unlinked/);
      assert.match(s.readout(), /hidden, zoom to reveal/, 'at the fit zoom the leaves wait for the zoom');
      for (let i = 0; i < 12; i++) view.mapZoomIn();
      s.flushFrames();
      assert.ok(!/hidden/.test(s.readout()), 'zoomed in, everything is drawn and the phrase goes');
    } finally { await s.cleanup(); }
  });

  test('edges are drawn only for links whose resolution is non-null, duplicate pairs collapsed', async () => {
    const s = mapShell();
    try {
      await openZoomedIn(s);
      s.ctx.calls.length = 0;
      s.flushFrames();
      view.mapZoomIn();
      s.flushFrames();
      const segments = s.ctx.calls.filter(c => c.name === 'lineTo');
      assert.strictEqual(segments.length, 5, 'five distinct resolved pairs, one segment each');
    } finally { await s.cleanup(); }
  });

  test('a payload with indexed:false draws the no-index statement in place of a canvas', async () => {
    const s = mapShell({ payload: { indexed: false, nodes: [], links: [] } });
    try {
      view.showMapView();
      await s.settle();
      assert.strictEqual(s.doc.querySelector('#view-map canvas'), null, 'no canvas');
      assert.match(s.doc.getElementById('graph-body').textContent, /search index/);
      assert.strictEqual(s.d3.sims.length, 0, 'and no simulation');
    } finally { await s.cleanup(); }
  });

  test('a workspace with no links says so rather than drawing an empty picture', async () => {
    const s = mapShell({ payload: { indexed: true, warming: false, nodes: [{ path: 'a.md', name: 'a.md', modified: 1 }], links: [] } });
    try {
      view.showMapView();
      await s.settle();
      assert.match(s.doc.getElementById('graph-body').textContent, /Nothing is linked yet/);
      assert.strictEqual(s.doc.querySelector('#view-map canvas'), null);
    } finally { await s.cleanup(); }
  });
});

describe('warming: the third state', () => {
  test('warming:true draws the still-being-indexed statement, and the index reporting ready rebuilds from a fresh fetch', async () => {
    const s = mapShell({ payload: { ...VIEW_PAYLOAD, warming: true } });
    try {
      view.showMapView();
      await s.settle();
      assert.match(s.doc.getElementById('graph-body').textContent, /still being indexed/);
      assert.strictEqual(s.doc.querySelector('#view-map canvas'), null, 'no canvas while the answer is still arriving');
      s.setPayload(VIEW_PAYLOAD);
      view.mapIndexReady();
      await s.settle();
      assert.strictEqual(s.fetches.length, 2, 'ready is news: fetched again');
      assert.ok(s.doc.querySelector('#view-map canvas'), 'and the map is drawn');
      // Away from the map, ready is not news for it.
      s.doc.getElementById('sidebar-map').classList.add('hidden');
      await s.settle();
      view.mapIndexReady();
      await s.settle();
      assert.strictEqual(s.fetches.length, 2, 'an inactive map does not fetch');
    } finally { await s.cleanup(); }
  });
});

describe('labels on hover only, through the one visibility predicate', () => {
  test('with no hover nothing is written; with a hover the hovered node and its visible neighbours are, and nothing else', async () => {
    const s = mapShell();
    try {
      await openZoomedIn(s);
      s.ctx.calls.length = 0;
      s.flushFrames();
      view.mapZoomFit();
      s.flushFrames();
      assert.deepStrictEqual(s.ctx.calls.filter(c => c.name === 'fillText'), [], 'a map at rest names nothing');
      // At the fit zoom the hub is drawn and its leaves are hidden: hovering
      // it names the hub alone, because a hidden neighbour is not on screen.
      const hub = view.mapNodeScreenPosition('Hub.md');
      assert.ok(hub && hub.visible, 'the hub is on screen at rest');
      s.ctx.calls.length = 0;
      s.mouse('mousemove', hub.x, hub.y);
      s.flushFrames();
      const written = s.ctx.calls.filter(c => c.name === 'fillText').map(c => c.args[0]);
      assert.deepStrictEqual(written, ['Hub.md']);
      assert.match(s.readout(), /^Hub\.md · 3 connections$/);
      // Zoomed in, the neighbours are visible and named with it.
      for (let i = 0; i < 12; i++) view.mapZoomIn();
      s.flushFrames();
      s.mouse('mouseleave', 0, 0);
      s.flushFrames();
      const again = view.mapNodeScreenPosition('Hub.md');
      s.ctx.calls.length = 0;
      s.mouse('mousemove', again.x + 1, again.y);
      s.flushFrames();
      const names = s.ctx.calls.filter(c => c.name === 'fillText').map(c => c.args[0]).sort();
      assert.deepStrictEqual(names, ['A.md', 'B.md', 'C.md', 'Hub.md']);
    } finally { await s.cleanup(); }
  });

  test('hit-testing the exact screen position of a node the predicate hides finds no node', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      s.flushFrames();
      const c = view.mapNodeScreenPosition('C.md');
      assert.ok(c && !c.visible, 'sanity: the leaf is hidden at the fit zoom');
      s.mouse('mousemove', c.x, c.y);
      s.flushFrames();
      assert.match(s.readout(), /^8 files/, 'no hover: the readout still counts the workspace');
      assert.notStrictEqual(s.canvas().style.cursor, 'pointer');
      s.mouse('click', c.x, c.y);
      assert.deepStrictEqual(s.opened, [], 'and a click there opens nothing');
    } finally { await s.cleanup(); }
  });

  test('the rim is drawn at a lower alpha than linked nodes', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      s.sim().tick(); // settled: the fade-in is over and alphas are the tokens' own
      s.ctx.calls.length = 0;
      s.flushFrames();
      const lonely = view.mapNodeScreenPosition('Lonely.md');
      const hub = view.mapNodeScreenPosition('Hub.md');
      // The last arc at a position is the node itself; the halo under a
      // linked node comes earlier in the frame.
      const arcAt = (p) => s.ctx.calls.filter(c => c.name === 'arc' && Math.abs(c.args[0] - p.x) < 0.01 && Math.abs(c.args[1] - p.y) < 0.01).pop();
      const rim = arcAt(lonely), linked = arcAt(hub);
      assert.ok(rim && linked, 'both are drawn at rest');
      assert.ok(rim.alpha < linked.alpha, `the rim (${rim.alpha}) is dimmer than a linked node (${linked.alpha})`);
      assert.ok(Math.abs(rim.alpha - 0.18) < 1e-9, 'at the dim token\'s alpha');
    } finally { await s.cleanup(); }
  });
});

describe('the keyword filter', () => {
  test('matches and their neighbours are visible regardless of zoom, the readout states the count, and clearing restores disclosure', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      s.flushFrames();
      assert.ok(!view.mapNodeScreenPosition('C.md').visible, 'sanity: hidden at rest');
      view.mapSetFilter('C.MD');
      s.flushFrames();
      assert.strictEqual(s.doc.getElementById('graph-filter-input').value, 'C.MD', 'the field shows what was typed');
      assert.ok(!s.doc.getElementById('graph-filter-clear').classList.contains('hidden'), 'and the clear button appears');
      assert.ok(view.mapNodeScreenPosition('C.md').visible, 'the match is on screen');
      assert.ok(view.mapNodeScreenPosition('Hub.md').visible, 'and its neighbour');
      assert.ok(!view.mapNodeScreenPosition('A.md').visible, 'a file two hops away is hidden');
      assert.ok(!view.mapNodeScreenPosition('Lonely.md').visible, 'and so is the rim');
      assert.match(s.readout(), /^1 matching “c\.md” · 1 connected$/);
      view.mapSetFilter('');
      s.flushFrames();
      assert.ok(!view.mapNodeScreenPosition('C.md').visible, 'cleared: zoom disclosure again');
      assert.ok(view.mapNodeScreenPosition('Lonely.md').visible);
      assert.match(s.readout(), /^8 files/);
      assert.ok(s.doc.getElementById('graph-filter-clear').classList.contains('hidden'));
    } finally { await s.cleanup(); }
  });

  test('arriving clears a query left over from the last visit', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      view.mapSetFilter('hub');
      s.doc.getElementById('sidebar-map').classList.add('hidden');
      await s.settle();
      view.showMapView();
      await s.settle();
      s.flushFrames();
      assert.strictEqual(s.doc.getElementById('graph-filter-input').value, '');
      assert.match(s.readout(), /^8 files/);
    } finally { await s.cleanup(); }
  });
});

describe('pan and zoom', () => {
  test('a drag past the threshold is a pan, not a click; a click on a node opens it', async () => {
    const s = mapShell();
    try {
      await openZoomedIn(s);
      const hub = view.mapNodeScreenPosition('Hub.md');
      s.mouse('mousedown', hub.x, hub.y);
      s.mouse('mousemove', hub.x + 6, hub.y);
      s.mouse('mousemove', hub.x + 12, hub.y);
      s.w.dispatchEvent(new s.w.MouseEvent('mouseup'));
      s.mouse('click', hub.x + 12, hub.y);
      assert.deepStrictEqual(s.opened, [], 'that was a pan');
      s.flushFrames();
      const moved = view.mapNodeScreenPosition('Hub.md');
      assert.ok(Math.abs(moved.x - (hub.x + 12)) < 1e-6, 'the picture moved with the hand');
      s.mouse('mousedown', moved.x, moved.y);
      s.w.dispatchEvent(new s.w.MouseEvent('mouseup'));
      s.mouse('click', moved.x, moved.y);
      assert.deepStrictEqual(s.opened, ['Hub.md'], 'a click opens the file the node is');
    } finally { await s.cleanup(); }
  });

  test('two-finger scroll pans and prevents default; pinch (ctrl-wheel) zooms anchored on the cursor and prevents default', async () => {
    const s = mapShell();
    try {
      await openZoomedIn(s);
      const before = view.mapNodeScreenPosition('Hub.md');
      let prevented = 0;
      const scroll = new s.w.WheelEvent('wheel', { deltaX: 7, deltaY: -11, clientX: 300, clientY: 200, cancelable: true, bubbles: true });
      scroll.preventDefault = () => { prevented += 1; };
      s.canvas().dispatchEvent(scroll);
      s.flushFrames();
      assert.strictEqual(prevented, 1, 'the pan branch prevents default');
      const panned = view.mapNodeScreenPosition('Hub.md');
      assert.ok(Math.abs(panned.x - (before.x - 7)) < 1e-6 && Math.abs(panned.y - (before.y + 11)) < 1e-6, 'the picture follows the scroll in both axes');
      // Back off the zoom cap first, or a pinch changes nothing and any
      // anchoring would look right. Then pinch with the cursor exactly on a
      // node: after the zoom the node is still under the cursor, and another
      // node has moved, which is what proves the scale changed.
      for (let i = 0; i < 4; i++) view.mapZoomOut();
      s.flushFrames();
      const hubBefore = view.mapNodeScreenPosition('Hub.md');
      const otherBefore = view.mapNodeScreenPosition('A.md');
      const pinch = new s.w.WheelEvent('wheel', { deltaY: -40, ctrlKey: true, clientX: hubBefore.x, clientY: hubBefore.y, cancelable: true, bubbles: true });
      pinch.preventDefault = () => { prevented += 1; };
      s.canvas().dispatchEvent(pinch);
      s.flushFrames();
      assert.strictEqual(prevented, 2, 'the zoom branch prevents default too, or the gesture zooms the whole page');
      const zoomed = view.mapNodeScreenPosition('Hub.md');
      const otherAfter = view.mapNodeScreenPosition('A.md');
      assert.ok(Math.hypot(otherAfter.x - otherBefore.x, otherAfter.y - otherBefore.y) > 1, 'sanity: the pinch changed the scale');
      assert.ok(Math.abs(zoomed.x - hubBefore.x) < 1e-6 && Math.abs(zoomed.y - hubBefore.y) < 1e-6, 'the world point under the cursor is the same point after the zoom');
    } finally { await s.cleanup(); }
  });

  test('zoom in and out are inverses and fit returns to the framed picture', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      s.flushFrames();
      const rest = view.mapNodeScreenPosition('Hub.md');
      view.mapZoomIn(); view.mapZoomIn(); view.mapZoomOut(); view.mapZoomOut();
      s.flushFrames();
      const back = view.mapNodeScreenPosition('Hub.md');
      assert.ok(Math.abs(back.x - rest.x) < 1e-6 && Math.abs(back.y - rest.y) < 1e-6);
      view.mapZoomIn(); view.mapZoomIn(); view.mapZoomIn();
      s.flushFrames();
      view.mapZoomFit();
      s.flushFrames();
      const fit = view.mapNodeScreenPosition('Hub.md');
      assert.ok(Math.abs(fit.x - rest.x) < 1e-6 && Math.abs(fit.y - rest.y) < 1e-6);
    } finally { await s.cleanup(); }
  });
});

describe('colour comes from the stylesheet, per theme, and is re-read when the theme changes', () => {
  test('edges composite with lighter on the dark ground and source-over on the light one', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      s.ctx.calls.length = 0;
      s.flushFrames();
      const darkStroke = s.ctx.calls.find(c => c.name === 'stroke');
      assert.strictEqual(darkStroke.composite, 'lighter');
      assert.strictEqual(darkStroke.stroke, 'edge-dark', 'the edge colour is the token, read through getComputedStyle');
      s.doc.body.classList.add('light');
      await s.settle();
      s.ctx.calls.length = 0;
      s.flushFrames();
      const lightStroke = s.ctx.calls.find(c => c.name === 'stroke');
      assert.strictEqual(lightStroke.composite, 'source-over');
      assert.strictEqual(lightStroke.stroke, 'edge-light', 'and re-read on the theme change');
    } finally { await s.cleanup(); }
  });

  test('every recency step and the rim are painted with values read from the computed style', async () => {
    const s = mapShell();
    try {
      await openZoomedIn(s);
      s.sim().tick();
      s.ctx.calls.length = 0;
      s.flushFrames();
      const fills = new Set(s.ctx.calls.filter(c => c.name === 'fill').map(c => c.fill));
      for (const expected of ['step1-dark', 'text2-dark']) assert.ok(fills.has(expected), `${expected} painted (${[...fills].join(', ')})`);
      for (const f of fills) assert.doesNotMatch(String(f), /^#|^rgb/, 'nothing painted is a literal the view invented');
    } finally { await s.cleanup(); }
  });

  test('graph.js carries no colour literal', () => {
    const src = read('public', 'views', 'graph.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
    assert.doesNotMatch(src, /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\bcolor-mix\(/, 'every colour is read through getComputedStyle');
    assert.ok((src.match(/getComputedStyle\(/g) || []).length >= 1, 'sanity: the view reads the computed style');
  });
});

describe('leaving the map', () => {
  test('another destination stops the simulation, cancels the pending frame, removes every listener the view added, and removes the canvas; returning rebuilds from a fresh fetch', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      const sim = s.sim();
      s.flushFrames();
      sim.tick();
      assert.ok(s.rafs.pending.size >= 1, 'sanity: a tick leaves a frame pending');
      const pendingIds = [...s.rafs.pending.keys()];
      const addedBefore = s.listeners.added.length;
      assert.ok(addedBefore >= 1, 'sanity: the view listens on the window');
      // Leaving: the rail lights Files, so the section hides the map panel.
      global.showView('editor');
      await s.settle();
      assert.strictEqual(sim.stopped, 1, 'the simulation is stopped');
      for (const id of pendingIds) assert.ok(s.rafs.cancelled.includes(id), `pending frame ${id} is cancelled`);
      assert.strictEqual(s.doc.querySelector('#view-map canvas'), null, 'the canvas is gone');
      const added = s.listeners.added.map(([t, f]) => t + ':' + String(f)).sort();
      const removed = s.listeners.removed.map(([t, f]) => t + ':' + String(f)).sort();
      assert.deepStrictEqual(removed, added, 'each add on window or document is paired with a remove of the same handler');
      // Returning: a fresh fetch and a fresh simulation.
      view.showMapView();
      await s.settle();
      assert.strictEqual(s.fetches.length, 2);
      assert.strictEqual(s.d3.sims.length, 2);
      assert.ok(s.doc.querySelector('#view-map canvas'));
    } finally { await s.cleanup(); }
  });

  test('a workspace switch, which resets the section without showing a view, also tears the map down', async () => {
    const s = mapShell();
    try {
      view.showMapView();
      await s.settle();
      const sim = s.sim();
      s.doc.getElementById('sidebar-map').classList.add('hidden');
      await s.settle();
      assert.strictEqual(sim.stopped, 1);
      assert.strictEqual(s.doc.querySelector('#view-map canvas'), null);
    } finally { await s.cleanup(); }
  });

  test('a fetch that lands after the reader has left draws nothing', async () => {
    const s = mapShell();
    try {
      let release;
      global.fetch = () => new Promise((r) => { release = () => r({ ok: true, json: () => Promise.resolve(VIEW_PAYLOAD) }); });
      view.showMapView();
      await s.settle();
      global.showView('editor');
      await s.settle();
      release();
      await s.settle();
      assert.strictEqual(s.doc.querySelector('#view-map canvas'), null, 'the late answer is dropped');
      assert.strictEqual(s.d3.sims.length, 0, 'and no simulation starts for a view nobody is looking at');
    } finally { await s.cleanup(); }
  });
});

// ===== ONE RESOLVER, TWO ROUTES =====
//
// The stop rule of this lane: the map and a document click must agree about
// which file a link opens. A tree with a decoy of the same basename, and
// both routes driven: a wikilink clicked in a document resolves on the
// client; the map's edge comes from the endpoint, which resolves on the
// server through the same function, and clicking the node at the far end of
// that edge opens the path the endpoint resolved. One answer.
describe('clicking a node opens the file the resolver would open from a document', () => {
  const filesView = require('../../public/views/files.js');
  const httpRouter = require('../../lib/http-router.js');
  const file = (p) => ({ type: 'file', name: p.split('/').pop(), path: p });
  const folder = (p, children) => ({ type: 'folder', name: p.split('/').pop(), path: p, children });
  const TREE = [
    folder('alpha', [folder('alpha/Decoy', [file('alpha/Decoy/Notes.md')])]),
    folder('beta', [folder('beta/Target', [file('beta/Target/Notes.md')])]),
    file('Source.md'),
  ];
  const LINK = { src: 'Source.md', target: 'beta/Target/Notes', kind: 'wikilink' };

  test('the document route and the map route open one file', async () => {
    // Route two's payload first: the endpoint resolves the link on the
    // server's tree, through the same resolver a document click uses.
    const prev = httpRouter.wireHttpRouterDeps({
      getFileTreeCached: () => TREE, getSearchEngine: () => ({ allLinks: () => [LINK] }), fileIndexInProgress: () => false,
    });
    const chunks = [];
    const res = { writeHead: () => {}, end: (b) => chunks.push(b) };
    try { httpRouter.handleHttpRequest({ url: '/api/graph', method: 'GET' }, res); } finally { httpRouter.wireHttpRouterDeps(prev); }
    const payload = JSON.parse(chunks.join(''));
    const s = mapShell({ payload });
    try {
      // Route one: the document click, on the client's own tree, in the same
      // page the map is in.
      const sent = [];
      const docStubs = { cachedFileTree: TREE, currentFilePath: 'Source.md', fileHistory: [], editorReturnView: 'editor',
        ws: { send: (raw) => sent.push(JSON.parse(raw)) }, switchNav: () => {}, highlightFileInSidebar: () => {} };
      const savedShowView = global.showView;
      for (const [k, v] of Object.entries(docStubs)) global[k] = v;
      global.showView = () => {};
      try { filesView.openWikilink(LINK.target); } finally { for (const k of Object.keys(docStubs)) delete global[k]; global.showView = savedShowView; }
      const fromDocument = sent.find(m => m.type === 'read_file').path;

      // Route two: the map draws the edge to what the endpoint resolved, and
      // the node at its far end is clicked at the position the view reports.
      await openZoomedIn(s);
      const source = view.mapNodeScreenPosition('Source.md');
      assert.strictEqual(source.neighbours.length, 1, 'the source has exactly one edge');
      const end = view.mapNodeScreenPosition(source.neighbours[0]);
      s.mouse('mousedown', end.x, end.y);
      s.w.dispatchEvent(new s.w.MouseEvent('mouseup'));
      s.mouse('click', end.x, end.y);
      assert.strictEqual(s.opened.length, 1, 'the click opened one file');
      assert.strictEqual(s.opened[0], fromDocument, 'and it is the file the document click opens: one resolver, one answer');
      assert.strictEqual(fromDocument, 'beta/Target/Notes.md', 'which is the file the link named in full, not the decoy that sorts first');
    } finally { await s.cleanup(); }
  });
});
