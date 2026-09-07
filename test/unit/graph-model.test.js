'use strict';
// The map's rules, pressed without a canvas.
//
// Everything that decides what the map shows lives in public/graph-model.js:
// which links become edges, which community a file belongs to, where the rim
// sits, what is on screen at a given zoom, how big a node is, which files are
// recent, what the readout says. The view draws what these functions return
// and nothing else, so each rule is asserted here, once, against numbers.
//
// The lesson these tests carry from the prototype: two separate defects there
// had the same shape, a rule that lived in the render path only. Visibility
// was decided inside draw(), so hovering empty space surfaced files that were
// not on screen. One predicate, consulted by drawing, hit-testing, counting
// and the readout, is the fix, and the hit-test and readout tests below are
// what hold it to that.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const m = require('../../public/graph-model.js');

const node = (path, modified = null) => ({ path, name: path.split('/').pop(), modified });
const link = (src, target, resolved, kind = 'wikilink') => ({ src, target, kind, resolved });

// A small workspace with the shapes that matter: a hub, a leaf, a pair only
// linked to each other, and two files nothing points at.
const PAYLOAD = {
  indexed: true,
  nodes: [
    node('Hub.md', 5000), node('A.md', 4000), node('B.md', 3000), node('C.md', 2000),
    node('pair/One.md', 1000), node('pair/Two.md', 900),
    node('Lonely.md', 800), node('inbox/Scratch.md', null),
  ],
  links: [
    link('Hub.md', 'A', 'A.md'), link('Hub.md', 'B', 'B.md'), link('Hub.md', 'C', 'C.md'),
    link('A.md', 'Hub', 'Hub.md'),                 // the reverse of an existing pair: collapsed
    link('A.md', 'Hub', 'Hub.md'),                 // written twice in one file: collapsed
    link('A.md', 'B', 'B.md'),
    link('pair/One.md', 'Two', 'pair/Two.md'),
    link('B.md', 'Nowhere', null),                 // unresolved: stored, never drawn
    link('C.md', 'C', 'C.md'),                     // a file linking to itself: no edge
    link('C.md', 'Gone', 'Gone.md'),               // resolves to a path the tree does not hold
    link('Hub.md', 'Lonely', 'Lonely.md', 'embed'), // an embed renders a file rather than linking it
  ],
};

describe('building the graph from the endpoint payload', () => {
  test('nodes come from the payload and edges only from links whose resolution is non-null, pairs collapsed', () => {
    const g = m.buildGraph(PAYLOAD);
    assert.deepStrictEqual(g.nodes.map(n => n.path), PAYLOAD.nodes.map(n => n.path), 'every node, in payload order');
    const pairs = g.edges.map(([a, b]) => [g.nodes[a].path, g.nodes[b].path].sort().join('<->')).sort();
    assert.deepStrictEqual(pairs, [
      'A.md<->B.md', 'A.md<->Hub.md', 'B.md<->Hub.md', 'C.md<->Hub.md', 'pair/One.md<->pair/Two.md',
    ], 'one edge per linked pair: unresolved, self, unknown-target and embed links draw nothing, and a pair written twice or in both directions is one edge');
  });

  test('degree counts the collapsed edges, so a pair linked both ways is degree one each way', () => {
    const g = m.buildGraph(PAYLOAD);
    const deg = Object.fromEntries(g.nodes.map(n => [n.path, n.degree]));
    assert.deepStrictEqual(deg, {
      'Hub.md': 3, 'A.md': 2, 'B.md': 2, 'C.md': 1, 'pair/One.md': 1, 'pair/Two.md': 1, 'Lonely.md': 0, 'inbox/Scratch.md': 0,
    });
    assert.strictEqual(g.stats.files, 8);
    assert.strictEqual(g.stats.edges, 5);
    assert.strictEqual(g.stats.unlinked, 2);
  });

  test('the adjacency answers neighbours in both directions', () => {
    const g = m.buildGraph(PAYLOAD);
    const idx = (p) => g.nodes.findIndex(n => n.path === p);
    assert.deepStrictEqual([...g.adjacency[idx('C.md')]].map(i => g.nodes[i].path), ['Hub.md']);
    assert.ok(g.adjacency[idx('Hub.md')].has(idx('C.md')));
    assert.strictEqual(g.adjacency[idx('Lonely.md')].size, 0);
  });
});

