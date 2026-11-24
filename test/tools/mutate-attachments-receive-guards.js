#!/usr/bin/env node
'use strict';
// Break each rule a message sent with files depends on, in turn, and report
// which tests notice.
//
// A message's files are kept whole and only once, or refused with nothing
// kept, and deleting the conversation takes them too or says they stayed.
// That holds through a chain of small rules (the frame limit and the socket
// that survives a frame past it, the receive before the transition buffer,
// the payload's checks in their order, the reference check, the sizes the
// page shows, the editor's own limit, the delete and its notice), and every
// one of them can be deleted with most messages still looking fine. That is
// why each is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-receive-guards.js            # report
//   node test/tools/mutate-attachments-receive-guards.js --markdown # the same, as a table
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

const RECEIVE_SUITE = 'test/integration/attachments-receive.test.js';
// The composition root: the frame limit, the socket's error listener, and
// where the chat handler hands a message to the receive.
const SERVER = { src: path.join(ROOT, 'server.js'), suite: RECEIVE_SUITE };
// The payload's checks and the reference check.
const RECEIVE = { src: path.join(ROOT, 'lib', 'attachments', 'receive.js'), suite: 'test/unit/attachments-receive.test.js' };
const RECEIVER = { src: RECEIVE.src, suite: RECEIVE_SUITE };
// The sizes a stored line and a refusal show.
const WORDING = { src: path.join(ROOT, 'public', 'attachment-wording.js'), suite: 'test/unit/attachment-wording.test.js' };
// The editor's saves, stopped before a frame the server would not read.
const EDITOR = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/attachments-page.test.js' };
// Deleting a conversation, its files with it, and the notice when they stay.
const DELETE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'), suite: RECEIVE_SUITE };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. A broken guard can
// leave a server suite's tests waiting out their timeouts, so such a row names
// the test that proves it (`suite#test name`), one that fails on an assertion
// rather than by waiting out a timeout, and only that test runs. A name that
// matches nothing runs nothing, which turns nothing red and is reported as a
// failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== THE FRAME LIMIT, AND A SERVER THAT OUTLIVES A FRAME PAST IT =====
  [only(SERVER, 'the server reads frames of up to 28,000,000 bytes'), 'the server reads frames of up to 28 MB and no more',
    '  maxPayload: MAX_PAYLOAD,\n',
    ''],
  [only(SERVER, 'a frame of 28,000,001 bytes closes its own socket with 1009, and the server stays up'), 'a frame past the limit closes its own socket, never the server',
    "  ws.on('error', (err) => console.error('[WS] socket error:', err && err.message));\n",
    ''],

  // ===== STORED ONCE, BEFORE ANYTHING CAN QUEUE THE MESSAGE =====
  [only(SERVER, 'the transition buffer queues the stored message, and its replay writes nothing more'), 'the files are stored before the transition buffer can queue the message',
    "        if (attachmentReceiver.takes(msg, ws, typeof data !== 'string')) return;",
    "        if (bufferChatIfTransitioning(convoId, msg)) return;\n        if (attachmentReceiver.takes(msg, ws, typeof data !== 'string')) return;"],

  // ===== THE PAYLOAD'S CHECKS, IN THEIR ORDER =====
  [RECEIVE, 'the count is checked before any element is read',
    "  if (count > LIMITS.files) throw refusal('too-many-files', { count, limit: LIMITS.files });\n"
      + '  const elements = [];\n'
      + '  for (let i = 0; i < count; i++) {\n'
      + '    const element = list[i];\n'
      + "    if (!isPlainObject(element) || typeof element.name !== 'string' || typeof element.data !== 'string') throw refusal('bad-payload');\n"
      + '    elements.push(element);\n'
      + '  }\n',
    '  const elements = [];\n'
      + '  for (let i = 0; i < count; i++) {\n'
      + '    const element = list[i];\n'
      + "    if (!isPlainObject(element) || typeof element.name !== 'string' || typeof element.data !== 'string') throw refusal('bad-payload');\n"
      + '    elements.push(element);\n'
      + '  }\n'
      + "  if (count > LIMITS.files) throw refusal('too-many-files', { count, limit: LIMITS.files });\n"],
  [RECEIVE, 'only canonical base64 is decoded',
    "    if (bytes.toString('base64') !== data) throw refusal('bad-payload');\n",
    ''],
  [only(RECEIVER, 'naming an unknown entry is refused'), 'a reference to an entry the record does not hold is refused',
    "    if (own(msg, 'attachmentEntry') && !checkReference(getWorkspace(), msg)) {",
    '    if (false) {'],

  // ===== THE SIZES THE PAGE SHOWS, AND THE EDITOR'S OWN LIMIT =====
  [WORDING, 'a size is rounded up, never to the nearest unit',
    '  const unitsUp = (n, unit) => Math.floor((n + unit - 1) / unit);',
    '  const unitsUp = (n, unit) => Math.round(n / unit);'],
  [EDITOR, 'the editor sends a save whose frame is exactly at the limit',
    '  const tooLarge = new TextEncoder().encode(frame).length > SAVE_FRAME_LIMIT;',
    '  const tooLarge = new TextEncoder().encode(frame).length >= SAVE_FRAME_LIMIT;'],

  // ===== A DELETED CONVERSATION'S FILES GO WITH IT, OR THE PAGE IS TOLD =====
  [only(DELETE, 'a conversation with a message\'s files: the folder goes, the ID is listed, the transcript stays, and no notice'), 'deleting a conversation deletes its attachments',
    '    const kept = await deleteAttachments(workspace, msg.id)',
    '    const kept = await Promise.resolve()'],
  [only(DELETE, 'a deleted list holding not json: the conversation goes, its files stay, and the notice says where'), 'files a delete could not remove are reported',
    "    if (kept) ws.send(JSON.stringify({ type: 'conversation_files_kept'",
    "    if (false) ws.send(JSON.stringify({ type: 'conversation_files_kept'"],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-receive-harness-'));
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
