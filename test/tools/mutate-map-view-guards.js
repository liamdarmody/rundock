#!/usr/bin/env node
'use strict';
// Break each of the map's rules in turn and report which tests notice.
//
// One visibility predicate decides what is on screen; the rim is exempt
// from disclosure; communities are seeded; unresolved links draw nothing;
// both wheel branches keep the gesture in the pane; the payload says when
// the index is warming; leaving removes what arriving added. Every one of
// those rules can be deleted with the map still drawing SOMETHING, which is
// why each is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-map-view-guards.js            # report
//   node test/tools/mutate-map-view-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = { src: path.join(ROOT, 'public', 'graph-model.js'), suite: 'test/unit/graph-model.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'graph.js'), suite: 'test/unit/map-view.test.js' };
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/map-view.test.js' };
const ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/map-foothold.test.js' };
const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/map-foothold.test.js' };
// The model's rim rule is watched from the view's side as well, because the
// view is where a rim that stops being exempt would first be seen.
const MODEL_VIA_VIEW = { src: path.join(ROOT, 'public', 'graph-model.js'), suite: 'test/unit/map-view.test.js' };

const MUTATIONS = [
  // ===== ONE VISIBILITY PREDICATE =====
  // Hit-test every node regardless of what is drawn and hovering empty space
  // surfaces files that are not on screen: the defect the prototype had.
  [VIEW, 'hit-testing consults the shared visibility predicate',
    "      return model.hitTest(graph, N.map(screenOf), mx, my, (i) => model.isVisible(graph.nodes[i], i, v), radiusOf);",
    "      return model.hitTest(graph, N.map(screenOf), mx, my, () => true, radiusOf);"],
  // Drop the rim exemption and unlinked files vanish at the fit zoom, taking
  // the map's silhouette with them.
  [MODEL, 'degree-zero nodes are exempt from zoom disclosure',
    "    return node.degree === 0 || node.degree >= view.threshold;",
    "    return node.degree >= view.threshold;"],
  [MODEL_VIA_VIEW, 'the rim stays on screen at the fit zoom, as the view draws it',
    "    return node.degree === 0 || node.degree >= view.threshold;",
    "    return node.degree >= view.threshold;"],
  // Count what is drawn by a second rule and the readout's hidden count
  // stops being total minus admitted.
  [MODEL, 'the hidden count is total nodes minus the nodes the predicate admits',
    "    return graph.nodes.length - shown;",
    "    return graph.stats.unlinked;"],

  // ===== COMMUNITIES ARE SEEDED =====
  // Let the seed be omitted and the layout differs on every open, which is
  // the defect the seed exists to stop.
  [MODEL, 'the community seed is part of the contract',
    "    if (!opts || typeof opts.seed !== 'number') throw new Error('detectCommunities needs a numeric seed');",
    "    if (!opts) opts = {}; if (typeof opts.seed !== 'number') opts = { ...opts, seed: Date.now() };"],

  // ===== EDGES COME ONLY FROM RESOLVED LINKS =====
  // Invert the exclusion and the map draws exactly the links that point at
  // nothing.
  [MODEL, 'an unresolved link draws nothing',
    "      if (!link || link.resolved == null) continue;",
    "      if (!link || link.resolved != null) continue;"],
  // Count both directions and a pair linked both ways is two edges.
  [MODEL, 'a pair written twice or in both directions is one edge',
    "      if (seen.has(key)) continue;",
    ""],

  // ===== SIZE, RECENCY, LABELS =====
  [MODEL, 'zoom scales the radius by an exponent below one',
    "  const ZOOM_EXPONENT = 0.55;",
    "  const ZOOM_EXPONENT = 1;"],
  [MODEL, 'a node with no modified time takes the middle rank',
    "      if (typeof n.modified !== 'number' || !Number.isFinite(n.modified)) return 0.5;",
    "      if (typeof n.modified !== 'number' || !Number.isFinite(n.modified)) return 0;"],
  // Name every node when nothing is hovered and the map at rest is a smear.
  [VIEW, 'labels are drawn on hover only, from the model\'s list',
    "      const labels = model.labelList(graph, hover, vis);",
    "      const labels = hover === null ? N.map((n) => n.i) : model.labelList(graph, hover, vis);"],

  // ===== THE WHEEL STAYS IN THE PANE =====
  // Prevent the default in the pinch branch only and a two-finger scroll
  // pans the whole page as well as the map.
  [VIEW, 'the second wheel branch prevents default too',
    "      ev.preventDefault();\n      if (ev.ctrlKey) {",
    "      if (ev.ctrlKey) {\n        ev.preventDefault();"],
  // Zoom about the pane's centre and zooming into a cluster is a chase.
  [VIEW, 'pinch zoom is anchored on the cursor',
    "        t = model.zoomAt(t, model.wheelZoomFactor(ev.deltaY), mx, my);",
    "        t = model.zoomAt(t, model.wheelZoomFactor(ev.deltaY), W / 2, H / 2);"],
  // Treat every mouseup as a click and a pan opens whatever it ends on.
  [VIEW, 'a drag past the threshold is not a click',
    "      if (!model.dragIsClick(dragMoved)) { dragMoved = 0; return; }",
    "      dragMoved = 0;"],

  // ===== COLOUR COMES FROM THE STYLESHEET, PER THEME =====
  [VIEW, 'edges composite additively only on the dark ground',
    "      const composite = model.edgeComposite(isLight);",
    "      const composite = model.edgeComposite(false);"],
  [VIEW, 'the palette is re-read when the theme changes',
    "    themeObserver = new MutationObserver(() => { if (current) current.repaint(); });",
    "    themeObserver = new MutationObserver(() => {});"],

  // ===== THE THIRD STATE =====
  // Collapse warming into indexed:true and a half-filled index reads as a
  // workspace with few links.
  [ROUTER, 'the payload says warming while the warm-up is in flight',
    "      const warming = !!deps.fileIndexInProgress();",
    "      const warming = false;"],
  [VIEW, 'a warming payload draws the still-being-indexed statement',
    "    if (payload.warming) { setMessage(model.WARMING.title, model.WARMING.body); return; }",
    ""],
  [VIEW, 'the index reporting ready is news only for an active map',
    "    if (active) arrive();",
    "    arrive();"],
  [FILES, 'an empty group during warm-up says links are still being indexed',
    "    if (!rows.length) { note(data.warming ? 'Links are still being indexed' : 'None'); return; }",
    "    if (!rows.length) { note('None'); return; }"],
  [APP, 'ready, and only ready, redraws both surfaces',
    "      if(d.subtype==='search_index' && d.state==='ready') {",
    "      if(d.subtype==='search_index') {"],

  // ===== LEAVING REMOVES WHAT ARRIVING ADDED =====
  [VIEW, 'leaving removes the resize listener it added',
    "        window.removeEventListener('resize', onResize);",
    ""],
  [VIEW, 'leaving stops the simulation',
    "        sim.stop();\n        if (raf !== null) { cancelAnimationFrame(raf); raf = null; }",
    "        if (raf !== null) { cancelAnimationFrame(raf); raf = null; }"],
  [VIEW, 'a fetch that lands after the reader has left draws nothing',
    "        if (ticket !== arrival) return; // the reader left, or arrived again\n",
    ""],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [MODEL, VIEW, APP, ROUTER, FILES, MODEL_VIA_VIEW];
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