describe('detectCommunities: label propagation, deterministic given a seed', () => {
  // Two cliques of four, joined by one edge. Propagation should leave each
  // clique agreeing with itself and disagreeing with the other.
  const clique = (offset) => {
    const e = [];
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) e.push([offset + i, offset + j]);
    return e;
  };
  const EDGES = [...clique(0), ...clique(4), [3, 4]];

  test('identical input and seed give identical labels, call after call', () => {
    const a = m.detectCommunities(8, EDGES, { seed: 12345, iterations: 14 });
    const b = m.detectCommunities(8, EDGES, { seed: 12345, iterations: 14 });
    assert.deepStrictEqual(a, b, 'the sweep order is seeded, so the answer is a function of the input');
    assert.strictEqual(a.length, 8);
  });

  test('densely linked groups agree on a label and a single bridge does not merge them', () => {
    const lab = m.detectCommunities(8, EDGES, { seed: 12345, iterations: 14 });
    assert.strictEqual(new Set(lab.slice(0, 4)).size, 1, 'the first clique is one community');
    assert.strictEqual(new Set(lab.slice(4)).size, 1, 'the second clique is one community');
    assert.notStrictEqual(lab[0], lab[4], 'and they are two communities, not one');
  });

  test('a node with no neighbours keeps its own label', () => {
    const lab = m.detectCommunities(3, [[0, 1]], { seed: 1, iterations: 5 });
    assert.strictEqual(lab[2], 2);
  });

  test('the seed is part of the contract: an omitted seed is refused rather than defaulted to chance', () => {
    assert.throws(() => m.detectCommunities(3, [[0, 1]], {}), /seed/);
  });
});

describe('components: which nodes hang together at all', () => {
  test('two islands are two components with their sizes, and unlinked nodes belong to none', () => {
    const g = m.buildGraph(PAYLOAD);
    const c = m.components(g.nodes.length, g.edges, g.nodes.map(n => n.degree));
    const idx = (p) => g.nodes.findIndex(n => n.path === p);
    assert.strictEqual(c.rootOf[idx('Hub.md')], c.rootOf[idx('C.md')], 'the hub and its leaf share a component');
    assert.strictEqual(c.rootOf[idx('pair/One.md')], c.rootOf[idx('pair/Two.md')]);
    assert.notStrictEqual(c.rootOf[idx('Hub.md')], c.rootOf[idx('pair/One.md')]);
    assert.strictEqual(c.rootOf[idx('Lonely.md')], null, 'a degree-zero node is in no component');
    assert.deepStrictEqual(Object.values(c.size).sort((a, b) => b - a), [4, 2]);
  });
});

describe('assignAnchors: communities placed, small components in the band, the unlinked on the rim', () => {
  test('every degree-zero node is anchored at a radius beyond every linked node\'s anchor', () => {
    const g = m.buildGraph(PAYLOAD);
    const a = m.assignAnchors(g.nodes, g.edges, { seed: 12345 });
    const r = (p) => Math.hypot(p.ax, p.ay);
    const linked = g.nodes.map((n, i) => [n, a.anchors[i]]).filter(([n]) => n.degree > 0).map(([, p]) => r(p));
    const rim = g.nodes.map((n, i) => [n, a.anchors[i]]).filter(([n]) => n.degree === 0).map(([, p]) => r(p));
    assert.strictEqual(rim.length, 2);
    assert.ok(rim.every(rr => rr > Math.max(...linked)),
      `the rim (${rim.map(x => x.toFixed(1))}) sits beyond the furthest linked anchor (${Math.max(...linked).toFixed(1)})`);
    assert.ok(rim.every(rr => Math.abs(rr - a.rimRadius) < 1e-6), 'and at the stated rim radius');
  });

  test('anchors are typed: cluster, satellite or rim, and community ranks are recorded on cluster members', () => {
    const g = m.buildGraph(PAYLOAD);
    const a = m.assignAnchors(g.nodes, g.edges, { seed: 12345 });
    const kinds = Object.fromEntries(g.nodes.map((n, i) => [n.path, a.anchors[i].kind]));
    assert.strictEqual(kinds['Hub.md'], 'cluster');
    assert.strictEqual(kinds['pair/One.md'], 'satellite', 'a component that is not the giant one is a satellite');
    assert.strictEqual(kinds['Lonely.md'], 'rim');
    const hub = a.anchors[g.nodes.findIndex(n => n.path === 'Hub.md')];
    assert.strictEqual(typeof hub.communityRank, 'number');
    assert.ok(a.communities >= 1);
  });

  test('anchoring is deterministic: the same input twice gives the same positions', () => {
    const g = m.buildGraph(PAYLOAD);
    assert.deepStrictEqual(m.assignAnchors(g.nodes, g.edges, { seed: 7 }), m.assignAnchors(g.nodes, g.edges, { seed: 7 }));
  });

  test('a workspace with no edges at all still places everything on the rim, with no NaN', () => {
    const g = m.buildGraph({ indexed: true, nodes: [node('a.md'), node('b.md')], links: [] });
    const a = m.assignAnchors(g.nodes, g.edges, { seed: 1 });
    assert.ok(a.anchors.every(p => Number.isFinite(p.ax) && Number.isFinite(p.ay) && p.kind === 'rim'));
  });
});

