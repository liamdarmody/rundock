#!/usr/bin/env node
'use strict';
// Break each rule that tells the person, and the agent, that an agent was
// handed a shortened copy of the conversation, in turn, and report which tests
// notice.
//
// When the cap cuts the catch-up an arriving agent is handed, two things are
// said. The person sees one plain notice in the conversation, naming the agent
// and nothing else, sent once at the fresh start: on the Claude Code path, on
// a fresh Codex thread, and when a refused resume starts the agent again
// without its session. The agent finds one line under its catch-up heading.
// Each of those is a small rule that can be deleted with the conversation
// still looking healthy in most tests, which is why each is broken on purpose
// here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-shortened-copy-notice-guards.js            # report
//   node test/tools/mutate-shortened-copy-notice-guards.js --markdown # the same, as a table
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

// The suite that drives a server: every place the notice is sent, and every
// place it must not be.
const DRIVEN = 'test/integration/shortened-copy-notice.test.js';
// The words of the notice, which catch-ups count as cut, and the agent's line.
const CATCH_UP = { src: path.join(ROOT, 'lib', 'delegation', 'catch-up.js'), suite: 'test/unit/shortened-copy-notice.test.js' };
// Where the engine decides who arrived cut, and sends the notice.
const ENGINE = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: DRIVEN };
// A Codex delegate's fresh thread, which sends its own notice.
const CODEX = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: DRIVEN };

const MUTATIONS = [
  // ===== WHAT THE PERSON IS TOLD =====
  [CATCH_UP, 'the notice names the agent by its display name',
    "  const who = name || 'The agent';\n  const again = name || 'the agent';\n",
    "  const who = 'The agent';\n  const again = 'the agent';\n"],
  [ENGINE, 'the notice carries nothing from the conversation',
    '  return isCutCatchUp(missed) ? shortenedCopyNotice(spokenName(agentId)) : null;',
    '  return isCutCatchUp(missed) ? `${shortenedCopyNotice(spokenName(agentId))}\\n${missed.text}` : null;'],

  // ===== WHICH CATCH-UPS COUNT AS CUT =====
  [CATCH_UP, 'a catch-up that dropped older turns counts as cut',
    '  return missed.truncated > 0 || missed.clipped === 1;',
    '  return missed.clipped === 1;'],
  [CATCH_UP, 'a catch-up with one turn cut short counts as cut',
    '  return missed.truncated > 0 || missed.clipped === 1;',
    '  return missed.truncated > 0;'],
  [CATCH_UP, 'a catch-up inside the cap, or none at all, does not count as cut',
    '  if (!missed || !missed.text) return false;\n  return missed.truncated > 0 || missed.clipped === 1;',
    '  return true;'],

  // ===== WHERE THE NOTICE IS SENT =====
  [ENGINE, 'a Claude Code delegate arriving cut raises the notice',
    '  if (arriving) sendShortenedCopyNotice(convoId, delegateProcessId, shortenedCopyFor(targetAgent.id, missed));\n',
    ''],
  [CODEX, 'a Codex delegate on a fresh thread raises the notice',
    "      deps.safeSend(JSON.stringify({ type: 'system', subtype: 'notice', content: shortenedNotice, _conversationId: convoId, _processId: entry.processId }));\n",
    ''],
  [CODEX, 'a Codex delegate whose stored thread resumed raises none',
    '    if (!opened.resumed && shortenedNotice) {',
    '    if (shortenedNotice) {'],
  [ENGINE, 'an agent started again without its refused session raises the notice',
    '  sendShortenedCopyNotice(convoId, entry.processId, entry.shortenedCopy);\n',
    ''],
  [ENGINE, 'a Claude Code delegate resumed with a cut delta raises none',
    '  if (arriving) sendShortenedCopyNotice(convoId, delegateProcessId, shortenedCopyFor(targetAgent.id, missed));',
    '  sendShortenedCopyNotice(convoId, delegateProcessId, shortenedCopyFor(targetAgent.id, missed));'],

  // ===== WHAT THE AGENT IS TOLD =====
  [CATCH_UP, 'a cut catch-up carries the line under its heading',
    '  return isCutCatchUp(missed) ? `${heading}\\n${SHORTENED_COPY_LINE}\\n${text}\\n\\n` : `${heading}\\n${text}\\n\\n`;',
    '  return `${heading}\\n${text}\\n\\n`;'],
  [CATCH_UP, 'a catch-up inside the cap carries no line',
    '  return isCutCatchUp(missed) ? `${heading}\\n${SHORTENED_COPY_LINE}\\n${text}\\n\\n` : `${heading}\\n${text}\\n\\n`;',
    '  return `${heading}\\n${SHORTENED_COPY_LINE}\\n${text}\\n\\n`;'],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shortened-copy-harness-'));
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
