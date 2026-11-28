#!/usr/bin/env node
'use strict';
// Break each rule that keeps a Codex lead's helpers to their own threads and
// to the cap, in turn, and report which tests notice.
//
// A Codex lead's helpers are threads of their own in the app-server. The
// runtime client records one only for a conversation turn started while
// helpers are on, never an upkeep thread or a helper's own helper, and keeps
// a helper's turn, text and approvals off its lead's turn: an approval is
// raised on the lead's card only while the lead's turn runs and the helper is
// not stopped. A sixth is interrupted, its lead is told why in one line, and
// a lead's first helpers in a conversation are marked once, kept on the
// conversation's record by the server alone, and a thread withdrawn as upkeep
// gives its mark back. A helper's end is kept whenever it arrives, a helper
// recorded once is known until the app-server goes, and a running Codex
// helper holds no agent's turn and ends only on its own, never with a Claude
// Code lead's process, nor ends anything of one's. Each of those can be lost
// with most tests still green, which is why each is broken on purpose here
// and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-room-helpers-codex-guards.js            # report
//   node test/tools/mutate-room-helpers-codex-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The runtime client and the rows, driven in-process against fed protocol
// lines: fast enough to run whole for every row.
const UNIT_SUITE = 'test/unit/codex-appserver-helpers.test.js';
const CLIENT = { src: path.join(ROOT, 'codex-appserver.js'), suite: UNIT_SUITE };
const ROWS = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: UNIT_SUITE };
// The server end to end, against the stub app-server.
const CODEX_SUITE = 'test/integration/codex-helpers.test.js';
const GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: CODEX_SUITE };
const RECORD = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'), suite: CODEX_SUITE };
const CARD = { src: path.join(ROOT, 'server.js'), suite: CODEX_SUITE };
// The server end to end with helpers off.
const GLUE_OFF = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/integration/helpers-off.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The integration suite
// starts a server and agents for every test, and a broken guard can leave
// several of them waiting out their timeouts, so a row that ran all of it
// would cost minutes. Such a row names the test that proves it
// (`suite#test name`), one that fails on an assertion rather than by waiting
// out a timeout, and only that test runs. A name that matches nothing runs
// nothing, which turns nothing red and is reported as a failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== OFF MEANS NO HELPER IS RECORDED =====
  [only(GLUE_OFF, 'with helpers off, a helper\'s command approval is declined at once with no card, and Fern\'s turn carries on'),
    'a conversation turn records its helpers whether helpers are on or off',
    '  if (!helpers.HELPERS_ENABLED) return {};\n',
    ''],

  // ===== A HELPER'S APPROVAL IS RAISED ONLY WHILE ITS LEAD'S TURN RUNS =====
  [CLIENT, 'a helper\'s approval with no lead turn running is not declined at once',
    '    if (!state) {\n      // No turn to route this to',
    '    if (!state && !this._helperThreads.has(params.threadId)) {\n      // No turn to route this to'],

  // ===== AN UPKEEP THREAD IS NEVER A HELPER =====
  [CLIENT, 'an upkeep thread is recorded and counted as a helper',
    "    info.upkeep = typeof sub === 'string';",
    '    info.upkeep = false;'],

  // ===== A HELPER'S TURN STAYS OFF ITS LEAD'S =====
  [CLIENT, 'a helper\'s thread is put in the lead\'s turn slots',
    '    this._helperThreads.set(rec.threadId, rec);\n',
    '    this._helperThreads.set(rec.threadId, rec);\n    this._activeTurns.set(rec.threadId, state);\n'],
  [CLIENT, 'a helper\'s agentMessage joins the lead\'s reply',
    '      rec.step = helperStep(params.item);\n',
    '      const lead = this._activeTurns.get(rec.leadThreadId);\n'
      + "      if (lead && method === 'item/completed' && params.item.type === 'agentMessage') this._emitTurnEvent(lead, { type: 'text', text: params.item.text || '' });\n"
      + '      rec.step = helperStep(params.item);\n'],

  // ===== AT MOST FIVE AT ONCE =====
  [ROWS, 'a sixth helper is shown stopped and its lead told, but never interrupted',
    '  new Promise((resolve) => resolve(ctl.interrupt())).then(() => {',
    '  Promise.resolve().then(() => {'],
  [ROWS, 'the line a lead reads about a stopped helper is changed',
    'const line = `Rundock stopped the helper ${rec.name}: at most five helpers run at once.',
    'const line = `Rundock stopped ${rec.name}: at most five helpers run at once.'],
  [ROWS, 'the cap lets a sixth Codex helper run',
    'const HELPER_CAP = 5;',
    'const HELPER_CAP = 6;'],
  [CLIENT, 'a helper stopped by the cap can still raise a card',
    "if (!rec || rec.state !== 'running' || rec.capped) return null;",
    "if (!rec || rec.state !== 'running') return null;"],

  // ===== A HELPER'S REFUSAL IS ITS OWN =====
  [only(GLUE, 'a helper\'s refusal line that cannot be steered is dropped, never carried into Fern\'s next turn'),
    'a helper\'s refusal line that cannot be steered is queued for its lead\'s next turn',
    'if (convoId && !ev.helper) queueCodexNotice(convoId, line);',
    'if (convoId) queueCodexNotice(convoId, line);'],

  // ===== A LEAD'S FIRST HELPERS ARE MARKED ONCE, KEPT BY THE SERVER ALONE =====
  [ROWS, 'a lead whose first helpers were marked is never kept as noticed',
    '      try { noticeLead(convoId, lead); } catch',
    '      try { } catch'],
  [only(RECORD, 'a window that saves helpersNoticed itself changes nothing: Fern\'s first batch is still marked, and the list never sends it'),
    'the leads noticed are taken from what a window saves',
    '  if (stored && stored.helpersNoticed !== undefined) entry.helpersNoticed = stored.helpersNoticed;',
    '  if (msg.conversation.helpersNoticed !== undefined) entry.helpersNoticed = msg.conversation.helpersNoticed;'],

  // ===== A HELPER'S CARD NAMES THE HELPER =====
  [only(CARD, 'a helper\'s approval raises a card on Fern\'s turn naming the helper, and Allow answers accept on the helper\'s request'),
    'a helper\'s card no longer names the helper',
    '    ...(helper ? { _helper: { agentId: helper.threadId, agentType: helper.name } } : {}),\n',
    ''],

  // ===== A HELPER'S END IS KEPT, WHENEVER IT ARRIVES =====
  [CLIENT, 'a helper\'s end that arrives before its lead records it is dropped',
    '        if (info.turnId == null || info.turnId === turnId) info.ended = endState(params.turn.status);',
    '        if (info.turnId == null || info.turnId === turnId) info.ended = null;'],

  // ===== A HELPER RECORDED ONCE IS KNOWN UNTIL THE APP-SERVER GOES =====
  [CLIENT, 'an ended helper\'s record is dropped once 256 have started, so more work for it runs unseen',
    '    this._helperThreads.set(rec.threadId, rec);\n    this._tellHelper(rec, \'start\');',
    '    for (const [id, old] of this._helperThreads) {\n      if (this._helperThreads.size < 256) break;\n      if (old.state !== \'running\') this._helperThreads.delete(id);\n    }\n'
      + '    this._helperThreads.set(rec.threadId, rec);\n    this._tellHelper(rec, \'start\');'],

  // ===== A CODEX HELPER HOLDS NOTHING =====
  [ROWS, 'a running Codex helper holds an agent\'s done, idle, return and kill',
    '  return !!module.exports.HELPERS_ENABLED && runningCount(convoId) - codexRunning(convoId) > 0;',
    '  return !!module.exports.HELPERS_ENABLED && runningCount(convoId) > 0;'],

  // ===== A CODEX HELPER ENDS ONLY ON ITS OWN, AND ENDS NOTHING OF A CLAUDE CODE LEAD'S =====
  [ROWS, 'a Claude Code lead\'s helper starting ends the conversation\'s running Codex helpers',
    '    leadOf(run, entry.agentId, entry.process);\n',
    '    leadOf(run, entry.agentId, entry.process);\n'
      + "    for (const row of (codexRows.get(convoId) || new Map()).values()) if (row.state === 'running') row.state = 'killed';\n"],
  [ROWS, 'a Claude Code lead\'s process closing ends the conversation\'s running Codex helpers',
    '  endRows(run);\n  changed(convoId);\n  runs.delete(convoId);\n',
    '  endRows(run);\n'
      + "  for (const row of (codexRows.get(convoId) || new Map()).values()) if (row.state === 'running') row.state = 'killed';\n"
      + '  changed(convoId);\n  runs.delete(convoId);\n'],
  [ROWS, 'a Claude Code lead\'s request ending drops the conversation\'s Codex helpers',
    '  runs.delete(convoId);\n  for (const act of run.after) {',
    '  runs.delete(convoId);\n  codexRows.delete(convoId);\n  for (const act of run.after) {'],
  [ROWS, 'a Codex helper starting ends a Claude Code lead\'s live helpers and refuses its held calls',
    '    if (rec.firstBatch === undefined) rec.firstBatch = row ? row.firstBatch : firstBatchOf(convoId, lead, rec);',
    '    if (runs.get(convoId)) leadOf(runs.get(convoId), lead, null);\n'
      + '    if (rec.firstBatch === undefined) rec.firstBatch = row ? row.firstBatch : firstBatchOf(convoId, lead, rec);'],
  [ROWS, 'a Codex helper\'s end leaves a Claude Code lead\'s call held at the cap waiting with a slot free',
    '    if (run) startHeld(convoId, run);\n',
    ''],

  // ===== A WITHDRAWN THREAD GIVES BACK ITS FIRST-BATCH MARK =====
  [ROWS, 'a thread withdrawn as upkeep or a helper\'s own helper keeps the lead\'s first batch used up',
    '    if (rec.firstBatch) unmarkFirstBatch(convoId, lead, rec);\n',
    ''],
];

