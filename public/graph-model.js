'use strict';
/**
 * The map's model: every rule that decides what the map shows, with no canvas.
 *
 * WHY THIS IS A MODULE AND NOT A VIEW. The map is judged on rules (which links
 * are edges, which files are on screen at this zoom, how big a hub is, which
 * files count as recent, what the readout says) and every one of them was
 * unreachable by a test while it sat inside a draw loop. Pulled out here, each
 * is a function of numbers and can be asserted.
 *
 * ONE RULE, ONE PLACE, and it is the ruling most likely to be undone by
 * somebody tidying. The prototype had two defects of one shape: a rule that
 * lived in the render path only. Visibility was computed inside draw(), so the
 * hit-test walked every node and hovering empty space surfaced files that were
 * not on screen. Anything that decides what is on screen (isVisible below) is
 * consulted by drawing, hit-testing, counting and the readout, and a consumer
 * that reimplements it is the defect coming back.
 *
 * NOTHING HERE READS THE MACHINE IT RUNS ON. No DOM, no clock, no random
 * source: label propagation is seeded by the caller, recency is a rank over
 * the modified times the caller passes, and the theme is a boolean argument.
 * So this module behaves identically wherever it runs, and so does every test.
 */
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RundockGraphModel = factory();
}(typeof self !== 'undefined' ? self : this, function () {

  // ===== BUILDING THE GRAPH =====
  //
  // Nodes are every file the tree holds. Edges come only from links the
  // endpoint resolved: an unresolved link is a fact worth counting elsewhere
  // and nothing to draw. An embed renders a file rather than linking to it,
  // which is the connections list's rule too. A pair written twice, or in
  // both directions, is one edge, and a file linking to itself is none.
  function buildGraph(payload) {
    const nodes = (payload && payload.nodes || []).map((n) => ({
      path: n.path,
      name: n.name,
      modified: (typeof n.modified === 'number' && Number.isFinite(n.modified)) ? n.modified : null,
      degree: 0,
    }));
    const index = new Map();
    nodes.forEach((n, i) => index.set(n.path, i));
    const seen = new Set();
    const edges = [];
    for (const link of (payload && payload.links || [])) {
      if (!link || link.resolved == null) continue;
      if (link.kind === 'embed') continue;
      const a = index.get(link.src), b = index.get(link.resolved);
      if (a === undefined || b === undefined || a === b) continue;
      const lo = Math.min(a, b), hi = Math.max(a, b);
      const key = lo + ':' + hi;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push([lo, hi]);
      nodes[lo].degree += 1;
      nodes[hi].degree += 1;
    }
    const adjacency = nodes.map(() => new Set());
    for (const [a, b] of edges) { adjacency[a].add(b); adjacency[b].add(a); }
    const stats = {
      files: nodes.length,
      edges: edges.length,
      unlinked: nodes.filter((n) => n.degree === 0).length,
    };
    return { nodes, edges, adjacency, stats, degreesSorted: sortedDegrees(nodes) };
  }

  // ===== COMMUNITIES =====
  //
  // Label propagation: every node repeatedly takes the label most common
  // among its neighbours. A few passes and densely interlinked groups agree
  // on a label while sparse links between groups do not. Cheap, parameter
  // free, and the standard cheap alternative to Louvain.
  //
  // THE SEED IS PART OF THE CONTRACT. Propagation is order-sensitive: sweeping
  // in index order lets one label march along the array and swallow
  // everything, so the order is shuffled, and shuffled by a seeded generator
  // so the same workspace gets the same picture on every visit. A caller that
  // omits the seed is refused rather than handed Math.random, because a
  // layout that differs on every open is the defect the seed exists to stop.
  const COMMUNITY_SEED = 12345;
  const COMMUNITY_ITERATIONS = 14;
  function detectCommunities(count, edges, opts) {
    if (!opts || typeof opts.seed !== 'number') throw new Error('detectCommunities needs a numeric seed');
    const iterations = opts.iterations || COMMUNITY_ITERATIONS;
    const nbr = [];
    for (let i = 0; i < count; i++) nbr.push([]);
    for (const [a, b] of edges) { nbr[a].push(b); nbr[b].push(a); }
    const lab = [];
    const order = [];
    for (let i = 0; i < count; i++) { lab.push(i); order.push(i); }
    let seed = opts.seed >>> 0;
    for (let i = order.length - 1; i > 0; i--) {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      const j = seed % (i + 1);
      const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    for (let it = 0; it < iterations; it++) {
      let changed = 0;
      for (let oi = 0; oi < order.length; oi++) {
        const idx = order[oi], ns = nbr[idx];
        if (!ns.length) continue;
        const cnt = new Map();
        let best = lab[idx], bestN = 0;
        for (let k = 0; k < ns.length; k++) {
          const l = lab[ns[k]];
          const c = (cnt.get(l) || 0) + 1;
          cnt.set(l, c);
          if (c > bestN) { bestN = c; best = l; }
        }
        if (lab[idx] !== best) { lab[idx] = best; changed++; }
      }
      if (!changed) break;
    }
    return lab;
  }

  // Connected components by union-find. A small component (a pair of notes
  // linked only to each other) has no link to the main body, and left to the
  // forces alone it drifts far outside the rim. Knowing the components lets
  // them be placed deliberately in the band between the core and the rim.
  function components(count, edges, degrees) {
    const parent = [];
    for (let i = 0; i < count; i++) parent.push(i);
    const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
    for (const [a, b] of edges) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }
    // Named rootOf rather than root: the navigation scan refuses `root[` in
    // client code, since a computed lookup on a global could spell a
    // destination no reading of the source would find.
    const rootOf = [];
    const size = Object.create(null);
    for (let i = 0; i < count; i++) {
      if (!degrees[i]) { rootOf.push(null); continue; }
      const r = find(i);
      rootOf.push(r);
      size[r] = (size[r] || 0) + 1;
    }
    return { rootOf, size };
  }

  // ===== ANCHORS =====
  //
  // Each community gets a place of its own on a phyllotaxis spiral, so no two
  // share a ray and spacing stays even as the count changes: the biggest sits
  // in the middle and the rest fan outward. Small components sit in a band
  // just outside the core. Unlinked files are parked beyond all of them, at
  // one radius, which is what makes them read as the rim of the picture
  // rather than as debris through the middle of it.
  //
  // Room matters more than the anchor. The anchor is a hint about WHERE a
  // group belongs; repulsion, collision and links decide what it looks like
  // once it gets there.
  const GOLDEN = Math.PI * (3 - Math.sqrt(5));
  const CORE_RADIUS_PER_SQRT_NODE = 62;
  const RIM_RADIUS_RATIO = 1.3;
  function assignAnchors(nodes, edges, opts) {
    const seed = (opts && typeof opts.seed === 'number') ? opts.seed : COMMUNITY_SEED;
    const degrees = nodes.map((n) => n.degree);
    const comp = components(nodes.length, edges, degrees);
    let giant = null, giantN = 0;
    for (const c of Object.keys(comp.size)) {
      if (comp.size[c] > giantN) { giantN = comp.size[c]; giant = Number(c); }
    }
    const smallComps = Object.keys(comp.size).map(Number).filter((c) => c !== giant)
      .sort((a, b) => comp.size[b] - comp.size[a]);
    const compRank = new Map();
    smallComps.forEach((c, i) => compRank.set(c, i));

    const lab = detectCommunities(nodes.length, edges, { seed });
    const size = new Map();
    let connected = 0;
    for (let i = 0; i < nodes.length; i++) {
      if (!degrees[i]) continue;
      size.set(lab[i], (size.get(lab[i]) || 0) + 1);
      connected++;
    }
    const ranked = [...size.keys()].sort((a, b) => size.get(b) - size.get(a) || a - b);
    const K = ranked.length;
    const rankOf = new Map();
    ranked.forEach((l, r) => rankOf.set(l, r));

    const coreRadius = CORE_RADIUS_PER_SQRT_NODE * Math.sqrt(Math.max(connected, 1));
    const rimRadius = coreRadius * RIM_RADIUS_RATIO;
    const anchors = [];
    for (let q = 0; q < nodes.length; q++) {
      if (!degrees[q]) {
        const a0 = (q * GOLDEN) % (Math.PI * 2);
        anchors.push({ ax: Math.cos(a0) * rimRadius, ay: Math.sin(a0) * rimRadius, kind: 'rim' });
        continue;
      }
      if (comp.rootOf[q] !== giant) {
        const cr = compRank.get(comp.rootOf[q]) || 0;
        const ang = cr * GOLDEN;
        const rad = coreRadius * (1.02 + 0.16 * ((cr % 5) / 5));
        anchors.push({ ax: Math.cos(ang) * rad, ay: Math.sin(ang) * rad, kind: 'satellite' });
        continue;
      }
      const rr = rankOf.get(lab[q]);
      const rad = coreRadius * (0.16 + 0.84 * Math.sqrt((rr + 0.5) / K));
      const ang = rr * GOLDEN;
      anchors.push({
        ax: Math.cos(ang) * rad, ay: Math.sin(ang) * rad, kind: 'cluster',
        communityRank: rr, communitySize: size.get(lab[q]) || 1,
      });
    }
    return { anchors, communities: K, coreRadius, rimRadius };
  }

  // ===== PROGRESSIVE DISCLOSURE =====
  //
  // At the fit zoom the map shows its hubs and its rim; zooming in reveals
  // the rest by descending degree. Zoom becomes an act of asking for more
  // rather than only making things bigger, and the whole-map view stays a
  // readable shape instead of a solid mass. Degrees are sorted once so the
  // threshold for "top n%" is a lookup rather than a scan per frame.
  const REST_FRACTION = 0.08;
  const DISCLOSURE_EXPONENT = 1.7;
  function sortedDegrees(nodes) {
    return nodes.filter((n) => n.degree > 0).map((n) => n.degree).sort((a, b) => b - a);
  }
  function visibleThreshold(sorted, zoomRatio) {
    if (!sorted.length) return 0;
    const z = Math.max(1, zoomRatio || 1);
    const frac = Math.min(1, REST_FRACTION * Math.pow(z, DISCLOSURE_EXPONENT));
    const idx = Math.min(sorted.length - 1, Math.floor(frac * sorted.length));
    return sorted[idx];
  }

  // ===== THE ONE VISIBILITY PREDICATE =====
  //
  // Consulted by drawing, hit-testing, counting and the readout. With a
  // filter active, a match and its direct neighbours are on screen and
  // nothing else is, whatever the zoom. Without one, degree-zero nodes are
  // always drawn (they carry no detail to withhold and they are the
  // silhouette the map is recognised by) and linked nodes clear the threshold.
  function isVisible(node, i, view) {
    if (view.filter) return view.filter.matched.has(i) || view.filter.near.has(i);
    return node.degree === 0 || node.degree >= view.threshold;
  }
  function hiddenCount(graph, view) {
    let shown = 0;
    for (let i = 0; i < graph.nodes.length; i++) if (isVisible(graph.nodes[i], i, view)) shown++;
    return graph.nodes.length - shown;
  }

  // ===== KEYWORD FILTER =====
  function matchesKeyword(node, query) {
    const q = String(query || '').toLowerCase();
    return node.name.toLowerCase().indexOf(q) !== -1 || node.path.toLowerCase().indexOf(q) !== -1;
  }
  // The matches and, separately, whatever is linked to a match: a result is
  // seen in context rather than floating alone. Null for an empty query, so a
  // consumer cannot mistake "no filter" for "a filter matching nothing".
  function applyFilter(graph, query) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;
    const matched = new Set();
    for (let i = 0; i < graph.nodes.length; i++) if (matchesKeyword(graph.nodes[i], q)) matched.add(i);
    const near = new Set();
    for (const i of matched) for (const j of graph.adjacency[i]) if (!matched.has(j)) near.add(j);
    return { query: q, matched, near };
  }

  // ===== SIZE =====
  //
  // Degree is the one property worth encoding once every node is the same
  // kind, and it is encoded sub-linearly: a 640-degree hub is a bigger dot,
  // not a disc. Zoom scales the radius by an exponent below one, and that is
  // the point rather than a detail: scaling linearly meant that at the fit
  // zoom of a few thousand nodes every node from degree 0 to 100 clamped to
  // the same floor, so the encoding existed and was invisible exactly where
  // the whole map is being looked at. Clamped at both ends: never smaller
  // than a visible speck, never larger than a disc that swallows neighbours.
  const RADIUS_BASE = 3.4;
  const RADIUS_PER_SQRT_DEGREE = 3.2;
  const ZOOM_EXPONENT = 0.55;
  const RADIUS_MIN = 0.9;
  const RADIUS_MAX = 26;
  function baseRadius(degree) { return RADIUS_BASE + Math.sqrt(Math.max(0, degree)) * RADIUS_PER_SQRT_DEGREE; }
  function radius(degree, k) {
    return Math.max(RADIUS_MIN, Math.min(baseRadius(degree) * Math.pow(k, ZOOM_EXPONENT), RADIUS_MAX));
  }

  // ===== RECENCY =====
  //
  // A rank in the workspace by modified time, not a threshold on age:
  // "recent" means something different in a vault edited hourly and one
  // edited monthly, and a rank gives each its own newest slice. 1 is the
  // newest file, 0 the oldest, and a file with no modified time takes the
  // middle so it is drawn as neither. Ties share the higher rank.
  function recencyRanks(nodes) {
    const known = [];
    for (const n of nodes) if (typeof n.modified === 'number' && Number.isFinite(n.modified)) known.push(n.modified);
    known.sort((a, b) => a - b);
    const total = known.length;
    return nodes.map((n) => {
      if (typeof n.modified !== 'number' || !Number.isFinite(n.modified)) return 0.5;
      if (total === 1) return 1;
      // How many files are no newer than this one, found by binary search.
      let lo = 0, hi = total;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (known[mid] <= n.modified) lo = mid + 1; else hi = mid; }
      return (lo - 1) / (total - 1);
    });
  }
  // Five discrete steps rather than a gradient: five cached fills beat a
  // per-node interpolation every frame, and five steps is a ramp a reader can
  // read as newer and older at a glance where a gradient across thousands of
  // nodes reads as noise. Bands by rank: top 5%, next 15%, next 30%, next
  // 30%, the remaining 20%.
  const RECENCY_STEPS = [1, 2, 3, 4, 5];
  function recencyStep(rank) {
    if (rank >= 0.95) return 1;
    if (rank >= 0.80) return 2;
    if (rank >= 0.50) return 3;
    if (rank >= 0.20) return 4;
    return 5;
  }

  // ===== LABELS =====
  //
  // On hover only: the hovered file and its visible neighbours. Standing
  // labels were built twice, per node and per cluster, and removed both
  // times. A map is a picture at rest and names things on demand.
  function labelList(graph, hover, visible) {
    if (hover === null || hover === undefined) return [];
    const out = [hover];
    for (const j of graph.adjacency[hover]) if (visible(j)) out.push(j);
    return out;
  }

  // ===== HIT-TESTING =====
  //
  // The nearest visible node within the slop, or null. `visible` is the one
  // predicate, and a caller that passes anything looser is the render-path
  // defect coming back: hidden means hidden, including to the cursor.
  const HIT_SLOP = 16;
  function hitTest(graph, screen, mx, my, visible, radiusOf) {
    let best = null, bd = HIT_SLOP;
    for (let i = 0; i < graph.nodes.length; i++) {
      if (!visible(i)) continue;
      const p = screen[i];
      const d = Math.hypot(p[0] - mx, p[1] - my) - radiusOf(i);
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ===== BOUNDS AND FIT =====
  //
  // Robust bounds: the 1st and 99th percentile rather than the extremes. A
  // few small components drift a long way out, and fitting to the true min
  // and max let them dictate the scale, shrinking the part anyone came to
  // look at into a speck. A NON-FINITE POSITION IS REPORTED, NOT PATCHED: it
  // means the layout diverged, and an earlier guard that quietly turned
  // Infinity into a plausible number drew nothing at all with no error.
  function percentile(sorted, p) {
    const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)));
    return sorted[i];
  }
  function bounds(points, radiusOf) {
    if (!points.length) return { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
    const xs = [], ys = [];
    let maxR = 0;
    for (let i = 0; i < points.length; i++) {
      const [x, y] = points[i];
      if (!Number.isFinite(x) || !Number.isFinite(y)) return { minX: NaN, minY: NaN, maxX: NaN, maxY: NaN, diverged: true };
      xs.push(x); ys.push(y);
      const r = radiusOf(i);
      if (r > maxR) maxR = r;
    }
    xs.sort((a, b) => a - b);
    ys.sort((a, b) => a - b);
    return {
      minX: percentile(xs, 0.01) - maxR, maxX: percentile(xs, 0.99) + maxR,
      minY: percentile(ys, 0.01) - maxR, maxY: percentile(ys, 0.99) + maxR,
    };
  }
  const FIT_PADDING = 44;
  const FIT_MAX_ZOOM = 1.5;
  function fitTransform(b, W, H) {
    if (!Number.isFinite(b.minX) || !Number.isFinite(b.maxX) || !Number.isFinite(b.minY) || !Number.isFinite(b.maxY)) return null;
    const bw = Math.max(b.maxX - b.minX, 1), bh = Math.max(b.maxY - b.minY, 1);
    const k = Math.min((W - FIT_PADDING * 2) / bw, (H - FIT_PADDING * 2) / bh, FIT_MAX_ZOOM);
    if (!Number.isFinite(k) || k <= 0) return null;
    return { k, tx: W / 2 - ((b.minX + b.maxX) / 2) * k, ty: H / 2 - ((b.minY + b.maxY) / 2) * k };
  }

  // ===== ZOOM AND PAN =====
  //
  // Zoom anchored on a screen point, so whatever is under the pointer stays
  // under it; without that, zooming into a cluster turns into a chase.
  const ZOOM_MIN = 0.02;
  const ZOOM_MAX = 40;
  function zoomAt(t, factor, mx, my) {
    const nk = Math.max(ZOOM_MIN, Math.min(t.k * factor, ZOOM_MAX));
    return { k: nk, tx: mx - (mx - t.tx) * (nk / t.k), ty: my - (my - t.ty) * (nk / t.k) };
  }
  function wheelZoomFactor(deltaY) { return Math.exp(-deltaY * 0.01); }
  // A drag is not a click. Four pixels of travel is the line, so click-to-open
  // survives a hand that moved slightly and a pan never opens a file.
  const CLICK_SLOP = 4;
  function dragIsClick(moved) { return moved <= CLICK_SLOP; }

  // ===== COMPOSITING =====
  //
  // Additive blending on the dark ground: overlapping edges accumulate into
  // light, so density becomes brightness and the dense core glows instead of
  // flattening into grey. It only works on a dark ground; adding light on a
  // near-white one washes to white, so the light theme keeps normal
  // compositing. The two themes are deliberately not the same picture.
  function edgeComposite(isLight) { return isLight ? 'source-over' : 'lighter'; }

  // ===== THE READOUT =====
  //
  // The only text in the view, and it stays honest about what is on screen:
  // when fewer files are drawn than exist, it says how many and that zoom
  // reveals them. With a filter it states the match count. With a hover it
  // names the file. Two pieces so the view can set one in bold.
  function readout(graph, view, hover) {
    if (hover !== null && hover !== undefined) {
      const n = graph.nodes[hover];
      return { strong: n.name, rest: ' · ' + n.degree + (n.degree === 1 ? ' connection' : ' connections') };
    }
    if (view.filter) {
      if (!view.filter.matched.size) return { strong: 'No files', rest: ' match “' + view.filter.query + '”' };
      return {
        strong: String(view.filter.matched.size),
        rest: ' matching “' + view.filter.query + '” · ' + view.filter.near.size + ' connected',
      };
    }
    const hidden = hiddenCount(graph, view);
    return {
      strong: String(graph.stats.files),
      rest: ' files · ' + graph.stats.edges + ' connections · ' + graph.stats.unlinked + ' unlinked'
        + (hidden > 0 ? ' · ' + hidden + ' hidden, zoom to reveal' : ''),
    };
  }
  const WARMING = {
    title: 'Links are still being indexed',
    body: 'The map draws itself as soon as the index is ready.',
  };
  const NO_INDEX = {
    title: 'The map needs the search index',
    body: 'This runtime does not have it, so links are not indexed and there is nothing to draw.',
  };
  const NOTHING_LINKED = {
    title: 'Nothing is linked yet',
    body: (files) => 'This workspace has ' + files + (files === 1 ? ' file' : ' files')
      + ' and no links between them. Link a file with a wikilink and it appears here.',
  };

  // ===== LAYOUT PARAMETERS =====
  //
  // Three separate levers govern a dense core, and pushing one of them does
  // not do the work of the other two. Repulsion is BOUNDED in range so far
  // apart nodes stop pushing on each other, which is what lets local density
  // resolve without a global inflation. COLLISION keeps two circles out of
  // the same pixels, which is most of what reads as "the middle is a mass".
  // LINK DISTANCE grows with the endpoints' degree so a hub's neighbours do
  // not pile up around it. And no uniform centre force: that recompresses
  // exactly the density these three exist to remove, so the fit pass frames
  // the picture instead. Parameters scale with node count because d3's
  // defaults are calibrated for graphs of about a hundred nodes.
  const CHARGE_DISTANCE_MAX = 900;
  const CHARGE_THETA = 0.9;
  function chargeStrength(degree) { return -(18 + 16 * Math.sqrt(Math.max(0, degree))); }
  function linkDistance(a, b) { return 22 + 9 * Math.sqrt(Math.max(0, a.degree + b.degree)); }
  function collideRadius(n) { return baseRadius(n.degree) + 2; }
  // Cool for longer on a large graph: a fixed decay freezes a 4,000-node
  // layout mid-collapse before repulsion and collision have resolved it.
  function alphaDecay(count) { return Math.max(0.012, Math.min(0.05, 0.035 * Math.sqrt(500 / Math.max(count, 1)))); }
  // Cluster members are held firmly enough to keep a group together, small
  // components a little harder so they stay in their band, and the rim
  // hardest so unlinked files stay out of the middle: the rim's job is
  // silhouette, not sediment. The rim is held by a radial force at the rim
  // radius, applied to unlinked nodes only.
  function anchorStrength(kind) {
    return kind === 'rim' ? 0.10 : kind === 'satellite' ? 0.14 : 0.06;
  }
  const CENTER_FORCE = null;

  return {
    buildGraph, sortedDegrees,
    detectCommunities, components, assignAnchors, COMMUNITY_SEED,
    visibleThreshold, isVisible, hiddenCount,
    matchesKeyword, applyFilter,
    baseRadius, radius, ZOOM_EXPONENT, RADIUS_MIN, RADIUS_MAX,
    recencyRanks, recencyStep, RECENCY_STEPS,
    labelList, hitTest, HIT_SLOP,
    bounds, fitTransform, FIT_PADDING, FIT_MAX_ZOOM,
    zoomAt, wheelZoomFactor, ZOOM_MIN, ZOOM_MAX, dragIsClick, CLICK_SLOP,
    edgeComposite,
    readout, WARMING, NO_INDEX, NOTHING_LINKED,
    CHARGE_DISTANCE_MAX, CHARGE_THETA, chargeStrength, linkDistance, collideRadius, alphaDecay, anchorStrength, CENTER_FORCE,
  };
}));