describe('progressive disclosure: the degree threshold falls as the zoom rises', () => {
  const degrees = [40, 30, 20, 12, 9, 7, 5, 4, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1];
  const sorted = m.sortedDegrees(degrees.map(d => ({ degree: d })));

  test('at the fit zoom only the top slice of linked nodes clears the threshold', () => {
    const t = m.visibleThreshold(sorted, 1);
    assert.ok(t > 1, `the resting threshold (${t}) leaves most linked nodes for the zoom to reveal`);
  });

  test('the threshold is monotonically non-increasing in zoom and reaches every node', () => {
    let prev = Infinity;
    for (const z of [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 12]) {
      const t = m.visibleThreshold(sorted, z);
      assert.ok(t <= prev, `zoom ${z}: threshold ${t} does not rise above ${prev}`);
      prev = t;
    }
    assert.strictEqual(prev, 1, 'zoomed far enough in, the lowest linked degree is drawn');
  });

  test('zooming out past the fit never hides more than the fit does', () => {
    assert.strictEqual(m.visibleThreshold(sorted, 0.3), m.visibleThreshold(sorted, 1));
  });

  test('with no linked nodes the threshold is zero, so nothing is withheld', () => {
    assert.strictEqual(m.visibleThreshold([], 1), 0);
  });
});

describe('the one visibility predicate', () => {
  const g = m.buildGraph(PAYLOAD);
  const idx = (p) => g.nodes.findIndex(n => n.path === p);

  test('at rest: degree-zero nodes are always admitted, linked nodes only above the threshold', () => {
    const view = { threshold: 2, filter: null };
    assert.strictEqual(m.isVisible(g.nodes[idx('Hub.md')], idx('Hub.md'), view), true);
    assert.strictEqual(m.isVisible(g.nodes[idx('C.md')], idx('C.md'), view), false, 'a leaf below the threshold waits for the zoom');
    assert.strictEqual(m.isVisible(g.nodes[idx('Lonely.md')], idx('Lonely.md'), view), true, 'the rim is exempt: it is the silhouette');
  });

  test('with a filter: matches and their direct neighbours are admitted regardless of threshold, everything else is hidden', () => {
    const filter = m.applyFilter(g, 'c.md');
    const view = { threshold: 100, filter };
    assert.strictEqual(m.isVisible(g.nodes[idx('C.md')], idx('C.md'), view), true, 'the match, though far below the threshold');
    assert.strictEqual(m.isVisible(g.nodes[idx('Hub.md')], idx('Hub.md'), view), true, 'its neighbour, kept for context');
    assert.strictEqual(m.isVisible(g.nodes[idx('A.md')], idx('A.md'), view), false, 'a linked file two hops away is hidden');
    assert.strictEqual(m.isVisible(g.nodes[idx('Lonely.md')], idx('Lonely.md'), view), false, 'and so is the rim: a filter hides everything that does not answer it');
  });

  test('clearing the filter restores zoom disclosure', () => {
    assert.strictEqual(m.applyFilter(g, ''), null);
    assert.strictEqual(m.applyFilter(g, '   '), null);
    const view = { threshold: 2, filter: m.applyFilter(g, '') };
    assert.strictEqual(m.isVisible(g.nodes[idx('Lonely.md')], idx('Lonely.md'), view), true);
    assert.strictEqual(m.isVisible(g.nodes[idx('C.md')], idx('C.md'), view), false);
  });

  test('the hidden count is total nodes minus the nodes the predicate admits', () => {
    const view = { threshold: 2, filter: null };
    const admitted = g.nodes.filter((n, i) => m.isVisible(n, i, view)).length;
    assert.strictEqual(m.hiddenCount(g, view), g.nodes.length - admitted);
    assert.strictEqual(m.hiddenCount(g, view), 3, 'C, One and Two wait for the zoom');
  });
});

