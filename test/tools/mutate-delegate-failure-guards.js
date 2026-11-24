#!/usr/bin/env node
'use strict';
// Break each rule that keeps a stopped delegate from passing for a finished
// one, in turn, and report which tests notice (lib/delegation/engine.js, the
// follow-up path in server.js, lib/delegation/stopped-line.js, the reducers
// in public/conversation-state.js, the notice in public/views/chat.js, the
// history handler and the catch-up in lib/store/transcripts.js).
//
// Each rule can go with most conversations still looking fine: a delegate
// that finishes never needs the stopped line, and one that stops on its first
// turn shows nothing wrong until a follow-up or a restart does. So each is
// broken on purpose and a test must go red, one row each.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-delegate-failure-guards.js            # report
//   node test/tools/mutate-delegate-failure-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. Same shape
// as its siblings (mutate-claude-keepalive-guards.js), deliberately a separate
// copy.

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
// The delegate's close, end to end against a running server.
const E2E = 'test/integration/delegate-stopped.test.js';
const ENGINE_E2E = { src: ENGINE_SRC, suite: E2E };
const SERVER_E2E = { src: path.join(ROOT, 'server.js'), suite: E2E };
// A Codex delegate's held card, end to end.
const CODEX_E2E = { src: ENGINE_SRC, suite: 'test/integration/codex-delegate-edges.test.js' };
// The words, with no server.
const WORDS = { src: path.join(ROOT, 'lib', 'delegation', 'stopped-line.js'), suite: 'test/unit/stopped-line.test.js' };
// The page: the reducers, and the notice built from the line.
const REDUCER_SRC = path.join(ROOT, 'public', 'conversation-state.js');
const SWITCH = { src: REDUCER_SRC, suite: 'test/unit/conversation-state.test.js' };
const LINE_VIEW = { src: REDUCER_SRC, suite: 'test/unit/delegate-stopped-view.test.js' };
const NOTICE = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/delegate-stopped-view.test.js' };
// The stored line: handed back in the history, left out of the catch-up.
const STORE = 'test/unit/delegate-stopped-store.test.js';
const HISTORY = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'history.js'), suite: STORE };
const CATCH_UP = { src: path.join(ROOT, 'lib', 'store', 'transcripts.js'), suite: STORE };

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

const HELD_CARD_SENT = '    if (heldCard && !failed) heldCard.send();\n';
const DRAWS = '!message.failed && (isReturn || !message.silent)';

const MUTATIONS = [
  // ===== THE DECISION =====
  // Decided on the marker alone, a delegate whose last turn succeeded with no
  // marker reads as stopped.
  [only(ENGINE_E2E, 'exit code 0 after a successful result and no marker is no stop, and Cos is told Wren completed their work'),
    'the failure decision ignores the last turn\'s outcome',
    "    const failed = !returnMarkerSeen && delegateEntry.lastTurnOutcome !== 'success'\n",
    '    const failed = !returnMarkerSeen\n'],
  // Left as the first turn's, a follow-up that crashes reads as finished.
  [only(SERVER_E2E, 'a follow-up that crashes after a first turn that succeeded is exit code 1'),
    'the outcome is not cleared at the follow-up',
    '            existing.lastTurnOutcome = null;\n',
    ''],
  [only(ENGINE_E2E, 'a fresh start after an expired session that then crashes is exit code 1'),
    'the outcome is not cleared on a fresh start',
    '  entry.lastTurnOutcome = null;\n  if (freshPrompt)',
    '  if (freshPrompt)'],
  [only(ENGINE_E2E, 'a delegate killed mid-turn is stopped by the system, and the switch names the signal'),
    'the signal is dropped at the close wiring',
    "  if (delegateProc) delegateProc.on('close', handleDelegateClose);",
    "  if (delegateProc) delegateProc.on('close', (code) => handleDelegateClose(code));"],
  // A fresh start after an expired session wires its own close.
  [only(ENGINE_E2E, 'a fresh start after an expired session killed mid-turn is stopped by the system, and the switch names the signal'),
    'the signal is dropped at the fresh-start close wiring',
    "  proc.on('close', onClose);",
    "  proc.on('close', (code) => onClose(code));"],
  // ===== THE WORDS =====
  [WORDS, 'an error result ranks below a signal or a code',
    "  if (lastTurnOutcome === 'error') return 'Claude Code reported an error';\n  if (signal) return 'stopped by the system';\n"
      + '  if (Number.isInteger(code)) return `exit code ${code}`;\n',
    "  if (signal) return 'stopped by the system';\n  if (Number.isInteger(code)) return `exit code ${code}`;\n"
      + "  if (lastTurnOutcome === 'error') return 'Claude Code reported an error';\n"],
  [WORDS, 'the whitespace collapse in names is removed',
    "  const one = name.replace(/\\s+/g, ' ').trim();",
    '  const one = name.trim();'],
  // ===== THE PAGE =====
  // A delegate can print a line that looks like the server's; only the
  // server's has no process id.
  [LINE_VIEW, 'a stopped line with a process id draws a notice',
    "    if ('_processId' in message) return none(state);\n",
    ''],
  [SWITCH, 'a switch that carries a failure draws a divider',
    DRAWS,
    '(isReturn || !message.silent)'],
  [SWITCH, 'a returning silent switch draws nothing',
    DRAWS,
    '!message.failed && !message.silent'],
  [NOTICE, 'the notice writes its words as markup',
    'el.className = cls; el.textContent = text;',
    'el.className = cls; el.innerHTML = text;'],
  // ===== THE STORED LINE =====
  [HISTORY, 'the history drops the delegation branch',
    "          if (t.type === 'delegation') {\n"
      + "            merged.push({ role: 'system', content: tText, agentId: null, type: 'delegation', timestamp: t.timestamp || null });\n"
      + '            continue;\n          }\n',
    ''],
  [CATCH_UP, 'the catch-up tells an agent the stopped line',
    " && t.type !== 'delegation'\n",
    '\n'],
  // ===== THE PARENT =====
  [only(ENGINE_E2E, 'Cos, started again, is told Wren stopped, is given what Wren wrote, and stays quiet'),
    'the respawned parent gets the normal exit\'s prompt after a failure',
    '        const exitPrompt = failed\n',
    '        const exitPrompt = false\n'],
  [only(ENGINE_E2E, 'Cos, still live, is not woken to carry on when Wren stopped after a follow-up'),
    'the live parent is woken after a failure',
    '      const parentShouldWake = !failed && !delegateEntry.isPlatformDelegate\n',
    '      const parentShouldWake = !delegateEntry.isPlatformDelegate\n'],
  // ===== THE HELD CODEX CARD =====
  [only(CODEX_E2E, 'a terminal delegate error is folded into the one line and the parent still comes back'),
    'a held Codex card is sent on a failure close',
    HELD_CARD_SENT,
    '    if (heldCard) heldCard.send();\n'],
  [only(CODEX_E2E, 'a notice held for Ida goes out as before when her turn finishes after all'),
    'a held Codex card is dropped on a close that draws no line',
    HELD_CARD_SENT,
    ''],
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
