#!/usr/bin/env node
'use strict';
// Take the failed-switch rollback apart a step at a time and report which
// tests notice.
//
// WHY THIS EXISTS AS A FILE RATHER THAN AS A CLAIM IN A REPORT
//
// This exists because the rollback was BELIEVED to work and nothing proved
// it. The only test covering it stubbed the arming call to
// a counter, so it proved the call site was reached and nothing about whether
// polling still worked against the workspace rolled back to. A report saying
// "I deleted the re-arm and a test went red" is the same kind of evidence: it
// is a claim about a tree nobody else can identify. This is that deletion,
// written down so anyone can run it.
//
// THE ONE THIS FILE EXISTS FOR. The rollback's last step re-arms the file-tree
// poll. It is the newest and least proven step of the three and it sits last
// precisely so a throw in it cannot skip the two before it. Deleting it leaves
// the poll baselined against the workspace that failed to open, so a workspace
// nobody touched announces itself on the next tick.
//
// AND THE TWO STEPS BESIDE IT, because a mutation aimed at one guard proves
// nothing about its neighbours, and the rollback is a block that shares one
// catch. Restoring the root is what the whole rollback is for; clearing the
// caches is what stops the previous workspace being served the failed one's
// agents and files.
//
//   node test/tools/mutate-workspace-rollback-guards.js            # report
//   node test/tools/mutate-workspace-rollback-guards.js --markdown # as a table
//
// The file is restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routines-guards.js and is
// deliberately a second copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a change is how a gate quietly stops
// checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The handler that guards the open path and rolls it back, watched by the file
// that drives a real open failure through the real server and then measures
// the poll on the wire. Watched from anywhere else, these lines can be deleted
// with every test green.
const HANDLER = {
  src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'),
  suite: 'test/integration/workspace-rollback-poll.test.js',
};

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // THE ONE THIS FILE EXISTS FOR.
  [HANDLER, 'the rollback re-arms the file-tree poll against the workspace that survived',
    '      ctx.workspace.armFileTreeWatcher();\n    } catch (rollbackErr)',
    '    } catch (rollbackErr)'],
  // The step the whole rollback is for.
  [HANDLER, 'the rollback puts the previous root back',
    '      ctx.workspace.setWorkspaceRoot(previousRoot);\n',
    ''],
  // A failure that is swallowed leaves the client with no reply at all, which
  // is the state this whole guard was written to end.
  [HANDLER, 'a switch that could not complete says so',
    "    ws.send(JSON.stringify({ type: 'workspace_error', message: 'Could not open workspace: ' + e.message }));\n",
    ''],
];

// Guards in this block that are deliberately NOT mutated, each with the
// reason. A named exclusion is a decision; an unnamed one is a harness that
// quietly checks less than it claims.
const NOT_MUTATED = [
  {
    what: "the rollback's `ctx.agents.invalidateAgentCache()`",
    why: 'every cache it clears is bounded by the same two-second time to live, and the tree '
      + 'cache it also clears is cleared again by the arming call on the very next line. So a '
      + 'test of it is a race against a timer: run slow and it passes with the line deleted. A '
      + 'mutation nothing can honestly discharge is noise in an instrument whose whole value is '
      + 'that a red line means something. Left here as a named gap rather than as a green row.',
  },
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
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
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
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
  const targets = [HANDLER];
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
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST. String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red. This file's target holds three
      // separate arming calls, so the refusal is load-bearing here rather
      // than theoretical.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, matches, unparsable: true, red: [] }
        : { label, applied: true, matches, red });
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
  for (const { label, applied, red, ambiguous, matches, unparsable } of results) {
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | ${matches} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
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
    // The match count travels with the result. A guard text that matched once
    // is a guard that was addressed; the harness refuses anything else, so
    // printing it turns "addressed exactly once" from a claim into a reading.
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. Same reason as the other
// mutation harnesses: this runs a suite per guard, so it is a heavy producer
// of fixtures, and write failures on a full disk surface as red tests, which
// is exactly what this instrument reports as an unguarded guard.
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
