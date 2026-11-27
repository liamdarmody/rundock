#!/usr/bin/env node
'use strict';
// Break each rule that handing a runtime a turn with attached files depends
// on, in turn, and report which tests notice.
//
// Every attached-file line in a turn is checked against the conversation's
// record as the turn is built: the store reads each file in one open, after
// walking to it with no link on the way, and judges it by its size and its
// fingerprint. A line naming another conversation's folder is never trusted.
// A Claude Code turn carries the images and PDFs of the record entry of the
// message it answers, never of a line the text happens to quote, and the
// turn module reads no file itself. Each process entry carries the record
// entry of the message its turn answers, a delegate takes its leader's, a
// follow-up with no files clears it, and a write carried into a fresh start
// keeps its own. A Codex turn passes its extra items through to the app
// server, and the session history reads back an array only when it holds a
// block. Each of those is a small rule that can be deleted with attaching
// still looking alive in most tests, which is why each is broken on purpose
// here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-turn-guards.js            # report
//   node test/tools/mutate-attachments-turn-guards.js --markdown # the same, as a table
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

const TURN_UNIT = 'test/unit/attachments-turn.test.js';
const TURN_INTEGRATION = 'test/integration/attachments-turn.test.js';
// The store's one open: the walk, the size and the fingerprint.
const STORE = { src: path.join(ROOT, 'lib', 'attachments', 'store.js'), suite: TURN_UNIT };
// The turn itself: each line checked, and the blocks from the entry.
const TURN = { src: path.join(ROOT, 'lib', 'attachments', 'turn.js'), suite: TURN_UNIT };
// The delegation engine: a delegate's record entry and its first turn.
const ENGINE = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: TURN_INTEGRATION };
// The server: a follow-up's record entry, and the retry after a refused resume.
const SERVER = { src: path.join(ROOT, 'server.js'), suite: TURN_INTEGRATION };
// The app server's turn start, with the items that follow the text.
const APP_SERVER = { src: path.join(ROOT, 'codex-appserver.js'), suite: 'test/unit/codex-appserver.test.js' };
// The session history's reading of a user line.
const HISTORY = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/attachments-session-readers.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER OR LOADS ONE. The
// integration suite starts a server and runs for a while unbroken, and a
// broken guard can leave its tests waiting out their timeouts, so a row that
// ran all of it would cost minutes. Such a row names the test that proves it
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
  // ===== THE STORE READS EACH FILE IN ONE OPEN, AND JUDGES IT BY THE RECORD =====
  // The size check and the length check go, and only the recorded length is
  // read: the fingerprint alone would still catch a file grown at its end,
  // so the read stops at the recorded size, which is how skipping the size
  // lets one pass.
  [STORE, 'the size goes unchecked, so a file grown since it was sent reads as present',
    "    if (stat.size !== described.bytes) return { state: 'changed', described };\n"
      + '    // One byte past the recorded size, so a file grown since the stat shows.\n'
      + '    const read = readAtMost(fd, described.bytes + 1, keep);\n'
      + "    if (read.length !== described.bytes) return { state: 'changed', described };\n",
    '    const read = readAtMost(fd, described.bytes, keep);\n'],
  [STORE, 'the fingerprint goes unchecked, so a file rewritten at the same size reads as present',
    "    if (read.sum !== described.sha256) return { state: 'changed', described };\n",
    ''],
  // The record sits in the conversation's folder, so a link on the way to a
  // file is on the way to the record too: the walk is skipped for both.
  [STORE, 'the walk is skipped, so a link on the way to a file is followed',
    '  assertSafePath(root, target, () => { throw refusal(code); });\n',
    ''],

  // ===== EACH LINE IN THE TEXT IS CHECKED AGAINST THIS CONVERSATION'S RECORD =====
  [TURN, "a line naming another conversation's folder is checked against that conversation's record",
    'if (id !== conversationId) return notAvailable(file);',
    'if (id !== conversationId) return lineFor(id, file, store.readRecordedFile(workspace, id, file));'],
  [TURN, 'the turn reads a file by its path after the store has checked it',
    '      let read = store.readRecordedFile(workspace, conversationId, file, { keep: keep.has(file) });\n',
    '      let read = store.readRecordedFile(workspace, conversationId, file, { keep: keep.has(file) });\n'
      + "      const fs = require('node:fs');\n"
      + "      if (read.state === 'present') read = { ...read, bytes: fs.readFileSync(require('node:path').join(workspace, '.rundock', 'attachments', conversationId, file)) };\n"],

  // ===== A CLAUDE CODE TURN'S BLOCKS COME FROM ITS RECORD ENTRY =====
  [TURN, 'the blocks come from the lines in the text, not from the record entry',
    "  const files = runtime === 'codex' ? [] : entryFiles(workspace, conversationId, entryId);\n",
    '  const listed = readRecord(workspace, conversationId).messages.flatMap((m) => m.files);\n'
      + '  const files = [...text.matchAll(LINE)].map((m) => listed.find((f) => f.file === m.groups.file)).filter(Boolean);\n'],

  // ===== WHAT A TURN READS IS BOUNDED PER FILE AND BY WHAT IT NAMES =====
  [TURN, 'a turn-wide cap is put back, so a present file past 100,000,000 bytes read in the turn is not available',
    '      reads.set(file, read);\n',
    "      reads.spent = (reads.spent || 0) + (read.state === 'present' ? read.described.bytes : 0);\n"
      + "      if (reads.spent > 100000000) read = { state: 'missing', described: undefined };\n"
      + '      reads.set(file, read);\n'],

  // ===== EACH PROCESS ENTRY CARRIES THE RECORD ENTRY OF THE MESSAGE ITS TURN ANSWERS =====
  [only(ENGINE, "a delegate's brief is sent as text alone, and a deleted file's line in it as not available"), "a delegate's first turn is written as the brief, never through the check",
    'turnContent(delegateEntry, convoId, contextWithHistory, delegateAttachmentEntry)',
    'contextWithHistory'],
  [only(ENGINE, 'a delegate is sent the images of the message its leader was answering, though the brief leaves their lines out'), "a delegate's entry does not take its leader's record entry",
    '  if (existing && existing.attachmentEntry) delegateEntry.attachmentEntry = existing.attachmentEntry;\n',
    ''],
  [only(SERVER, 'a delegation from a follow-up with no files sends the delegate no blocks'), 'a follow-up with no files leaves the earlier record entry on the process',
    '            else delete existing.attachmentEntry;\n',
    ''],
  [only(SERVER, 'a text-only message sent while it was starting is re-emitted with no record entry, and arrives as a string'), "the retry gives a write carried with no record entry the first message's",
    '                delete keptBase.attachmentEntry;\n',
    ''],

  // ===== A CODEX TURN'S EXTRA ITEMS REACH THE APP SERVER =====
  [APP_SERVER, 'the turn start drops the items that follow the text',
    "input: [{ type: 'text', text: inputText }, ...extraItems] }",
    "input: [{ type: 'text', text: inputText }] }"],

  // ===== THE HISTORY READS BACK AN ARRAY ONLY WHEN IT HOLDS A BLOCK =====
  [only(HISTORY, "an array of text alone is not the person's message, to any reader"), "the history takes an array of text alone as the person's message",
    '      // or PDFs as its text (lib/attachments/turn-text.js).\n'
      + "      const userText = obj.type === 'user' && obj.message ? userTurnText(obj.message.content) : null;\n",
    '      // or PDFs as its text (lib/attachments/turn-text.js).\n'
      + "      const userText = obj.type === 'user' && obj.message\n"
      + "        ? (Array.isArray(obj.message.content) && obj.message.content.every((b) => b && b.type === 'text')\n"
      + "          ? obj.message.content.map((b) => b.text).join(' ')\n"
      + '          : userTurnText(obj.message.content))\n'
      + '        : null;\n'],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-turn-harness-'));
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
