#!/usr/bin/env node
'use strict';
// Break each of the link rules in turn and report which tests notice.
//
// One resolver decides what a link means, an index stores what a file says, an
// endpoint resolves at read time, and a list under a file names what a click
// would open. Every one of those rules can be deleted with the product still
// drawing SOMETHING, which is why each is broken on purpose here and a test
// must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-map-foothold-guards.js            # report
//   node test/tools/mutate-map-foothold-guards.js --markdown # the same, as a table
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

const FILES = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/map-foothold.test.js' };
const SEARCH = { src: path.join(ROOT, 'search.js'), suite: 'test/unit/map-foothold.test.js' };
const ROUTER = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: 'test/unit/map-foothold.test.js' };

const MUTATIONS = [
  // ===== EXACT PATH FIRST, ACROSS THE WHOLE TREE =====
  // Blind the exact-path branch and a fully qualified link falls back to the
  // basename rule, which is the wrong-file defect this lane removes.
  [FILES, 'an exact path match beats every basename match',
    "        if (item.path.toLowerCase() === searchLower) {",
    "        if (false && item.path.toLowerCase() === searchLower) {"],
  // Invert the depth half of the tie rule and a bare name resolves to the
  // most nested candidate instead of the least.
  [FILES, 'basename ties break to the shortest path first',
    "          if (!best || depth < best.depth || (depth === best.depth && at < best.at)) {",
    "          if (!best || depth > best.depth || (depth === best.depth && at < best.at)) {"],
  // Invert the order half and equal-depth ties stop being deterministic in
  // the tree's own order.
  [FILES, 'equal-depth ties break to tree order',
    "(depth === best.depth && at < best.at)",
    "(depth === best.depth && at > best.at)"],
  // Always append the default extension and an image link chases a phantom
  // markdown sibling, on every surface at once because there is one copy.
  [FILES, 'the extension defaults only when the target names none',
    "  return VIEWABLE_LINK_EXT_RE.test(baseName) ? baseName : baseName + '.md';",
    "  return baseName + '.md';"],
  // Count embeds as links and the connections list claims a file links to
  // everything it merely displays.
  [FILES, 'an embed renders a file rather than linking to it',
    "    if (link.kind === 'embed') continue;",
    ""],

  // ===== THE INDEX LIVES AND DIES WITH ITS FILE =====
  // Drop the links half of the removal and edges survive the file they point
  // out of.
  [SEARCH, 'a removed file takes its links with it',
    "    const del = (rel) => { delFileRow.run(rel); delLinkRows.run(rel); };",
    "    const del = (rel) => { delFileRow.run(rel); };"],
  // Merge instead of replace and yesterday's edges outlive a re-index.
  [SEARCH, 'a re-index replaces a file\'s links rather than accumulating them',
    "    this._delLinks.run(rel);",
    ""],

  // ===== THE ENDPOINT READS THE TREE THE SERVER HOLDS =====
  // Resolve against nothing and every link comes back unresolved: the test
  // that pins resolved paths is what notices the cached tree went unread.
  [ROUTER, 'resolution runs against the cached tree',
    "      const tree = deps.getFileTreeCached() || [];",
    "      const tree = [];"],
  // Report an absent index as an indexed empty workspace and a consumer
  // cannot tell a runtime without sqlite from a workspace with no links.
  [ROUTER, 'no index is a statement, not an empty graph',
    "        res.end(JSON.stringify({ indexed: false, links: [] }));",
    "        res.end(JSON.stringify({ indexed: true, links: [] }));"],
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
  const targets = [FILES, SEARCH, ROUTER];
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
