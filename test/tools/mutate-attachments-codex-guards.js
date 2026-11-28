#!/usr/bin/env node
'use strict';
// Break each rule that sending attached files to an agent on Codex depends
// on, in turn, and report which tests notice.
//
// A Codex turn names an image only beside its localImage item, and only when
// its stored bytes are an image of its recorded type and no entry past a
// message's limits lists it; it gives a PDF a line saying Codex can't read
// it, and sends a short text file of the message's own entry as its text,
// which search leaves out of a Codex session it indexes, and only of one.
// What each session or thread is sent natively is recorded, and
// bounds what it is sent again: a file it was sent is not sent again, the
// budget holds at its figures exactly, an entry of the wrong shape counts as
// spent, and what a Claude Code process was sent before it reported its
// session is recorded under the ID it reports. A thread resumed on another
// app-server process is sent its images again, and one resumed on the same
// process is not. The server refuses images that would take a Codex session
// past the budget, counted with what it was already sent and what messages
// accepted before them hold until their turns record them, and checks every
// file once the record is written. Each of those is a small rule that can be
// deleted with attaching still looking alive in most tests, which is why
// each is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-codex-guards.js            # report
//   node test/tools/mutate-attachments-codex-guards.js --markdown # the same, as a table
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

const CODEX_TURN_UNIT = 'test/unit/attachments-codex-turn.test.js';
const SENT_UNIT = 'test/unit/attachments-sent.test.js';
const RECEIVE_UNIT = 'test/unit/attachments-receive.test.js';
const CODEX_INTEGRATION = 'test/integration/attachments-codex.test.js';
const TURN_SRC = path.join(ROOT, 'lib', 'attachments', 'turn.js');
const STORE_SRC = path.join(ROOT, 'lib', 'attachments', 'store.js');
// A Codex turn: each line's form and its item.
const CODEX_TURN = { src: TURN_SRC, suite: CODEX_TURN_UNIT };
// What a session was sent, counted as a turn is built and recorded at init.
const SENT_TURN = { src: TURN_SRC, suite: SENT_UNIT };
// A thread resumed on the same app-server process or on another.
const RESUME = { src: TURN_SRC, suite: CODEX_INTEGRATION };
// A Codex turn as the stub Codex logs its turn/start.
const LOGGED_TURN = { src: TURN_SRC, suite: CODEX_INTEGRATION };
// The budget's two figures.
const BUDGET = { src: path.join(ROOT, 'lib', 'attachments', 'detect.js'), suite: SENT_UNIT };
// Search's reading of a session line.
const SEARCH = { src: path.join(ROOT, 'search.js'), suite: CODEX_TURN_UNIT };
// The record's entry for a session.
const SENT_STORE = { src: STORE_SRC, suite: SENT_UNIT };
// What the server refuses for an agent on Codex, before the write.
const RECEIVE = { src: path.join(ROOT, 'lib', 'attachments', 'receive.js'), suite: RECEIVE_UNIT };
// The files checked once the record is written.
const WRITE = { src: STORE_SRC, suite: RECEIVE_UNIT };
// A Claude Code send the server writes itself, recorded once it is written.
const LEGACY_SEND = { src: path.join(ROOT, 'server.js'), suite: CODEX_INTEGRATION };
const HANDOVER_SEND = { src: path.join(ROOT, 'lib', 'delegation', 'engine.js'), suite: CODEX_INTEGRATION };
// The app-server process a Codex thread is opened on.
const OPENED = { src: path.join(ROOT, 'lib', 'runtime', 'codex-glue.js'), suite: CODEX_INTEGRATION };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The integration
// suite starts a server and runs for a while unbroken, and a broken guard can
// leave its tests waiting out their timeouts, so a row that ran all of it
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
  // ===== A CODEX TURN NAMES AN IMAGE ONLY WITH THE IMAGE =====
  [CODEX_TURN, 'an image that fits the budget keeps its line and loses its item',
    "    if (blockable(one.described) && take(budget, file, one.described)) return { line, item: { type: 'localImage', path: path.join(folder, file) } };\n",
    '    if (blockable(one.described) && take(budget, file, one.described)) return { line };\n'],
  [CODEX_TURN, 'a PDF keeps its line, as if Codex could read it',
    "    if (type === 'pdf') return { line: pdfForm(file) };\n",
    ''],
  [CODEX_TURN, 'a text file over 100,000 bytes is sent inline',
    'const INLINE_BYTES = 100000;\n',
    'const INLINE_BYTES = 100001;\n'],
  [SEARCH, 'search reads a text file sent inline as if the person had typed it',
    "      .filter(b => role !== 'user' || !isInlineFileText(b.text))\n",
    ''],
  [CODEX_TURN, 'an image past the limits Claude Code is sent images under is given its item',
    "    if (blockable(one.described) && take(budget, file, one.described)) return { line, item: { type: 'localImage', path: path.join(folder, file) } };\n",
    "    if (take(budget, file, one.described)) return { line, item: { type: 'localImage', path: path.join(folder, file) } };\n"],
  [CODEX_TURN, 'a missing or changed PDF is given the PDF form',
    "    if (one.state !== 'present') return { line };\n    const { type } = one.described;\n    if (type === 'pdf') return { line: pdfForm(file) };\n",
    "    const { type } = one.described || {};\n    if (type === 'pdf') return { line: pdfForm(file) };\n    if (one.state !== 'present') return { line };\n"],
  [CODEX_TURN, 'a missing or changed text file of the entry is given the read-first suffix',
    "    if (one.state !== 'present') return { line };\n    const { type } = one.described;\n",
    "    const { type } = one.described || {};\n    if (one.state !== 'present' && !TEXT_TYPES.has(type)) return { line };\n"],
  [CODEX_TURN, 'a text file sent inline is read as Latin-1',
    "const inlineItem = (file, bytes) => ({ type: 'text', text: `[Text of attached file ${file}]\\n${bytes.toString('utf8')}` });\n",
    "const inlineItem = (file, bytes) => ({ type: 'text', text: `[Text of attached file ${file}]\\n${bytes.toString('latin1')}` });\n"],
  [CODEX_TURN, 'other bytes recorded under an image\'s description are shown as that image',
    "      if (images && read.state === 'present' && isImage(read.described.type) && !imageOf(read)) read = { state: 'changed', described: read.described };\n",
    ''],
  [CODEX_TURN, 'an image of another type recorded under an image\'s description is shown as that image',
    "    return detectFile(read.bytes, '').type === read.described.type;\n",
    "    return isImage(detectFile(read.bytes, '').type);\n"],
  [CODEX_TURN, 'a line naming an image of an entry past a message\'s limits is given its item',
    '    if (unfit.has(file)) return { line: notShown(file) };\n',
    ''],
  [only(LOGGED_TURN, 'a turn naming the PNG of an entry altered to list six files, its PNG still present, is sent the not-shown form and no localImage item'),
    'a turn/start carries the item for an image of an entry past a message\'s limits',
    '    if (unfit.has(file)) return { line: notShown(file) };\n',
    ''],
  [CODEX_TURN, 'a cold resume sends again an image of an entry past a message\'s limits',
    '      if (unfit.has(file)) continue;\n',
    ''],
  [SEARCH, 'search leaves out a Claude Code message that begins like an inline file',
    '    const text = userText.trim();\n',
    "    const text = isInlineFileText(userText) ? '' : userText.trim();\n"],

  // ===== WHAT A SESSION WAS SENT BOUNDS WHAT IT IS SENT AGAIN =====
  [SENT_TURN, 'a file the session was sent is sent to it again',
    '  return budget.sent.has(file);\n',
    '  return false;\n'],
  [BUDGET, 'a copy that brings the session to either figure exactly is withheld',
    '  return bytes <= NATIVE_BUDGET.bytes && images <= NATIVE_BUDGET.images;\n',
    '  return bytes < NATIVE_BUDGET.bytes && images < NATIVE_BUDGET.images;\n'],
  [SENT_STORE, 'an entry of the wrong shape is counted as nothing sent',
    '  if (!wellFormed(entry)) return SPENT;\n',
    '  if (!wellFormed(entry)) return NO_ENTRY;\n'],
  [SENT_TURN, 'what a process was sent before init is never recorded under the session it reports',
    '  const held = sends.held || NOTHING_HELD;\n',
    '  const held = NOTHING_HELD;\n'],
  [SENT_STORE, 'a session named after an inherited property is read as that property',
    "  if (typeof session !== 'string' || !isObject(sent) || !Object.prototype.hasOwnProperty.call(sent, session)) return NO_ENTRY;\n",
    "  if (typeof session !== 'string' || !isObject(sent) || sent[session] === undefined) return NO_ENTRY;\n"],
  [only(LEGACY_SEND, 'a legacy start records what it was sent under the ID its process reports'),
    'a legacy start records nothing it was sent',
    '          claudeSent(WORKSPACE, convoId, entry, legacyTurn);\n',
    ''],
  [only(HANDOVER_SEND, 'a brief handed to a delegate records what it was sent under the ID the delegate\'s process reports'),
    'a brief handed to a delegate records nothing it was sent',
    '  recordWritten(delegateEntry, convoId);\n',
    ''],
  [only(HANDOVER_SEND, 'a delegate started fresh after its session was refused records what its brief was sent under the ID the fresh process reports'),
    'a delegate started fresh records nothing its brief was sent',
    '    recordWritten(entry, convoId);\n  } else holdFreshCatchUp(entry, freshCatchUp);\n',
    '  } else holdFreshCatchUp(entry, freshCatchUp);\n'],
  [only(HANDOVER_SEND, 'a message kept for a delegate starting fresh records what it was sent under the ID the fresh process reports'),
    'a message kept for a delegate starting fresh records nothing it was sent',
    '    recordWritten(entry, convoId);\n  }\n  // Still held',
    '  }\n  // Still held'],

  // ===== A THREAD RESUMED ON ANOTHER APP-SERVER PROCESS IS SENT ITS IMAGES AGAIN =====
  [only(RESUME, 'a thread whose entry names another app-server instance is sent its PNG again'),
    'a thread resumed on another app-server process counts as warm',
    '  return resumed === true && entry.instance !== instance;\n',
    '  return false;\n'],
  [only(RESUME, 'a follow-up on the same app-server naming the PNG\'s line is given the shown-earlier form'),
    'a thread resumed on the same app-server process counts as cold',
    '  return resumed === true && entry.instance !== instance;\n',
    '  return true;\n'],
  [only(RESUME, 'a thread whose entry names no instance is sent its PNG again'),
    'a thread whose entry names no instance counts as warm',
    '  return resumed === true && entry.instance !== instance;\n',
    "  return resumed === true && typeof entry.instance === 'string' && entry.instance !== instance;\n"],
  [only(RESUME, 'a thread with no entry is sent nothing again when it is resumed'),
    'a cold resume sends again every image the conversation lists, not those its thread was sent',
    '    for (const file of [...new Set(recorded.files)].reverse()) {\n',
    '    for (const file of [...new Set(store.readRecord(workspace, conversationId).messages.flatMap((m) => m.files.map((f) => f.file)))].reverse()) {\n'],
  [CODEX_TURN, 'a cold resume counts what the thread was sent on the process before',
    '  const budget = budgetFor(cold ? NOTHING_HELD : recorded, unrecorded);\n',
    '  const budget = budgetFor(recorded, unrecorded);\n'],
  [CODEX_TURN, 'a cold resume sends again an image changed since the thread was sent it',
    "      if (one.state !== 'present' || !Object.prototype.hasOwnProperty.call(IMAGE_TYPES, one.described.type)) continue;\n",
    "      if (one.state === 'missing' || !Object.prototype.hasOwnProperty.call(IMAGE_TYPES, one.described.type)) continue;\n"],
  [CODEX_TURN, 'a cold resume sends again an image the turn already carries',
    '      if (budget.taken.files.includes(file)) continue;\n',
    ''],
  [CODEX_TURN, 'a cold resume sends again an image past the budget',
    '      if (!blockable(one.described) || !take(budget, file, one.described)) continue;\n',
    '      if (!blockable(one.described)) continue;\n'],
  [only(OPENED, 'a Codex turn is recorded with its app-server process\'s instance, the same on a follow-up to that process and a new one once it respawns'),
    'an opened thread is answered with no instance',
    '  return { server, threadId, resumed, instance: _codexInstances.get(server) };\n',
    '  return { server, threadId, resumed };\n'],
  [only(OPENED, 'a Codex turn is recorded with its app-server process\'s instance, the same on a follow-up to that process and a new one once it respawns'),
    'a respawned app-server keeps the instance of its first process',
    '      _codexInstances.set(server, crypto.randomUUID());\n',
    '      if (!_codexInstances.has(server)) _codexInstances.set(server, crypto.randomUUID());\n'],

  // ===== THE SERVER REFUSES WHAT CODEX CAN'T BE SENT, AND CHECKS WHAT IT WROTE =====
  [RECEIVE, 'images for a Codex agent are counted without what its session was already sent',
    '  const bytes = images.reduce((sum, file) => sum + file.bytes.length, entry.bytes);\n'
      + "  if (!withinBudget({ bytes, images: entry.images + images.length })) throw refusal('codex-images');\n",
    '  const bytes = images.reduce((sum, file) => sum + file.bytes.length, 0);\n'
      + "  if (!withinBudget({ bytes, images: images.length })) throw refusal('codex-images');\n"],
  [WRITE, 'the files are not checked once the record is written',
    "    if (!stored.every((described) => checkRecordedFile(root, id, described.file) === 'present')) {\n",
    '    if (false) {\n'],
  [RECEIVE, 'images for a Codex agent are counted without what messages accepted before them hold',
    '  const entry = withPending(sentEntry(record.sent, msg.sessionId), root, msg);\n',
    '  const entry = sentEntry(record.sent, msg.sessionId);\n'],
  [WRITE, 'a message accepted for a Codex agent holds none of its images',
    '    if (admitted) admitted(entry);\n',
    ''],
  [only(OPENED, 'once each message\'s send is recorded its images count from the record alone, so a thread at 17 is sent three more one at a time'),
    'a recorded send leaves its message\'s images held',
    "    // Recorded, so the message's images now count from the record alone.\n    releasePendingImages(entry.attachmentEntry);\n",
    ''],
  [only(OPENED, 'a one-image message whose turn fails to start leaves nothing counted, so the next one for a thread at 19 is stored'),
    'a turn that fails to start leaves its message\'s images held',
    "  // The message's images were never sent, so they no longer count as held.\n  releasePendingImages(entry.attachmentEntry);\n",
    ''],
  [only(OPENED, 'a one-image message whose turn a newer message takes over before it starts leaves nothing counted, so the next one for a thread at 19 is stored'),
    'a turn a newer message takes over before it starts leaves its message\'s images held',
    '    if (!opened) {\n      releasePendingImages(entry.attachmentEntry);\n      return;\n    }\n',
    '    if (!opened) return;\n'],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-codex-harness-'));
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
