#!/usr/bin/env node
'use strict';
// Break each rule that keeps the helpers panel truthful and safe, in turn,
// and report which tests notice.
//
// The panel draws what a lead's helpers wrote (a task, a step, a file name)
// as text only, links a file only while the workspace's tree has it, names a
// helper outside the team from a closed map, counts a capped row in its title
// and never in its rate line, and reads the rate from the most that ran at
// once, never more than six times. The page keeps a helper's card while its
// lead's process carries on, starts processing when a helper's end wakes the
// lead and not on a reload while only helpers work. The Allow card has no
// standing answer, a helper's card names the helper, its replay keeps it, and
// a lead's own tool call never sets a helper's step. Each of those can be lost
// with most tests still green, which is why each is broken on purpose here
// and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-room-panel-guards.js            # report
//   node test/tools/mutate-room-panel-guards.js --markdown # the same, as a table
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

// The page, under JSDOM: fast enough to run whole for every row.
const PANEL_SUITE = 'test/unit/room-panel-view.test.js';
const PANEL = { src: path.join(ROOT, 'public', 'room-panel.js'), suite: PANEL_SUITE };
const RELOAD = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: PANEL_SUITE };
const WORDS = { src: path.join(ROOT, 'public', 'room-words.js'), suite: 'test/unit/room-words.test.js' };
const STATE = { src: path.join(ROOT, 'public', 'conversation-state.js'), suite: 'test/unit/conversation-state.test.js' };
const CARD = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/room-allow-card-view.test.js' };
// The server end to end, against the stub Claude.
const REPLAY = { src: path.join(ROOT, 'server.js'), suite: 'test/integration/helpers-card.test.js' };
const STEP = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: 'test/integration/helpers-stream.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The integration
// suites start a server and agents for every test, so a row that ran all of
// one would cost minutes. Such a row names the test that proves it
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
  // ===== WHAT A HELPER WROTE IS TEXT =====
  [PANEL, 'a row\'s task is drawn through innerHTML, unescaped',
    "    if (row.kind !== 'codex') box.append(el('div', 'room-task', String(row.task || '')));",
    "    if (row.kind !== 'codex') { const task = el('div', 'room-task'); task.innerHTML = String(row.task || ''); box.append(task); }"],

  // ===== A FILE OPENS ONLY WHILE THE TREE HAS IT =====
  [PANEL, 'a finished row\'s file is linked without asking treePathOf',
    "    if (typeof treePathOf !== 'function' || !treePathOf(row.file)) {",
    '    if (!row.file) {'],

  // ===== A HELPER'S LABEL COMES FROM A CLOSED MAP =====
  [WORDS, 'a subagent_type the map doesn\'t hold is drawn as its own label',
    "    return LABELS.get(type) || 'Helper';",
    "    return LABELS.get(type) || String(type || 'Helper');"],

  // ===== THE TITLE COUNTS EVERY ROW, THE RATE LINE NONE THE CAP STOPPED =====
  [PANEL, 'a capped row is left out of the title\'s count',
    "rows.filter((r) => r.kind !== 'teammate').length));",
    "rows.filter((r) => r.kind !== 'teammate' && !r.capped).length));"],
  [PANEL, 'a capped row is counted in the rate line',
    'W.rateLine(lead, rows.filter((r) => !r.capped).map(member), batch.most + 1, others)',
    'W.rateLine(lead, rows.map(member), batch.most + 1, others)'],

  // ===== N IS THE MOST AT ONCE, PLUS ONE, AT MOST SIX =====
  [PANEL, 'N is taken from the rows running now in place of the most at once',
    'W.rateLine(lead, rows.filter((r) => !r.capped).map(member), batch.most + 1, others)',
    "W.rateLine(lead, rows.filter((r) => !r.capped).map(member), rows.filter((r) => r.state === 'running').length + 1, others)"],
  [WORDS, 'N is not capped at six',
    'TIMES[Math.min(Math.max(n, 2), 6)]',
    'TIMES[Math.max(n, 2)]'],

  // ===== THE PAGE KEEPS A HELPER'S CARD, AND KNOWS WHO IS REPLYING =====
  [STATE, 'a process_started for the process already running removes every card',
    "    const effects = message._processId !== state.activeProcessId ? [{ type: 'remove-permission-cards' }] : [];",
    "    const effects = [{ type: 'remove-permission-cards' }];"],
  [RELOAD, 'a reload starts processing while only helpers work',
    '    if (proc.idle || proc.replying === false) continue;',
    '    if (proc.idle) continue;'],
  [STATE, 'a helpers_wake starts no processing',
    "      case 'helpers_wake': return reduceHelpersWake(state, message);\n",
    ''],

  // ===== THE ALLOW CARD AND "ASKED BY" =====
  [CARD, 'the Allow card offers Always allow',
    "  if (allowCard) card.querySelectorAll('[data-perm-action=\"always\"]').forEach((b) => b.remove());\n",
    ''],
  [CARD, '"Asked by" is drawn from _agent on a card a helper raised',
    "  if (d._helper && owner.kind === 'conversation' && typeof RundockRoomPanel !== 'undefined') {",
    '  if (false) {'],
  [only(REPLAY, 'a pending helper\'s card replayed on reconnect keeps _helper'),
    'the replay of a pending card drops _helper',
    '      ...(pending.helper ? { _helper: pending.helper } : {})\n',
    ''],

  // ===== A LEAD'S OWN TOOL CALL IS NEVER A HELPER'S STEP =====
  [only(STEP, 'with helpers on, a lead\'s own tool call never sets a row\'s step or file'),
    'a lead\'s own tool_use sets a running row\'s step',
    "  if (!module.exports.HELPERS_ENABLED || typeof parent !== 'string' || !parent || parsed.type !== 'assistant') return;\n"
      + '  const run = runs.get(convoId);\n  const row = run && run.rows.get(parent);\n',
    "  if (!module.exports.HELPERS_ENABLED || parsed.type !== 'assistant') return;\n"
      + "  const run = runs.get(convoId);\n  const row = run && (run.rows.get(parent) || [...run.rows.values()].find((r) => r.state === 'running'));\n"],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-panel-harness-'));
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