describe('keyword matching', () => {
  const g = m.buildGraph(PAYLOAD);
  test('matches case-insensitively over name and path', () => {
    assert.strictEqual(m.matchesKeyword(node('Docs/Plan.md'), 'PLAN'), true, 'name, any case');
    assert.strictEqual(m.matchesKeyword(node('Docs/Plan.md'), 'docs/'), true, 'path');
    assert.strictEqual(m.matchesKeyword(node('Docs/Plan.md'), 'roadmap'), false);
  });
  test('the filter result carries the matches and their neighbours separately, and the match count', () => {
    const f = m.applyFilter(g, 'PAIR');
    const paths = (s) => [...s].map(i => g.nodes[i].path).sort();
    assert.deepStrictEqual(paths(f.matched), ['pair/One.md', 'pair/Two.md']);
    assert.deepStrictEqual(paths(f.near), [], 'each is the other\'s match already, so nothing is only a neighbour');
    const h = m.applyFilter(g, 'hub');
    assert.deepStrictEqual(paths(h.matched), ['Hub.md']);
    assert.deepStrictEqual(paths(h.near), ['A.md', 'B.md', 'C.md']);
    assert.strictEqual(h.query, 'hub');
  });
});

describe('size encodes degree sub-linearly', () => {
  test('doubling the degree gains less than double the radius increment, and radius never falls with degree', () => {
    const inc = (d) => m.baseRadius(d) - m.baseRadius(0);
    assert.ok(inc(8) < 2 * inc(4), `increment at 8 (${inc(8)}) is less than twice the increment at 4 (${inc(4)})`);
    assert.ok(inc(64) < 2 * inc(32));
    let prev = -Infinity;
    for (let d = 0; d <= 200; d++) {
      const r = m.baseRadius(d);
      assert.ok(r >= prev, `radius at degree ${d} is not below degree ${d - 1}`);
      prev = r;
    }
  });

  test('zoom scales radius by an exponent below one, clamped at both ends', () => {
    assert.ok(m.ZOOM_EXPONENT > 0 && m.ZOOM_EXPONENT < 1);
    const atOne = m.radius(4, 1);
    const atFour = m.radius(4, 4);
    assert.ok(atFour > atOne && atFour < 4 * atOne, 'four times the zoom is bigger, and less than four times bigger');
    assert.strictEqual(m.radius(0, 0.0001), m.RADIUS_MIN, 'zoomed far out a node is still a visible speck');
    assert.strictEqual(m.radius(10000, 1000), m.RADIUS_MAX, 'zoomed far in a hub is a disc, not the whole pane');
  });

  test('a degree-zero node takes the smallest size in the scale, with no special case', () => {
    assert.strictEqual(m.baseRadius(0), m.baseRadius(0));
    assert.ok(m.baseRadius(0) < m.baseRadius(1));
  });
});