const REPORTER = ['--test-reporter', 'spec'];

// The exact name, as a pattern node --test can match and nothing else can.
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
    // Bounded twice over: each test by node's own timeout, and the whole
    // suite by the runner's limit, so a broken guard that leaves a run
    // waiting costs minutes and reports, rather than holding the harness for
    // hours.
    out = await runSuite('node', ['--test', '--test-timeout=120000', ...REPORTER, ...(testName ? ['--test-name-pattern', exactly(testName)] : []), file],
      { cwd: ROOT, env });
  } catch (e) {
    if (e.didNotFinish) return { didNotFinish: e.didNotFinish };
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

// THE HARNESS'S OWN RUN IS CHECKED BEFORE ANY ROW IS READ. Every row is read
// through the one invocation above, so a fault in it, an option this node
// refuses or output that no longer parses, would misreport every row at once.
// Before anything is mutated, that same invocation is made on a fixture of two
// tests, one that passes and one that fails. It must read the passing one as
// green and the failing one as red, by name, or the run is refused with no
// verdict. Returns what it read wrong, or null.
const FIXTURE_GREEN = 'passes with nothing broken';
const FIXTURE_RED = 'fails when broken';
async function invocationProblem(runTests = redTests) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-helpers-codex-harness-'));
  const file = path.join(dir, 'invocation.test.js');
  try {
    fs.writeFileSync(file, "'use strict';\nconst { test } = require('node:test');\n"
      + `test(${JSON.stringify(FIXTURE_GREEN)}, () => {});\n`
      + `test(${JSON.stringify(FIXTURE_RED)}, () => { throw new Error('broken'); });\n`);
    const green = await runTests(`${file}#${FIXTURE_GREEN}`);
    if (!Array.isArray(green) || green.length !== 0) {
      return `a run of a passing test read as ${JSON.stringify(green)}, not green`;
    }
    const red = await runTests(`${file}#${FIXTURE_RED}`);
    if (!Array.isArray(red) || red.length !== 1 || red[0] !== FIXTURE_RED) {
      return `a run of a failing test read as ${JSON.stringify(red)}, not that test red`;
    }
    return null;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
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
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(NO_VERDICT);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  invocationProblem().then((problem) => {
    if (problem) {
      console.error(`Refusing to start a mutation run: the run every row is read through misreads a result: ${problem}.`);
      process.exit(NO_VERDICT);
    }
    return run();
  }).then((results) => {
    const failed = report(results, process.argv.includes('--markdown'));
    if (failed) {
      console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
        + ' and a mutation that could break more than one place proves nothing about either.');
      process.exit(exitCodeFor(failed, results));
    }
  });
}

module.exports = { MUTATIONS, run, redTests, invocationProblem };
