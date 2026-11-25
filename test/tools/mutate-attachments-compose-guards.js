#!/usr/bin/env node
'use strict';
// Break each rule that attaching files to a message depends on, in turn, and
// report which tests notice.
//
// A message with files crosses the socket in one frame, is checked and stored
// before anything else sees it, carries the stored text from then on, and has
// its files removed when its conversation is deleted. In the window, the
// composer holds the picked files as chips, refuses a pick that would break a
// limit, sends text and files together and clears only once the server says
// they were stored. Each of those is a small rule that can be deleted with
// attaching still looking alive in most tests, which is why each is broken on
// purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-compose-guards.js            # report
//   node test/tools/mutate-attachments-compose-guards.js --markdown # the same, as a table
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

const RECEIVE = 'test/integration/attachments-receive.test.js';
// The socket, and where a chat is handed to the receive.
const SERVER = { src: path.join(ROOT, 'server.js'), suite: RECEIVE };
// The receive itself: the checks, the hold for Codex and the reference check.
const RECEIVE_SRC = path.join(ROOT, 'lib', 'attachments', 'receive.js');
const RECEIVER = { src: RECEIVE_SRC, suite: RECEIVE };
const RECEIVER_UNIT = { src: RECEIVE_SRC, suite: 'test/unit/attachments-receive.test.js' };
// Deleting a conversation removes its files, and says when it could not.
const DELETE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'conversations.js'), suite: RECEIVE };
// The wording shared by the window and the server.
const WORDING = { src: path.join(ROOT, 'public', 'attachment-wording.js'), suite: 'test/unit/attachment-wording.test.js' };
// The editor's own limit on what one save may send.
const EDITOR = { src: path.join(ROOT, 'public', 'views', 'files.js'), suite: 'test/unit/editor-save-limit.test.js' };
// The composer: the chips, the pick check and the send.
const COMPOSER_SRC = path.join(ROOT, 'public', 'views', 'composer.js');
const CHIPS = { src: COMPOSER_SRC, suite: 'test/unit/attachments-composer.test.js' };
const SEND = { src: COMPOSER_SRC, suite: 'test/unit/attachments-send.test.js' };
// The socket closing while a send waits for its answer.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/attachments-send.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The receive suite
// starts a server and runs for a while unbroken, and a broken guard can leave
// its tests waiting out their timeouts, so a row that ran all of it would cost
// minutes. Such a row names the test that proves it (`suite#test name`), one
// that fails on an assertion rather than by waiting out a timeout, and only
// that test runs. A name that matches nothing runs nothing, which turns
// nothing red and is reported as a failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== ONE FRAME CARRIES A WHOLE MESSAGE, AND A LARGER ONE ENDS ONLY ITS OWN SOCKET =====
  [only(SERVER, 'the server reads frames of up to 28,000,000 bytes'), 'the socket reads frames as large as a whole message',
    '  maxPayload: MAX_PAYLOAD,\n',
    ''],
  [only(SERVER, 'a frame of 28,000,001 bytes closes its own socket with 1009, and the server stays up'), 'a frame too large ends its own socket, never the server',
    "  ws.on('error', (err) => console.error('[WS] socket error:', err && err.message));\n",
    ''],
  [only(SERVER, 'the transition buffer queues the stored message, and its replay by endConvoTransition writes nothing more'), 'a chat is received before the transition buffer can hold it',
    "        if (attachmentReceiver.takes(msg, ws, typeof data !== 'string')) return;",
    "        if (bufferChatIfTransitioning(convoId, msg)) return;\n        if (attachmentReceiver.takes(msg, ws, typeof data !== 'string')) return;"],

  // ===== WHAT ARRIVES IS CHECKED BEFORE ANYTHING IS WRITTEN =====
  [RECEIVER_UNIT, 'the count is checked before any element is read',
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
  [RECEIVER_UNIT, 'data that is not canonical base64 is refused',
    "    if (bytes.toString('base64') !== data) throw refusal('bad-payload');\n",
    ''],
  [only(RECEIVER, 'naming an unknown entry is refused'), 'a reference to a record entry is checked against the conversation\'s own record',
    "    if (own(msg, 'attachmentEntry') && !checkReference(getWorkspace(), msg)) {",
    '    if (false) {'],
  [RECEIVER_UNIT, 'files for a Codex agent are held back until it can read them',
    '      if (forCodex(msg)) {',
    '      if (false) {'],
  [only(RECEIVER, 'set_workspace waits for the files, which are stored, recorded and dispatched in the first workspace; the next message goes to the second'),
    'a workspace switch waits for every message whose files are on their way',
    '  return inFlight.size > 0;\n',
    '  return false;\n'],

  // ===== DELETING A CONVERSATION DELETES ITS FILES, AND SAYS WHEN IT COULD NOT =====
  [only(DELETE, 'a chat with files on its way when the delete arrives is stored and dispatched once, then its folder goes, and no notice'),
    'the delete waits for a message whose files are on their way',
    '  await whenReceived(msg.id);\n',
    ''],
  [only(DELETE, 'a conversation with a message\'s files: the folder goes, the ID is listed, the transcript stays, and no notice'),
    'deleting a conversation deletes its attachments',
    '  const kept = await deleteAttachments(workspace, msg.id).then(',
    '  const kept = await Promise.resolve().then('],
  [only(DELETE, 'a deleted list holding not json: the conversation goes, its files stay, and the notice says where'),
    'files that could not be deleted are told to the person',
    '  if (kept) {',
    '  if (false) {'],

  // ===== THE WORDING =====
  [WORDING, 'a size is rounded up, never to the nearest',
    '  const unitsUp = (n, unit) => Math.floor((n + unit - 1) / unit);',
    '  const unitsUp = (n, unit) => Math.round(n / unit);'],

  // ===== THE EDITOR STOPS A SAVE TOO LARGE FOR ONE FRAME =====
  [EDITOR, 'a save of exactly the frame limit is sent',
    '  if (new TextEncoder().encode(frame).length <= EDITOR_FRAME_LIMIT) return false;',
    '  if (new TextEncoder().encode(frame).length < EDITOR_FRAME_LIMIT) return false;'],

  // ===== THE COMPOSER =====
  [SEND, 'a send of exactly the frame limit goes',
    '    if (bytes > COMPOSER_FRAME_LIMIT)',
    '    if (bytes >= COMPOSER_FRAME_LIMIT)'],
  [CHIPS, 'a pick is checked with the files already attached',
    '  const bytes = all.reduce((sum, file) => sum + file.size, 0);\n'
      + "  const refusal = all.length > FILE_LIMIT ? { code: 'too-many-files', count: all.length, limit: FILE_LIMIT }",
    '  const bytes = picked.reduce((sum, file) => sum + file.size, 0);\n'
      + "  const refusal = picked.length > FILE_LIMIT ? { code: 'too-many-files', count: picked.length, limit: FILE_LIMIT }"],
  [SEND, 'the composer is cleared once the server has stored the message, not on send',
    '  composer.waiting = token;\n  composer.notice = null;\n  renderComposer(composer);',
    "  composer.waiting = token;\n  composer.notice = null;\n  composer.files = [];\n  document.getElementById('msg-input').value = '';\n  renderComposer(composer);"],
  [APP, 'a send waiting when the socket closes is ended',
    'linkCreatesConnectionLost(); attachmentsConnectionLost(); showIfSignedOut();',
    'linkCreatesConnectionLost(); showIfSignedOut();'],
  [SEND, 'Send lights for files alone',
    '  return !!String(text).trim() || (!!composer && composer.files.length > 0);',
    '  return !!String(text).trim();'],
  [CHIPS, 'a chip shows its file\'s name as text',
    '  name.textContent = file.name;',
    '  name.innerHTML = file.name;'],
  [CHIPS, 'focus moves on from a removed chip',
    "  (buttons[index] || buttons[index - 1] || document.getElementById('msg-input')).focus();\n",
    ''],
  [SEND, 'a send of text alone takes the inline message away',
    '  if (!composer.files.length) {\n    composer.notice = null;\n    renderComposerNotice(composer);\n    return false;\n  }',
    '  if (!composer.files.length) return false;'],
  [SEND, 'the message field is fixed while a send with files waits for its answer',
    "  document.getElementById('msg-input').readOnly = true;\n",
    ''],
  [SEND, 'a different workspace empties every composer',
    '  composers.clear();\n',
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-compose-harness-'));
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
