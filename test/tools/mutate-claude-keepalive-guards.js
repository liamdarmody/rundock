#!/usr/bin/env node
'use strict';
// Break each rule a Claude Code turn's heartbeat depends on, in turn, and
// report which tests notice (lib/delegation/engine.js, the chat path in
// server.js and Stop in lib/protocol/handlers/process-control.js).
//
// The chat screen finishes a turn it has heard nothing from for 90 seconds, so
// a quiet Claude Code turn is kept alive by a keepalive every 25 seconds. Each
// rule here can be deleted with most conversations still looking fine: a turn
// that streams steadily never needs the heartbeat, and one that goes quiet
// only on its first message shows nothing wrong until a later one does. So
// each is broken on purpose and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-claude-keepalive-guards.js            # report
//   node test/tools/mutate-claude-keepalive-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-sign-in-reason-guards.js, and the named-test rows of
// mutate-stale-session-guards.js), deliberately a separate copy.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const ENGINE_SRC = path.join(ROOT, 'lib', 'delegation', 'engine.js');
// The heartbeat itself, driven with fake processes and mock timers.
const UNIT = 'test/unit/claude-turn-keepalive.test.js';
const ENGINE = { src: ENGINE_SRC, suite: UNIT };
const STOP = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: UNIT };
// The turns only a running server gives: the person's next message to a live
// process, and the two automatic continues.
const E2E = 'test/integration/claude-keepalive.test.js';
const ENGINE_E2E = { src: ENGINE_SRC, suite: E2E };
const SERVER_E2E = { src: path.join(ROOT, 'server.js'), suite: E2E };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. Such a row names the
// test that proves it (`suite#test name`) and only that test runs. A name
// that matches nothing runs nothing, which turns nothing red and is reported
// as a failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const BEAT = '_conversationId: convoId, _processId: entry.processId,';

