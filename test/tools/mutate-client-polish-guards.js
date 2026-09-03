#!/usr/bin/env node
'use strict';
// Break each of the client-polish guards in turn and report which tests
// notice.
//
// The rules this lane leaves behind are one-line decisions that a later tidy
// could silently reverse: the escaper that covers quotes, the scope row that
// is a real button, the instructions and callout bodies that render through
// the one pipeline, the ownership rule over view containers, and the caret
// that is designed rather than defaulted. Each is broken here on purpose and
// a focused test must go red for it, or the rule is a comment wearing a
// guard's clothes.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-client-polish-guards.js            # report
//   node test/tools/mutate-client-polish-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as its siblings and is deliberately a
// separate copy rather than a shared module, for the reason stated there:
// pulling them together means editing an instrument already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const SUITE = 'test/unit/client-polish.test.js';
// The shell, where the shared escaper and the instructions helper live.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: SUITE };
// The panel, whose scope rows must stay real buttons.
const PANEL = { src: path.join(ROOT, 'public', 'views', 'routines-panel.js'), suite: SUITE };
// The callout node, whose body renders through the pipeline.
const CALLOUT = { src: path.join(ROOT, 'public', 'editor', 'nodes', 'callout.js'), suite: SUITE };
// The style gate, whose ownership rule must keep biting.
const DRIFT = { src: path.join(ROOT, 'test', 'tools', 'style-drift.js'), suite: SUITE };
// The editor stylesheet, where the caret is designed.
const CSS = { src: path.join(ROOT, 'public', 'styles', 'views', 'editor.css'), suite: SUITE };

const MUTATIONS = [
  // ===== THE ESCAPING DECISION =====
  // Put the DOM-based escaper back and quotes pass through again, which is a
  // value in an attribute position holding the attribute open.
  [APP, 'esc escapes quotes as well as angle brackets',
    "function esc(t){return String(t==null?'':t).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;').replace(/'/g,'&#39;');}",
    "function esc(t){const d=document.createElement('div');d.textContent=t==null?'':t;return d.innerHTML;}"],

  // ===== THE SCOPE ROW IS A CONTROL =====
  // Put the costume div back and the keyboard stops working, with every click
  // test still green: exactly the drift the button rule exists to stop.
  [PANEL, 'a scope row is a real button',
    '  return `<button type="button" class="scope-item${row.active ? \' active\' : \'\'}" data-scope="${escA(row.id)}"`',
    '  return `<div role="button" tabindex="0" class="scope-item${row.active ? \' active\' : \'\'}" data-scope="${escA(row.id)}"`'],

  // ===== INSTRUCTIONS THROUGH THE PIPELINE =====
  // Route the helper around the pipeline and both surfaces fall back to
  // escaped syntax: readable to nobody, which was the card.
  [APP, 'instructions render through the shared pipeline',
    "  if (typeof renderMarkdown === 'function') return renderMarkdown(String(text == null ? '' : text));",
    '  if (false) return null;'],

  // ===== CALLOUT BODIES THROUGH THE PIPELINE =====
  // Sever the pipeline lookup and every body renders as plain lines again,
  // asterisks and all.
  [CALLOUT, 'a callout body renders its own markdown',
    "  const pipeline = (typeof window !== 'undefined' && typeof window.renderMarkdown === 'function')\n    ? window.renderMarkdown : null;",
    '  const pipeline = null;'],

  // ===== LAYOUT OWNERSHIP =====
  // Remove the ownership comparison and the incident line passes the gate in
  // silence, which is the day this rule was written.
  [DRIFT, 'a view container may only be styled by its own stylesheet',
    '      if (rel !== owner) out.push({ file: rel, line: i + 1, selector: m[0], owner });',
    '      if (false) out.push({ file: rel, line: i + 1, selector: m[0], owner });'],

  // ===== THE DESIGNED CARET =====
  // Shrink the caret back to the old scale and the control reads as the
  // browser leftover the card complained about.
  [CSS, 'the disclosure caret takes the title scale',
    'font-size: var(--title); line-height: 1; display: inline-flex;',
    'font-size: var(--org-role); line-height: 1; display: inline-flex;'],
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
    throw new Error(
      'the suite failed but its output carries no "failing tests:" summary, so no '
      + 'test names could be read. The spec reporter\'s format is what this parses; '
      + 'if it changed, fix this parser rather than trusting the empty result.');
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [APP, PANEL, CALLOUT, DRIFT, CSS];
  // Two targets share lib/scheduler.js (watched by different suites), so the
  // session is opened on the deduplicated file list.
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
      results.push({ label, applied: true, red: redTests(target.suite) });
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
  for (const { label, applied, red, ambiguous } of results) {
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
