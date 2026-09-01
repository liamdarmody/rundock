#!/usr/bin/env node
'use strict';
// Take the atomic write primitive's guards apart one at a time and report
// which tests notice. A transaction primitive is exactly the code whose tests
// can go green while the property they name has been deleted: the happy path
// writes every file whether or not the journal, the backups or the rollback
// exist, so every recovery guard here is proven by breaking it.
//
//   node test/tools/mutate-atomic-write-guards.js            # report
//   node test/tools/mutate-atomic-write-guards.js --markdown # as a table
//
// The harness is the same shape as mutate-workspace-rollback-guards.js and is
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

const PRIMITIVE = {
  src: path.join(ROOT, 'lib', 'workspace', 'atomic-write.js'),
  suite: 'test/unit/atomic-write.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  [PRIMITIVE, 'the preparation journal is written before any staging or backup work',
    "  createJournal(root, journal);\n  try {",
    '  try {'],
  [PRIMITIVE, 'the journal is created exclusively, so an existing journal blocks a second write',
    ", { flag: 'wx' }",
    ''],
  [PRIMITIVE, 'every existing destination is backed up before the commit boundary',
    '      if (entry.priorType === \'file\') fs.cpSync(entry.destination, backupPath(root, slot));\n'
    + '      if (entry.priorType === \'dir\') fs.cpSync(entry.destination, backupPath(root, slot), { recursive: true });\n',
    ''],
  [PRIMITIVE, 'the journal turns committing before the first destination mutation',
    "    journal.phase = 'committing';\n    writeJournal(root, journal);\n",
    ''],
  [PRIMITIVE, 'a destination failure rolls the completed writes back',
    '    try {\n      undoFromJournal(root, journal);\n    } catch (rollbackFailure) {\n      rollbackFailure.cause = commitFailure;\n      throw rollbackFailure;\n    }\n',
    ''],
  [PRIMITIVE, 'a journal that does not parse is refused rather than ignored',
    "    throw invalidJournal('malformed JSON');",
    '    return null;'],
  [PRIMITIVE, 'a journal from an unsupported version is refused',
    '  if (journal.version !== JOURNAL_VERSION) throw invalidJournal(`unsupported version ${JSON.stringify(journal.version)}`);\n',
    ''],
  [PRIMITIVE, 'the directories a run creates are recorded for recovery to remove',
    '    createdDirs: plannedParents(root, entries),',
    '    createdDirs: [],'],
];

// Guards deliberately NOT mutated, each with the reason. A named exclusion is
// a decision; an unnamed one is a harness that quietly checks less than it
// claims.
const NOT_MUTATED = [
  {
    what: 'the boundary validations in normalisePlan',
    why: 'each one is asserted directly by a rejection test that also compares the whole tree, '
      + 'so deleting any of them turns its named test red by construction. The mutations here '
      + 'are reserved for the recovery guards, whose tests could plausibly pass while the guard '
      + 'is gone, which is the failure this instrument exists to rule out.',
  },
  {
    what: "recovery's assertRestorable preflight",
    why: 'the missing-backup and wrong-type tests assert its exact refusal messages and the '
      + 'untouched tree, so its deletion is red by the same construction. It is also the guard '
      + 'whose mutation would make the backup-set mutation above ambiguous: with the preflight '
      + 'gone, both mutations turn the same recovery tests red for the same reason.',
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
  const targets = [PRIMITIVE];
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
      // first, for the reason set out in mutate-workspace-rollback-guards.js:
      // String.replace would break whichever copy came first and report on
      // whatever that turned red.
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

// Refuse to start on a machine that would misreport, for the reason the other
// mutation harnesses give: a full temp disk surfaces as red tests, which is
// exactly what this instrument reports as an unguarded guard.
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
