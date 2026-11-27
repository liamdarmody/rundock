#!/usr/bin/env node
'use strict';
// Break each rule the line under a reply depends on, in turn, and report
// which tests notice.
//
// Each reply says how long the agent worked on it, from the time its runtime
// reported, and behind Details the steps and the tokens. Codex's counts are
// summed per turn, each update once, with a count it left out left out; its
// time rides the done event onto the result, for a chat and for a delegate;
// a stopped turn carries the time the server measured. The page draws the
// time from that figure alone, rounds down, draws only whole counts, keeps
// none of it with the stored message, and reads it at a contrast that holds
// in both themes. Each of those is a small rule that can be deleted with the
// line still looking alive in most tests, which is why each is broken on
// purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-turn-usage-guards.js            # report
//   node test/tools/mutate-turn-usage-guards.js --markdown # the same, as a table
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

// The Codex protocol client: the counts it keeps, their sum and the time on
// its done event.
const CLIENT = { src: path.join(ROOT, 'codex-appserver.js'), suite: 'test/unit/codex-turn-usage.test.js' };
// Where a Codex turn's result is sent, for a chat and for a delegate.
const GLUE = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: 'test/integration/turn-usage.test.js' };
// The cancelled message a stopped turn is drawn from.
const CANCEL = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'process-control.js'), suite: 'test/unit/turn-used-cancel.test.js' };
// The line itself.
const LINE = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: 'test/unit/turn-used-view.test.js' };
// What the window keeps of a reply.
const STORE = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/turn-used-view.test.js' };
// The colors it reads.
const STYLE = { src: path.join(ROOT, 'public', 'styles', 'views', 'chat.css'), suite: 'test/unit/turn-used-contrast.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The integration
// suite starts a server and the stub runtimes, and a broken guard can leave
// its tests waiting out their timeouts, so a row that ran all of it would
// cost minutes. Such a row names the test that proves it (`suite#test name`),
// one that fails on an assertion rather than by waiting out a timeout, and
// only that test runs. A name that matches nothing runs nothing, which turns
// nothing red and is reported as a failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== A CODEX TURN'S COUNTS, EACH UPDATE ONCE, NONE INVENTED =====
  [CLIENT, 'a count Codex left out stays out, never zero',
    '  for (const key of USAGE_KEYS) if (isTokenCount(u[key])) out[key] = u[key];\n',
    '  for (const key of USAGE_KEYS) out[key] = isTokenCount(u[key]) ? u[key] : 0;\n'],
  [CLIENT, 'each update is added to the turn\'s sum, never put in its place',
    'sum[key] = (sum[key] || 0) + n;',
    'sum[key] = n;'],
  [CLIENT, 'an update repeated unchanged is not added again',
    '          if (isTokenCount(total) && total === state.lastCountedTotal) return;\n',
    ''],
  [CLIENT, 'the done event carries the turn\'s time',
    "{ type: 'done', status, usage: state.usage, durationMs, error:",
    "{ type: 'done', status, usage: state.usage, error:"],

  // ===== THE TIME REACHES THE PAGE ON THE RESULT =====
  [only(GLUE, 'the chat result carries the time Codex reported and names its runtime, and the next prompt carries neither figure'),
    'a Codex chat result carries the turn\'s time',
    '    duration_ms: entry.subscription ? entry.subscription.durationMs : undefined, _runtime: \'codex\',\n',
    '    _runtime: \'codex\',\n'],
  [only(GLUE, 'a delegate\'s result carries the time Codex reported and names its runtime'),
    'a Codex delegate\'s result carries the turn\'s time',
    '          duration_ms: ev.durationMs, _runtime: \'codex\',\n',
    '          _runtime: \'codex\',\n'],
  [CANCEL, 'a stopped turn carries the time the server measured',
    '      ...(Number.isFinite(entry.turnStartTime) ? { duration_ms: Date.now() - entry.turnStartTime } : {})\n',
    ''],

  // ===== THE PAGE DRAWS WHAT IT WAS GIVEN, AND KEEPS NONE OF IT =====
  [LINE, 'the time is rounded down to whole seconds',
    '  const s = Math.floor(ms / 1000);',
    '  const s = Math.round(ms / 1000);'],
  [LINE, 'the time comes from the runtime, never the page\'s clock',
    "  const worked = isTurnDuration(durationMs) ? turnWorkedLabel(durationMs) : '';",
    "  const worked = turnStartTime ? turnWorkedLabel(Date.now() - turnStartTime) : '';"],
  [LINE, 'a count is drawn only when it is a whole number',
    '  return Number.isSafeInteger(n) && n >= 0;',
    "  return typeof n === 'number';"],
  [STORE, 'the stored reply is its words alone, never the line',
    'content: ef.text, agentId: ef.agentId',
    "content: ef.text + ' Worked 4 min 05 s', agentId: ef.agentId"],

  // ===== THE LINE READS AT A CONTRAST THAT HOLDS IN BOTH THEMES =====
  [STYLE, 'the line takes the stronger secondary text color',
    '.turn-used-line { color: var(--text-2-strong);',
    '.turn-used-line { color: var(--text-2);'],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-usage-harness-'));
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
      fs.writeFileSync(target.src, original.replace(guard, without));
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