describe('recency: a rank in the workspace by modified time', () => {
  test('two workspaces whose modified times differ only by a constant offset yield identical ranks', () => {
    const times = [1000, 5000, 3000, null, 4000, 2000];
    const a = m.recencyRanks(times.map(t => ({ modified: t })));
    const b = m.recencyRanks(times.map(t => ({ modified: t === null ? null : t + 86400000 * 400 })));
    assert.deepStrictEqual(a, b);
  });

  test('the newest file ranks 1, the oldest 0, and a node with no modified time takes the middle rank', () => {
    const ranks = m.recencyRanks([{ modified: 10 }, { modified: 30 }, { modified: null }, { modified: 20 }]);
    assert.strictEqual(ranks[1], 1);
    assert.strictEqual(ranks[0], 0);
    assert.strictEqual(ranks[3], 0.5);
    assert.strictEqual(ranks[2], 0.5, 'unknown is neither new nor old');
  });

  test('ties in modified time share a rank, and one file alone ranks 1', () => {
    assert.deepStrictEqual(m.recencyRanks([{ modified: 5 }, { modified: 5 }]), [1, 1]);
    assert.deepStrictEqual(m.recencyRanks([{ modified: 5 }]), [1]);
    assert.deepStrictEqual(m.recencyRanks([{ modified: null }]), [0.5]);
  });

  test('five discrete steps by rank band: 5, 15, 30, 30 and 20 percent', () => {
    assert.strictEqual(m.recencyStep(1), 1);
    assert.strictEqual(m.recencyStep(0.96), 1);
    assert.strictEqual(m.recencyStep(0.9), 2);
    assert.strictEqual(m.recencyStep(0.6), 3);
    assert.strictEqual(m.recencyStep(0.5), 3, 'the middle rank, where an unknown time lands, is the neutral step');
    assert.strictEqual(m.recencyStep(0.3), 4);
    assert.strictEqual(m.recencyStep(0.1), 5);
    assert.strictEqual(m.recencyStep(0), 5);
    assert.deepStrictEqual(m.RECENCY_STEPS, [1, 2, 3, 4, 5]);
  });
});

describe('labels on hover only', () => {
  const g = m.buildGraph(PAYLOAD);
  const idx = (p) => g.nodes.findIndex(n => n.path === p);
  test('with no hover the label list is empty', () => {
    assert.deepStrictEqual(m.labelList(g, null, () => true), []);
  });
  test('with a hover it holds the hovered node plus its visible neighbours, and nothing else', () => {
    const view = { threshold: 3, filter: null };
    const visible = (i) => m.isVisible(g.nodes[i], i, view);
    const labels = m.labelList(g, idx('Hub.md'), visible).map(i => g.nodes[i].path).sort();
    assert.deepStrictEqual(labels, ['Hub.md'], 'every neighbour of the hub is below the threshold, so only the hub is named');
    const wide = m.labelList(g, idx('Hub.md'), () => true).map(i => g.nodes[i].path).sort();
    assert.deepStrictEqual(wide, ['A.md', 'B.md', 'C.md', 'Hub.md']);
    assert.strictEqual(m.labelList(g, idx('Hub.md'), () => true)[0], idx('Hub.md'), 'the hovered node leads the list');
  });
});

describe('hit-testing consults the same predicate as drawing', () => {
  const g = m.buildGraph(PAYLOAD);
  const idx = (p) => g.nodes.findIndex(n => n.path === p);
  // Every node on a distinct screen point, so a hit is unambiguous.
  const screen = g.nodes.map((n, i) => [100 + i * 50, 100]);

  test('a node the predicate hides is not found at its exact screen position', () => {
    const c = idx('C.md');
    const hidden = { threshold: 2, filter: null };
    assert.strictEqual(m.isVisible(g.nodes[c], c, hidden), false, 'sanity: C is hidden at this zoom');
    const hit = m.hitTest(g, screen, screen[c][0], screen[c][1], (i) => m.isVisible(g.nodes[i], i, hidden), () => 4);
    assert.strictEqual(hit, null, 'hidden means hidden, including to the cursor');
  });

  test('the same node at the same point is found once the predicate admits it', () => {
    const c = idx('C.md');
    const shown = { threshold: 1, filter: null };
    const hit = m.hitTest(g, screen, screen[c][0], screen[c][1], (i) => m.isVisible(g.nodes[i], i, shown), () => 4);
    assert.strictEqual(hit, c);
  });

  test('a point near nothing hits nothing, and the nearest of two candidates wins', () => {
    assert.strictEqual(m.hitTest(g, screen, 5000, 5000, () => true, () => 4), null);
    // Two candidates close enough that a point between them is inside the
    // slop of both, nearer the second: the nearer wins.
    const close = screen.map(([x, y], i) => (i < 2 ? [100 + i * 20, y] : [x, y]));
    const between = close[1][0] - 8;
    assert.ok(between - close[0][0] - 4 < m.HIT_SLOP, 'sanity: the first candidate is also within reach');
    assert.strictEqual(m.hitTest(g, close, between, 100, () => true, () => 4), 1);
  });
});

