#!/usr/bin/env node
'use strict';
// Take the plan construction's guards apart one at a time and report which
// tests notice. A plan that quietly offers less than the package holds, or
// promises digests derived differently from how apply verifies them, is how
// content escapes review; each of those refusals is proven by breaking it.
//
//   node test/tools/mutate-import-plan-guards.js            # report
//   node test/tools/mutate-import-plan-guards.js --markdown # as a table
//
// The harness is the same shape as mutate-import-apply-guards.js and is
// deliberately a second copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a change is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const PLAN = {
  src: path.join(ROOT, 'lib', 'packages', 'import-plan.js'),
  suite: 'test/unit/package-import-plan-v2.test.js',
};
// The decision contract's own home since it was shared with the browser; the
// plan suite still owns its evidence, so the mutation follows the code.
const DECIDE = {
  src: path.join(ROOT, 'public', 'packages-decide.js'),
  suite: 'test/unit/package-import-plan-v2.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  [PLAN, 'the manifest sort cannot be inverted',
    "  return entries.sort((a, b) => (a.id < b.id ? -1 : 1));",
    "  return entries.sort((a, b) => (a.id < b.id ? 1 : -1));"],
  [PLAN, 'the manifest sort cannot be removed outright',
    "  return entries.sort((a, b) => (a.id < b.id ? -1 : 1));",
    '  return entries;'],
  [PLAN, 'an empty package is a refusal, not an empty plan',
    "  if (entries.length === 0) refuse('the package contains no agents and no skills', 'empty-package');\n",
    ''],
  [PLAN, 'the approved digest comes from the provenance-transformed bytes',
    "        approvedText = withProvenance(sourceAgentText(itemPath(sourceRoot, 'agent', slug)), source.id);",
    "        approvedText = sourceAgentText(itemPath(sourceRoot, 'agent', slug));"],
  [PLAN, 'the collision fact is derived from the live destination',
    '    const collision = plannedDigest !== ABSENT_DIGEST;',
    '    const collision = false;'],
  [DECIDE, "a skipped agent's default state collapses onto the planned one",
    '          approvedDefault: skip ? item.agent.plannedDefault : item.agent.approvedDefault,',
    '          approvedDefault: item.agent.approvedDefault,'],
  [PLAN, 'a non-slug agent name is refused, never silently dropped',
    "    if (!entry.name.endsWith('.md') || !SLUG.test(entry.name.slice(0, -3))) {\n"
    + "      refuse(`agents/${entry.name} is not a canonical agent file name`);\n"
    + '    }\n',
    "    if (!entry.name.endsWith('.md')) continue;\n"],
];

// Guards deliberately NOT mutated, each with the reason.
const NOT_MUTATED = [
  {
    what: 'the duplicate-id case in the manifest',
    why: 'manifest ids derive from unique directory entries, so no input can produce a duplicate '
      + 'and no check exists to mutate; recorded in criteria amendment A1 rather than as a green row.',
  },
];

const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

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
  const targets = [PLAN, DECIDE];
  const session = beginMutationRun({ files: targets.map((target) => target.src) });
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
      // A guard that matches more than once is refused rather than taking the
      // first, for the reason set out in the sibling harnesses.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      results.push({ label, applied: true, matches, red: redTests(target.suite) });
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
  for (const { label, applied, red, ambiguous, matches } of results) {
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | ${ambiguous} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | 0 | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | ${matches} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${matches} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  found in ${matches} place\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Places found | Tests red | Which |');
    console.log('|---|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

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

module.exports = { MUTATIONS, NOT_MUTATED, run };
