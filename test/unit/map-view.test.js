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
    const app = at('/app.js');
    assert.ok(force < app, 'the layout library loads before the client that reaches for it');
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