describe('bounds and fit', () => {
  test('the fit uses the 1st and 99th percentile, so a far outlier does not dictate the frame', () => {
    const xs = [];
    for (let i = 0; i < 200; i++) xs.push([i, 0]);
    xs.push([100000, 0]);
    const b = m.bounds(xs, () => 1);
    assert.ok(b.maxX < 1000, `the outlier at 100000 is outside the frame (maxX ${b.maxX})`);
    assert.ok(b.minX <= 1 && b.minX >= -1);
  });

  test('non-finite positions yield a non-finite result rather than a substituted value', () => {
    const b = m.bounds([[0, 0], [Infinity, 3], [2, 2]], () => 1);
    assert.ok(!Number.isFinite(b.maxX) || !Number.isFinite(b.minX), 'a diverged layout is reported, not patched');
    const n = m.bounds([[0, 0], [NaN, 3]], () => 1);
    assert.ok(!Number.isFinite(n.minX) || !Number.isFinite(n.maxX));
    assert.strictEqual(m.fitTransform(b, 800, 600), null, 'and no transform is invented for it');
  });

  test('an empty layout has non-finite bounds and no fit', () => {
    const b = m.bounds([], () => 1);
    assert.ok(!Number.isFinite(b.minX));
    assert.strictEqual(m.fitTransform(b, 800, 600), null);
  });

  test('a finite layout fits inside the pane with padding and never beyond the zoom cap', () => {
    const b = m.bounds([[-100, -50], [100, 50]], () => 2);
    const t = m.fitTransform(b, 800, 600);
    assert.ok(t.k > 0 && t.k <= m.FIT_MAX_ZOOM);
    const toScreen = (x, y) => [x * t.k + t.tx, y * t.k + t.ty];
    const [cx, cy] = toScreen(0, 0);
    assert.ok(Math.abs(cx - 400) < 1e-6 && Math.abs(cy - 300) < 1e-6, 'the middle of the bounds lands in the middle of the pane');
    const [lx] = toScreen(-102, 0);
    assert.ok(lx >= m.FIT_PADDING - 1e-6, 'the left edge clears the padding');
  });
});

describe('zoom anchored on the cursor', () => {
  test('the world point under the cursor is the same point after the zoom', () => {
    const t = { k: 1.5, tx: 40, ty: -20 };
    const mx = 233, my = 171;
    const worldBefore = [(mx - t.tx) / t.k, (my - t.ty) / t.k];
    const z = m.zoomAt(t, 1.7, mx, my);
    const worldAfter = [(mx - z.tx) / z.k, (my - z.ty) / z.k];
    assert.ok(Math.abs(worldBefore[0] - worldAfter[0]) < 1e-9 && Math.abs(worldBefore[1] - worldAfter[1]) < 1e-9);
    assert.ok(Math.abs(z.k - 1.5 * 1.7) < 1e-12);
  });
  test('the scale is clamped at both ends', () => {
    assert.strictEqual(m.zoomAt({ k: 1, tx: 0, ty: 0 }, 1e9, 0, 0).k, m.ZOOM_MAX);
    assert.strictEqual(m.zoomAt({ k: 1, tx: 0, ty: 0 }, 1e-9, 0, 0).k, m.ZOOM_MIN);
  });
  test('a wheel delta maps to a factor: away from the reader zooms out, toward zooms in', () => {
    assert.ok(m.wheelZoomFactor(50) < 1);
    assert.ok(m.wheelZoomFactor(-50) > 1);
    assert.strictEqual(m.wheelZoomFactor(0), 1);
  });
  test('a drag past a small threshold is not a click', () => {
    assert.strictEqual(m.dragIsClick(0), true);
    assert.strictEqual(m.dragIsClick(m.CLICK_SLOP), true);
    assert.strictEqual(m.dragIsClick(m.CLICK_SLOP + 1), false);
  });
});

