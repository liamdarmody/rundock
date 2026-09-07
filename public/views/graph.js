// Map view: one canvas filling the pane, no sidebar. Rendering and event
// handling only; every rule about what is shown (which links are edges,
// what is on screen at this zoom, how big a node is, which files are recent,
// what the readout says) lives in graph-model.js and is called from here.
//
// THE PICTURE IS REBUILT ON EVERY ARRIVAL from a fresh fetch. Links change on
// a content edit and no tree event announces that, so a cached picture would
// be a stale one. Leaving stops the simulation, cancels the pending frame,
// removes every listener this view added and removes the canvas, so nothing
// of a visit outlives it.
//
// HOW LEAVING IS NOTICED. The rail's router reveals one sidebar panel per
// section and showView reveals one pane, and both do it with the `hidden`
// class. This view watches those two elements: the moment either its panel
// or its pane is hidden, the reader has gone somewhere else (another rail
// entry, or a workspace switch, which resets the section without showing a
// view), and the map tears itself down. No other file has to remember to
// tell it.
//
// The same UMD pattern as the other view modules: node-requireable,
// window-attached, and republished on the root because the inline handlers
// in index.html reach these by name.
(/** @param {any} root @param {(model: any) => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('../graph-model.js'));
  else {
    root.RundockGraph = factory(root.RundockGraphModel);
    Object.assign(root, root.RundockGraph);
  }
}(typeof self !== 'undefined' ? self : this, function (model) {
  'use strict';

  const IDS = {
    stage: 'graph-stage', body: 'graph-body', readout: 'graph-readout', perf: 'graph-perf',
    filterInput: 'graph-filter-input', filterClear: 'graph-filter-clear',
    pane: 'view-map', panel: 'sidebar-map',
  };
  const ZOOM_STEP = 1.4; // and its exact reciprocal, so in and out are inverses
  const PERF_FRAMES = 60;

  // Between visits every one of these is null or zero.
  let current = null;        // the built map (canvas, simulation, handlers)
  let active = false;        // true from arrival to leaving
  let arrival = 0;           // a ticket per arrival, so a late fetch for a visit the reader left draws nothing
  let leaveObserver = null;  // watches the panel and the pane for the hidden class
  let themeObserver = null;  // watches the body class so colours are re-read

  // A canvas resolves no CSS variables, so every colour is read out of the
  // computed style at paint time and re-read when the theme flips. Nothing
  // here is a literal: the two values the stylesheet lacked became
  // --graph-edge and --graph-dim, and the five recency steps are colour
  // mixes declared in graph.css on probe elements, read back resolved.
  function readPalette(stage) {
    const cs = getComputedStyle(document.body);
    const g = (v) => cs.getPropertyValue(v).trim();
    const steps = {};
    for (const s of model.RECENCY_STEPS) {
      let probe = stage.querySelector('.graph-recency-' + s);
      if (!probe) {
        probe = document.createElement('span');
        probe.className = 'graph-recency graph-recency-' + s;
        stage.appendChild(probe);
      }
      steps[s] = getComputedStyle(probe).color;
    }
    const dim = parseFloat(g('--graph-dim'));
    return {
      node: g('--text-2'),
      labelStrong: g('--text-1'),
      chip: g('--card'),
      chipRadius: parseFloat(g('--radius-sm')) || 0,
      ground: g('--elevated'),
      hot: g('--accent'),
      edge: g('--graph-edge'),
      dim: Number.isFinite(dim) ? dim : 1,
      labelFont: g('--label') + ' ' + cs.fontFamily,
      steps,
    };
  }

  // Every message this view shows is built from nodes, so there is no
  // escaping to get right and nothing here appears in the innerHTML inventory.
  function setMessage(title, body) {
    const host = document.getElementById(IDS.body);
    if (!host) return;
    const wrap = document.createElement('div');
    wrap.className = 'graph-empty';
    const h = document.createElement('h4');
    h.textContent = title;
    const p = document.createElement('p');
    p.textContent = body;
    wrap.append(h, p);
    host.replaceChildren(wrap);
  }

  function setReadout(parts) {
    const el = document.getElementById(IDS.readout);
    if (!el) return;
    if (!parts) { el.replaceChildren(); return; }
    const strong = document.createElement('b');
    strong.textContent = parts.strong;
    el.replaceChildren(strong, document.createTextNode(parts.rest));
  }

  // ===== THE BUILT MAP =====
  function build(stage, payload) {
    const graph = model.buildGraph(payload);
    const host = document.getElementById(IDS.body);
    const canvas = document.createElement('canvas');
    host.replaceChildren(canvas);
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    let W = 0, H = 0;
    let pal = readPalette(stage);
    const perfOn = /[?&]perf=1/.test(location.search);
    const builtAt = performance.now();

    // Layout nodes: the model's anchors are the starting positions and the
    // kinds decide which force holds each node.
    const placed = model.assignAnchors(graph.nodes, graph.edges, { seed: model.COMMUNITY_SEED });
    const N = graph.nodes.map((n, i) => {
      const a = placed.anchors[i];
      return { i, x: a.ax, y: a.ay, ax: a.ax, ay: a.ay, degree: n.degree, kind: a.kind };
    });
    const steps = model.recencyRanks(graph.nodes).map(model.recencyStep);

    // The view transform: scale k, translate tx/ty, in screen pixels. The fit
    // frames the whole graph and refits on every tick until the reader pans
    // or zooms, after which the transform is theirs.
    let t = { k: 1, tx: 0, ty: 0 };
    let kFit = 1;
    let userMoved = false;
    let filter = null;
    let hover = null;
    let raf = null;
    const reduceMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
    let appear = reduceMotion ? 1 : 0;
    let warnedDiverged = false;
    const frames = [];

    const viewState = () => ({ threshold: model.visibleThreshold(graph.degreesSorted, t.k / (kFit || 1)), filter });
    const screenOf = (n) => [n.x * t.k + t.tx, n.y * t.k + t.ty];
    const radiusOf = (i) => model.radius(N[i].degree, t.k);

    function computeFit() {
      const b = model.bounds(N.map((n) => [n.x, n.y]), (i) => model.baseRadius(N[i].degree));
      const f = model.fitTransform(b, W, H);
      if (!f) {
        // Non-finite bounds mean the layout diverged. Say so once rather
        // than substituting a plausible number and drawing nothing.
        if (!warnedDiverged && b.diverged) { warnedDiverged = true; console.warn('[map] layout produced no finite bounds; not refitting'); }
        return;
      }
      t = f;
      kFit = f.k;
    }

    function resize() {
      const r = host.getBoundingClientRect();
      W = r.width; H = r.height;
      if (!W || !H) return;
      canvas.width = W * dpr; canvas.height = H * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (!userMoved) computeFit();
      scheduleDraw();
    }

    // One frame per animation tick however many things asked for one. The
    // simulation ticks on its own timer and asks; so do hover, pan and zoom.
    function scheduleDraw() {
      if (raf !== null) return;
      raf = requestAnimationFrame(frame);
    }
    function frame() {
      raf = null;
      const t0 = performance.now();
      draw();
      recordFrame(performance.now() - t0);
    }
    function recordFrame(ms) {
      frames.push(ms);
      if (frames.length > PERF_FRAMES) frames.shift();
      if (!perfOn || frames.length % 10 !== 0) return;
      const el = document.getElementById(IDS.perf);
      if (!el) return;
      const sorted = frames.slice().sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)];
      el.textContent = 'draw median ' + median.toFixed(2) + 'ms over ' + frames.length + ' frames'
        + (layoutMs !== null ? ' · layout ' + layoutMs + 'ms' : ' · settling')
        + ' · ' + N.length + ' nodes';
    }

    // ===== DRAWING =====
    //
    // Batched: every resting edge in one path stroked once, every resting
    // node of one recency step in one path filled once. Possible only because
    // v1 settled on one node colour with recency and state as the variation.
    function draw() {
      if (!W || !H) return;
      const v = viewState();
      const vis = (i) => model.isVisible(graph.nodes[i], i, v);
      const lit = hover === null ? null : new Set([hover, ...graph.adjacency[hover]]);
      const shows = (i) => vis(i) || (lit !== null && lit.has(i));
      const isLight = document.body.classList.contains('light');
      const composite = model.edgeComposite(isLight);
      const additive = composite === 'lighter';
      ctx.clearRect(0, 0, W, H);

      // A settling layout is drawn faint and firms up as it comes to rest.
      const settleAlpha = 0.25 + 0.75 * appear;
      // Zoomed far out every edge is sub-pixel and the whole map washes out,
      // so per-edge alpha is lifted as the scale drops.
      const zoomLift = Math.min(1.8, Math.max(1, 0.55 / Math.max(t.k, 0.08)));
      const dimIfHover = hover === null ? 1 : pal.dim;

      // Edges. Additive on the dark ground so density becomes brightness;
      // normal compositing on the light one, where adding light washes out.
      ctx.globalCompositeOperation = composite;
      ctx.globalAlpha = Math.min(1, dimIfHover * (additive ? 0.55 : 1) * settleAlpha * zoomLift);
      ctx.strokeStyle = pal.edge;
      ctx.lineWidth = Math.max(0.6, Math.min(t.k * 0.9, 1.4));
      ctx.beginPath();
      for (const [a, b] of graph.edges) {
        if (lit !== null && (a === hover || b === hover)) continue; // drawn lit below
        if (!shows(a) || !shows(b)) continue;
        const p = screenOf(N[a]), q = screenOf(N[b]);
        ctx.moveTo(p[0], p[1]);
        ctx.lineTo(q[0], q[1]);
      }
      ctx.stroke();

      // A soft halo under the nodes, also additive, so clusters bloom the way
      // a star field does instead of reading as a field of flat dots.
      if (additive) {
        ctx.globalAlpha = Math.min(1, dimIfHover * 0.22 * settleAlpha * zoomLift);
        ctx.fillStyle = pal.node;
        ctx.beginPath();
        for (let i = 0; i < N.length; i++) {
          if (N[i].degree === 0 || !shows(i) || (lit !== null && lit.has(i))) continue;
          const p = screenOf(N[i]), r = radiusOf(i) * 2.6;
          ctx.moveTo(p[0] + r, p[1]);
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        }
        ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';

      // Linked nodes, one pass per recency step, newest last so it sits on
      // top. The oldest step and the rim take the dim alpha.
      const base = dimIfHover * settleAlpha;
      for (const s of [5, 4, 3, 2, 1]) {
        ctx.globalAlpha = base * (s === 5 ? pal.dim : 1);
        ctx.fillStyle = pal.steps[s];
        ctx.beginPath();
        let any = false;
        for (let i = 0; i < N.length; i++) {
          if (N[i].degree === 0 || steps[i] !== s || !shows(i) || (lit !== null && lit.has(i))) continue;
          const p = screenOf(N[i]), r = radiusOf(i);
          ctx.moveTo(p[0] + r, p[1]);
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
          any = true;
        }
        if (any) ctx.fill();
      }
      // The rim: unlinked files, dimmer, one pass.
      ctx.globalAlpha = base * pal.dim;
      ctx.fillStyle = pal.node;
      ctx.beginPath();
      for (let i = 0; i < N.length; i++) {
        if (N[i].degree !== 0 || !shows(i) || (lit !== null && lit.has(i))) continue;
        const p = screenOf(N[i]), r = radiusOf(i);
        ctx.moveTo(p[0] + r, p[1]);
        ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.globalAlpha = 1;

      // The lit set is small by definition, so it keeps per-item calls and
      // the accent colour.
      if (lit !== null) {
        ctx.strokeStyle = pal.hot; ctx.lineWidth = 1.4; ctx.globalAlpha = 0.85;
        ctx.beginPath();
        for (const [a, b] of graph.edges) {
          if (a !== hover && b !== hover) continue;
          const p = screenOf(N[a]), q = screenOf(N[b]);
          ctx.moveTo(p[0], p[1]);
          ctx.lineTo(q[0], q[1]);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.fillStyle = pal.node;
        ctx.beginPath();
        for (const i of lit) {
          const p = screenOf(N[i]), r = radiusOf(i);
          ctx.moveTo(p[0] + r, p[1]);
          ctx.arc(p[0], p[1], r, 0, Math.PI * 2);
        }
        ctx.fill();
        const hp = screenOf(N[hover]), hr = radiusOf(hover);
        ctx.beginPath();
        ctx.arc(hp[0], hp[1], hr + 4, 0, Math.PI * 2);
        ctx.strokeStyle = pal.hot; ctx.lineWidth = 1.6;
        ctx.stroke();
      }

      // LABELS ON HOVER ONLY, and only the list the model hands back: the
      // hovered file and its visible neighbours. Drawn as small chips so a
      // name stays legible over a dense cluster, where bare text over
      // converging edges is not.
      const labels = model.labelList(graph, hover, vis);
      if (labels.length) {
        ctx.font = pal.labelFont;
        ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        for (const i of labels) {
          const p = screenOf(N[i]), r = radiusOf(i);
          const name = graph.nodes[i].name;
          const text = name.length > 30 ? name.slice(0, 29) + '…' : name;
          const w = ctx.measureText(text).width + 12, h = 18;
          const x = p[0] - w / 2, y = p[1] + r + 5;
          ctx.fillStyle = pal.chip;
          ctx.beginPath();
          if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, pal.chipRadius);
          else ctx.rect(x, y, w, h);
          ctx.fill();
          ctx.fillStyle = i === hover ? pal.labelStrong : pal.node;
          ctx.fillText(text, p[0], y + h / 2);
        }
      }
      setReadout(model.readout(graph, v, hover));
    }

    // ===== THE SIMULATION =====
    //
    // d3-force, on its own timer: the graph arrives visibly over a second or
    // two instead of the main thread blocking until it is finished. Three
    // separate levers govern the dense core (bounded repulsion, collision,
    // degree-scaled link distance) and there is no centre force: the fit
    // frames the picture instead. The rim is held by a radial force at the
    // rim radius, applied to unlinked nodes only; cluster members and small
    // components are held toward their anchors.
    let layoutMs = null;
    const sim = d3.forceSimulation(N)
      .force('charge', d3.forceManyBody()
        .strength((n) => model.chargeStrength(n.degree))
        .distanceMax(model.CHARGE_DISTANCE_MAX)
        .theta(model.CHARGE_THETA))
      .force('link', d3.forceLink(graph.edges.map(([a, b]) => ({ source: a, target: b })))
        .distance((l) => model.linkDistance(l.source, l.target)))
      .force('x', d3.forceX((n) => n.ax).strength((n) => (n.kind === 'rim' ? 0 : model.anchorStrength(n.kind))))
      .force('y', d3.forceY((n) => n.ay).strength((n) => (n.kind === 'rim' ? 0 : model.anchorStrength(n.kind))))
      .force('rim', d3.forceRadial(placed.rimRadius, 0, 0).strength((n) => (n.kind === 'rim' ? model.anchorStrength('rim') : 0)))
      .force('collide', d3.forceCollide().radius((n) => model.collideRadius(n)).iterations(1))
      .alphaDecay(model.alphaDecay(N.length))
      .on('tick.map', () => {
        // alpha runs 1 -> 0 as the layout cools: a real measure of how
        // settled the picture is rather than a wall-clock guess.
        if (!reduceMotion) appear = Math.max(0, Math.min(1, 1 - sim.alpha()));
        if (!userMoved) computeFit();
        scheduleDraw();
      })
      .on('end.map', () => {
        appear = 1;
        layoutMs = Math.round(performance.now() - builtAt);
        if (!userMoved) computeFit();
        scheduleDraw();
      });

    // ===== EVENTS =====
    function hit(mx, my) {
      const v = viewState();
      return model.hitTest(graph, N.map(screenOf), mx, my, (i) => model.isVisible(graph.nodes[i], i, v), radiusOf);
    }
    function pointer(ev) {
      const r = canvas.getBoundingClientRect();
      return [ev.clientX - r.left, ev.clientY - r.top];
    }
    let dragging = false, dragMoved = 0, lastX = 0, lastY = 0;
    const onMouseMove = (ev) => {
      if (dragging) {
        const dx = ev.clientX - lastX, dy = ev.clientY - lastY;
        lastX = ev.clientX; lastY = ev.clientY;
        dragMoved += Math.abs(dx) + Math.abs(dy);
        t = { k: t.k, tx: t.tx + dx, ty: t.ty + dy };
        userMoved = true;
        canvas.style.cursor = 'grabbing';
        scheduleDraw();
        return;
      }
      const [mx, my] = pointer(ev);
      const n = hit(mx, my);
      canvas.style.cursor = n === null ? 'default' : 'pointer';
      if (n !== hover) { hover = n; scheduleDraw(); }
    };
    const onMouseLeave = () => { if (hover !== null) { hover = null; scheduleDraw(); } };
    const onMouseDown = (ev) => { dragging = true; dragMoved = 0; lastX = ev.clientX; lastY = ev.clientY; };
    const onMouseUp = () => { dragging = false; canvas.style.cursor = hover === null ? 'default' : 'pointer'; };
    const onClick = (ev) => {
      // A drag is not a click, so a pan never opens a file.
      if (!model.dragIsClick(dragMoved)) { dragMoved = 0; return; }
      const [mx, my] = pointer(ev);
      const n = hit(mx, my);
      // Click to open is the whole point of the view: a node is navigation,
      // and the file it opens is the path the endpoint resolved the edge to.
      if (n !== null && typeof openWorkspaceFilePath === 'function') openWorkspaceFilePath(graph.nodes[n].path);
    };
    // Trackpad and wheel, following the convention every map tool uses:
    // PINCH zooms, two-finger SCROLL pans. A pinch arrives as a wheel event
    // with ctrlKey set, which is also how the browser zooms the whole page,
    // so BOTH branches prevent the default or the gesture escapes the pane.
    const onWheel = (ev) => {
      ev.preventDefault();
      if (ev.ctrlKey) {
        const [mx, my] = pointer(ev);
        t = model.zoomAt(t, model.wheelZoomFactor(ev.deltaY), mx, my);
      } else {
        t = { k: t.k, tx: t.tx - ev.deltaX, ty: t.ty - ev.deltaY };
      }
      userMoved = true;
      scheduleDraw();
    };
    const onResize = () => resize();
    canvas.addEventListener('mousemove', onMouseMove);
    canvas.addEventListener('mouseleave', onMouseLeave);
    canvas.addEventListener('mousedown', onMouseDown);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    // Every listener added to window is recorded beside its removal below.
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('resize', onResize);

    function zoomBy(factor) {
      t = model.zoomAt(t, factor, W / 2, H / 2);
      userMoved = true;
      scheduleDraw();
    }

    resize();
    return {
      graph,
      setFilter(q) { filter = model.applyFilter(graph, q); scheduleDraw(); },
      zoomBy,
      resetZoom() { userMoved = false; computeFit(); scheduleDraw(); },
      repaint() { pal = readPalette(stage); scheduleDraw(); },
      nodePosition(path) {
        const i = graph.nodes.findIndex((n) => n.path === path);
        if (i === -1) return null;
        const r = canvas.getBoundingClientRect();
        const [sx, sy] = screenOf(N[i]);
        const v = viewState();
        return {
          x: r.left + sx, y: r.top + sy,
          visible: model.isVisible(graph.nodes[i], i, v),
          neighbours: [...graph.adjacency[i]].map((j) => graph.nodes[j].path),
        };
      },
      destroy() {
        sim.stop();
        if (raf !== null) { cancelAnimationFrame(raf); raf = null; }
        window.removeEventListener('mouseup', onMouseUp);
        window.removeEventListener('resize', onResize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      },
    };
  }

  // ===== ARRIVING AND LEAVING =====
  function isHidden(id) {
    const el = document.getElementById(id);
    return !el || el.classList.contains('hidden');
  }

  function teardown() {
    arrival += 1; // any fetch in flight for the visit that just ended draws nothing
    active = false;
    if (current) { current.destroy(); current = null; }
    if (leaveObserver) { leaveObserver.disconnect(); leaveObserver = null; }
    if (themeObserver) { themeObserver.disconnect(); themeObserver = null; }
    const host = document.getElementById(IDS.body);
    if (host) host.replaceChildren();
    setReadout(null);
    const perf = document.getElementById(IDS.perf);
    if (perf) perf.textContent = '';
  }

  function watch() {
    leaveObserver = new MutationObserver(() => {
      if (active && (isHidden(IDS.pane) || isHidden(IDS.panel))) teardown();
    });
    for (const id of [IDS.pane, IDS.panel]) {
      const el = document.getElementById(id);
      if (el) leaveObserver.observe(el, { attributes: true, attributeFilter: ['class'] });
    }
    themeObserver = new MutationObserver(() => { if (current) current.repaint(); });
    themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class'] });
  }

  function render(stage, payload) {
    if (payload.indexed === false) { setMessage(model.NO_INDEX.title, model.NO_INDEX.body); return; }
    if (payload.warming) { setMessage(model.WARMING.title, model.WARMING.body); return; }
    const graph = model.buildGraph(payload);
    if (!graph.stats.edges) { setMessage(model.NOTHING_LINKED.title, model.NOTHING_LINKED.body(graph.stats.files)); return; }
    current = build(stage, payload);
  }

  function arrive() {
    teardown();
    const stage = document.getElementById(IDS.stage);
    if (!stage) return;
    active = true;
    // A query left over from the last visit would silently hide most of
    // the map, so arriving always starts from the whole thing.
    const input = document.getElementById(IDS.filterInput);
    if (input) input.value = '';
    const clear = document.getElementById(IDS.filterClear);
    if (clear) clear.classList.add('hidden');
    watch();
    const ticket = arrival;
    setMessage('Reading the workspace', 'Building the map from every link the index holds.');
    fetch('/api/graph')
      .then((r) => r.json().then((body) => ({ ok: r.ok, body })))
      .then((res) => {
        if (ticket !== arrival) return; // the reader left, or arrived again
        if (!res.ok) throw new Error((res.body && res.body.error) || 'request failed');
        render(stage, res.body);
      })
      .catch((e) => {
        if (ticket !== arrival) return;
        setMessage('Could not build the map', String((e && e.message) || e));
      });
  }

  // A named declaration, because test/unit/navigation-doors.test.js names
  // every showView call site by its enclosing construct.
  function showMapView() {
    showView('map');
    arrive();
  }

  // Called by the client's system dispatch when the server's index warm-up
  // reports ready: the map drew a warming state in its absence, and a fresh
  // fetch is the only way to learn what the index now holds.
  function mapIndexReady() {
    if (active) arrive();
  }

  // A filter pass is a set build plus one frame, single-digit milliseconds
  // even at four thousand nodes, so it runs on every keystroke.
  function mapSetFilter(q) {
    const input = document.getElementById(IDS.filterInput);
    const clear = document.getElementById(IDS.filterClear);
    if (input && input.value !== q) input.value = q;
    if (clear) clear.classList.toggle('hidden', !q);
    if (current) current.setFilter(q);
  }
  function mapZoomIn() { if (current) current.zoomBy(ZOOM_STEP); }
  function mapZoomOut() { if (current) current.zoomBy(1 / ZOOM_STEP); }
  function mapZoomFit() { if (current) current.resetZoom(); }

  // The test seam: where a node is on the page, whether it is on screen, and
  // which files it is linked to, so a browser test can click a node by path
  // rather than by guessing at pixels.
  function mapNodeScreenPosition(path) {
    return current ? current.nodePosition(path) : null;
  }

  return { showMapView, mapIndexReady, mapSetFilter, mapZoomIn, mapZoomOut, mapZoomFit, mapNodeScreenPosition };
}));