const MUTATIONS = [
  // ===== IT STARTS =====
  [ENGINE, 'a Claude Code turn has a heartbeat at all',
    'function startClaudeTurnKeepalive(entry, convoId) {\n  const proc = entry.process;',
    'function startClaudeTurnKeepalive(entry, convoId) {\n  return;\n  const proc = entry.process;'],
  // Started only on a process's first message, every later turn of the same
  // process goes quiet unwatched.
  [only(SERVER_E2E, 'the next message to the same live process starts the heartbeat again'),
    'the next message to a live process starts it again',
    '            if (existing.startTurnKeepalive) existing.startTurnKeepalive();\n',
    ''],
  [only(ENGINE_E2E, 'an automatic continue after an out-of-scope return heartbeats on the living orchestrator'),
    'an automatic continue on the living orchestrator starts it again',
    '                  startClaudeTurnKeepalive(orchestratorEntry, convoId);\n',
    ''],
  [only(ENGINE_E2E, 'an automatic continue after a specialist says the work continues heartbeats on the restored parent'),
    'an automatic continue on the restored parent starts it again',
    '                startClaudeTurnKeepalive(orig, convoId);\n',
    ''],
  // A process parked between turns has no turn to keep alive.
  [ENGINE, 'a process with no turn sends nothing',
    '    if (entry.idle) return;\n',
    ''],
  // ===== IT STOPS =====
  [ENGINE, 'the result stops it',
    '          entry.resultSent = true;\n          stopClaudeTurnKeepalive(entry);\n',
    '          entry.resultSent = true;\n'],
  // A process replaced in its entry no longer speaks for it: a late result
  // from it would park its successor's turn and so silence its heartbeat.
  [ENGINE, 'a replaced process\'s output never reaches its entry',
    '    if (entry.process !== keepaliveProc) return;\n',
    ''],
  [ENGINE, 'close stops it',
    "  keepaliveProc.on('close', stopForThisProcess);\n",
    ''],
  // A start that fails emits 'error' and may never close.
  [ENGINE, 'a failed start stops it when it fails',
    "  keepaliveProc.on('error', stopForThisProcess);\n",
    ''],
  [STOP, 'Stop stops it at once',
    '    if (entry.stopTurnKeepalive) entry.stopTurnKeepalive();\n',
    ''],
  // ===== ONE, AND ITS OWN =====
  [ENGINE, 'one process never has two heartbeats',
    '  if (entry._claudeKeepalive) {\n    if (entry._claudeKeepalive.proc === proc) return;\n    stopClaudeTurnKeepalive(entry);\n  }\n',
    ''],
  [ENGINE, 'a keepalive names its own conversation',
    BEAT,
    '_conversationId: `${convoId}-other`, _processId: entry.processId,'],
  [ENGINE, 'a keepalive names its process',
    BEAT,
    '_conversationId: convoId,'],
  [ENGINE, 'a keepalive carries none of the response text',
    BEAT,
    `${BEAT} text: entry.responseText,`],
  // ===== THE OVERRIDE STAYS IN BOUNDS =====
  // Below 50 ms it floods the socket; at a minute or more it lets the
  // watchdog's 90 seconds pass with one beat or none.
  [ENGINE, 'the interval cannot be set below 50 ms',
    '  return n >= 50 && n <= 59999 ? n : 25000;',
    '  return n >= 1 && n <= 59999 ? n : 25000;'],
  [ENGINE, 'the interval cannot be set to a minute or more',
    '  return n >= 50 && n <= 59999 ? n : 25000;',
    '  return n >= 50 && n <= 600000 ? n : 25000;'],
  // ===== THE CLOSE IT LEAVES TO THE CHAT =====
  // A turn that closes with no result is finished by the chat's own close
  // handling, which tells the screen the turn is done and lets the process
  // go. With that handling removed, a quiet turn that is killed must go red.
  [only(SERVER_E2E, 'a process killed mid-quiet stops beating at its close, and the server still says the turn is done and lets the process go'),
    'the existing close handling removed',
    "            proc.on('close', (code) => {\n              if (entry.spawnFailed) return; // error handler already surfaced\n",
    "            proc.on('close', (code) => {\n              return;\n              if (entry.spawnFailed) return; // error handler already surfaced\n"],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];
const exactly = (name) => `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;

async function redTests(suite) {
  let out = '';
  let failed = false;
  const [file, testName] = String(suite).split('#');
  // NODE_TEST_CONTEXT must not reach the run: a nested node --test that
  // inherits it reports its failures in a form this cannot read and still
  // exits 0, so a red run would read as green.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  try {
    out = await runSuite('node', ['--test', '--test-timeout=120000', ...REPORTER,
      ...(testName ? ['--test-name-pattern', exactly(testName)] : []), file], { cwd: ROOT, env });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: refused as a named row rather than thrown, so the report says
    // which mutation was in flight instead of a stack trace that names nothing.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

async function run() {
  const targets = targetsFromRows(MUTATIONS);
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of rowsForShard(MUTATIONS)) {
      const original = originals.get(target);
      const count = original.split(guard).length - 1;
      if (count === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      if (count > 1) {
        results.push({ label, applied: false, ambiguous: count, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, () => without));
      const red = await redTests(target.suite);
      if (red && red.didNotFinish) results.push({ label, applied: true, didNotFinish: red.didNotFinish, output: suiteOutput(), red: [] });
      else results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, output: suiteOutput(), red: [] }
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
  for (const { label, applied, red, ambiguous, unparsable, didNotFinish } of results) {
    if (didNotFinish) {
      failed++;
      const why = didNotFinishWhy(didNotFinish);
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
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
// mutate-routines-guards.js: a full temp root surfaces as tests going red,
// and red tests are exactly what this instrument reports as a guard nobody
// was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  run().then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
        + ' and a mutation that could break more than one place proves nothing about either.');
      process.exit(exitCodeFor(failed, results));
    }
  });
}

module.exports = { MUTATIONS, run };