describe('compositing per theme', () => {
  test('edges composite with lighter on the dark ground and source-over on the light one', () => {
    assert.strictEqual(m.edgeComposite(false), 'lighter');
    assert.strictEqual(m.edgeComposite(true), 'source-over');
  });
});

describe('the readout', () => {
  const g = m.buildGraph(PAYLOAD);
  test('at rest it counts files and connections and states the hidden count with the phrase that zoom reveals them', () => {
    const view = { threshold: 2, filter: null };
    const r = m.readout(g, view, null);
    assert.strictEqual(r.strong, '8');
    assert.match(r.rest, /^ files · 5 connections/);
    assert.match(r.rest, /3 hidden, zoom to reveal/);
  });
  test('with nothing hidden the phrase is absent', () => {
    const r = m.readout(g, { threshold: 1, filter: null }, null);
    assert.ok(!/hidden/.test(r.rest));
  });
  test('with a filter it states the match count and the connected count', () => {
    const r = m.readout(g, { threshold: 100, filter: m.applyFilter(g, 'hub') }, null);
    assert.strictEqual(r.strong, '1');
    assert.match(r.rest, /matching “hub” · 3 connected/);
  });
  test('a filter that matches nothing says so, so an empty canvas reads as an answer', () => {
    const r = m.readout(g, { threshold: 100, filter: m.applyFilter(g, 'zzz') }, null);
    assert.strictEqual(r.strong, 'No files');
    assert.match(r.rest, /match “zzz”/);
  });
  test('with a hover it names the file and its connections', () => {
    const hub = g.nodes.findIndex(n => n.path === 'Hub.md');
    assert.deepStrictEqual(m.readout(g, { threshold: 1, filter: null }, hub), { strong: 'Hub.md', rest: ' · 3 connections' });
    const c = g.nodes.findIndex(n => n.path === 'C.md');
    assert.deepStrictEqual(m.readout(g, { threshold: 1, filter: null }, c), { strong: 'C.md', rest: ' · 1 connection' });
  });
  test('the warming and no-index statements are the model\'s words', () => {
    assert.match(m.WARMING.title, /still being indexed/i);
    assert.match(m.NO_INDEX.title + ' ' + m.NO_INDEX.body, /search index/i);
    assert.match(m.NOTHING_LINKED.title, /Nothing is linked yet/);
  });
});

describe('layout parameters follow the three levers', () => {
  test('repulsion is bounded in range and grows with degree', () => {
    assert.ok(Number.isFinite(m.CHARGE_DISTANCE_MAX) && m.CHARGE_DISTANCE_MAX > 0);
    assert.ok(m.chargeStrength(10) < m.chargeStrength(1) && m.chargeStrength(1) < 0, 'more negative for a hub');
  });
  test('link distance grows with the endpoints\' degree, sub-linearly', () => {
    const d = (a, b) => m.linkDistance({ degree: a }, { degree: b });
    assert.ok(d(1, 1) < d(10, 10) && d(10, 10) < d(40, 40));
    assert.ok(d(40, 40) - d(1, 1) < 39 * (d(2, 2) - d(1, 1)) * 2);
  });
  test('collision keeps a margin beyond the drawn radius', () => {
    assert.ok(m.collideRadius({ degree: 3 }) > m.baseRadius(3));
  });
  test('a bigger graph cools for longer', () => {
    assert.ok(m.alphaDecay(4000) < m.alphaDecay(200));
    assert.ok(m.alphaDecay(4000) > 0);
  });
  test('the rim is held by a radial force at the rim radius and cluster members by their anchors; no global centre', () => {
    assert.ok(m.anchorStrength('rim') > 0 && m.anchorStrength('cluster') > 0 && m.anchorStrength('satellite') > 0);
    assert.strictEqual(m.CENTER_FORCE, null, 'no compensating centre force: the fit pass frames the picture instead');
  });
});
