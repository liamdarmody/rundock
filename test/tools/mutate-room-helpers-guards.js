#!/usr/bin/env node
'use strict';
// Break each rule that keeps a lead's helpers to the team the person said yes
// to, in turn, and report which tests notice.
//
// A lead's Agent call reaches Rundock through the permission hook, and only
// while helpers are on. The hook refuses a call it could not check rather than
// letting it start, and gives the lead Rundock's own words for a refusal. The
// server matches each request to the lead's message by its call id, and
// refuses a call that names the lead itself. Each of those can be lost with
// most tests still green, which is why each is broken on purpose here and a
// test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-room-helpers-guards.js            # report
//   node test/tools/mutate-room-helpers-guards.js --markdown # the same, as a table
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

// The hook, run as the runtime runs it, against a server that answers or not.
const HOOK_SUITE = 'test/unit/permission-hook-agent.test.js';
const HOOK = { src: path.join(ROOT, 'scripts', 'permission-hook.js'), suite: HOOK_SUITE };
// The workspace settings, written with helpers on and off.
const SCAFFOLD = { src: path.join(ROOT, 'lib', 'workspace', 'scaffold.js'), suite: HOOK_SUITE };
// The rule each helper call is checked against.
const RULE = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: 'test/unit/helpers-rule.test.js' };
// The server end to end: a hook request matched to the lead's message.
const MATCH = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: 'test/integration/helpers-card.test.js' };
// The count and the cap, read from task lines and hook answers.
const COUNT = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: 'test/unit/helpers-count.test.js' };
// The lead's stream, its result and its holds, end to end.
const STREAM_SUITE = 'test/integration/helpers-stream.test.js';
const STREAM = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: STREAM_SUITE };
const SERVER = { src: path.join(ROOT, 'server.js'), suite: STREAM_SUITE };
// The env every spawn is given.
const SPAWN_ENV = { src: path.join(ROOT, 'lib', 'runtime', 'claude.js'), suite: STREAM_SUITE };
// The count and its hook answers, end to end.
const STREAM_COUNT = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: STREAM_SUITE };
// The server loaded with helpers off, then turned on.
const OFF = { src: path.join(ROOT, 'lib', 'delegation', 'helpers.js'), suite: 'test/integration/helpers-off.test.js' };
// The lead's heartbeat, driven over a fake process.
const HEARTBEAT = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: 'test/unit/helpers-count.test.js' };

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
  // ===== A HELPER RUNDOCK COULD NOT CHECK NEVER STARTS =====
  [HOOK, 'an Agent call Rundock could not be asked about is no longer refused',
    'credentialAccess || agentCall;',
    'credentialAccess;'],

  // ===== A REQUEST IS ANSWERED ONLY BY THE MESSAGE ITS CALL CAME IN =====
  [only(MATCH, 'a request whose id is in no message of the lead is refused as unmatched once the wait is over'),
    'a request is answered by the lead\'s latest message whatever its call id',
    'latest && latest.lead === askedBy && latest.ids.includes(id)',
    'latest'],

  // ===== A LEAD IS NEVER ITS OWN HELPER =====
  [RULE, 'a call naming the lead itself is no longer refused',
    "  if (wanted && [lead.name, lead.id, lead.displayName].some((n) => n && String(n).toLowerCase() === wanted)) {\n"
      + '    const n = nameOf(lead);\n'
      + "    return refused(`${n} can't be ${n}'s own helper. Do this part yourself.`);\n"
      + '  }\n',
    ''],

  // ===== OFF MEANS NO AGENT CALL REACHES THE HOOK =====
  [SCAFFOLD, 'the settings send Agent calls to the hook whether helpers are on or off',
    "if (require('../delegation/helpers.js').HELPERS_ENABLED) PRE_MATCHERS.push('Agent');",
    "if (true) PRE_MATCHERS.push('Agent');"],

  // ===== THE LEAD IS GIVEN RUNDOCK'S OWN WORDS FOR A REFUSAL =====
  [HOOK, 'the hook gives a refused Agent call the general refusal words instead of Rundock\'s',
    "agentCall && typeof result.notice === 'string' ? result.notice\n          : ",
    ''],

  // ===== A HELPER'S OWN LINES STAY OUT OF THE LEAD'S TURN =====
  [only(STREAM, 'with helpers on, a line from a helper never joins the lead\'s reply or its steps'),
    'a line with a parent_tool_use_id is read as the lead\'s',
    '        if (fromHelper(parsed)) continue;\n',
    ''],
  [only(STREAM, 'with helpers on, a line and a result whose parent_tool_use_id is empty are the lead\'s'),
    'a line whose parent_tool_use_id is empty is read as a helper\'s',
    " && parsed.parent_tool_use_id !== '';",
    ';'],

  // ===== NOTHING A REQUEST OR THE PAGE SENDS CHANGES THE COUNT =====
  [only(STREAM_COUNT, 'with helpers on, nothing in a hook request or a page message changes the count or the rows the page is sent'),
    'a request for a call already answered is answered again, and counted again',
    '  state.answered.add(id);\n',
    ''],

  // ===== EVERY READER READS THE SWITCH WHEN IT IS USED =====
  [only(OFF, 'the switch is read when it is used by the stream, the holds and the spawns: turned on after boot, each acts'),
    'a reader of the switch copies it to a local as the module loads',
    'function conversationDisallowedTools(list) {\n  if (!module.exports.HELPERS_ENABLED) return list;',
    'const helpersAtLoad = module.exports.HELPERS_ENABLED;\nfunction conversationDisallowedTools(list) {\n  if (!helpersAtLoad) return list;'],

  // ===== EVERY END LOWERS THE COUNT =====
  [COUNT, 'a helper reported killed stays running in the count',
    "killed: 'killed', failed: 'failed'",
    "failed: 'failed'"],

  // ===== THE REQUEST STAYS OPEN WHILE HELPERS RUN =====
  [only(STREAM, 'with helpers on, the lead\'s result while a helper runs sends no done and leaves it busy, and the first result after the helper ends sends done'),
    'the lead\'s result sends done while its helpers run',
    "if (!helping) safeSend(JSON.stringify({ type: 'system', subtype: 'done'",
    "safeSend(JSON.stringify({ type: 'system', subtype: 'done'"],
  [HEARTBEAT, 'a result held for the lead\'s helpers stops its heartbeat',
    '          if (!helping) stopClaudeTurnKeepalive(entry);\n',
    '          stopClaudeTurnKeepalive(entry);\n'],
  [only(SERVER, 'with helpers on, a lead the person started keeps its handoff marker\'s kill waiting while its helpers run'),
    'a handoff marker\'s kill is scheduled while the lead\'s helpers run',
    '  if (helpers.holdWhileHelping(convoId, () => { if (e.pendingKill && !e.exited) scheduleScopeReturnKill(e, convoId); })) return;\n',
    ''],
  [only(SERVER, 'with helpers on, the reaper keeps a lead whose helpers run, and reaps it once the request ends'),
    'the reaper reaps a lead whose helpers run',
    '    if (helpers.helping(convoId)) continue;\n',
    ''],
  [only(SERVER, 'with helpers on, three handoffs deep, nothing in the chain returns while the deepest lead\'s helpers run, and the hand-backs then return one level at a time'),
    'a kill is scheduled for the deepest lead of a three-deep chain while its helpers run',
    '  if (helpers.holdWhileHelping(convoId, () => { if (e.pendingKill && !e.exited) scheduleScopeReturnKill(e, convoId); })) return;\n',
    ''],
  [only(SERVER, 'the idle probe server.js registers reports the conversation busy while the lead\'s helpers run, and as it always has once they end'),
    'the idle probe reads no process, so a lead whose helpers run reads as idle',
    'auth.setIdleProbe(() => chatProcesses.size === 0 && ',
    'auth.setIdleProbe(() => '],

  // ===== AT MOST FIVE AT ONCE =====
  [COUNT, 'the cap lets a sixth helper start',
    'const HELPER_CAP = 5;',
    'const HELPER_CAP = 6;'],
  [COUNT, 'a held call waits for a slot for a different time by default',
    'HELPER_HOLD_MS: 100000,',
    'HELPER_HOLD_MS: 60000,'],

  // ===== A HELPER CAN'T START HELPERS OF ITS OWN =====
  [only(SPAWN_ENV, 'with helpers on, every conversation spawn carries the depth limit and refuses SendMessage'),
    'a conversation spawn is given no subagent spawn depth',
    "  if (convoId && require('../delegation/helpers.js').HELPERS_ENABLED) env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '1';\n",
    ''],
  [only(STREAM_COUNT, 'with helpers on, a running helper\'s Agent call, as Claude Code sends a subagent\'s, is refused through the hook and starts nothing'),
    'a running helper\'s own Agent call is no longer refused for coming from a helper',
    "  if (typeof data.agent_id === 'string') return { allow: false, notice: NOTICES.fromHelper };\n",
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'room-helpers-harness-'));
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
