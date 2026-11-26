#!/usr/bin/env node
'use strict';
// Break each rule that keeps a message with files from being lost, in turn,
// and report which tests notice.
//
// A workspace switch waits for every chat a hand-over holds, so the chat is
// recorded and dispatched in the workspace it was sent to, and only a
// hand-over holding a chat holds a switch, for no longer than its failsafe.
// In the window, the notice that a deleted conversation's files were kept is
// a row in its own strip above the view, shown as text, which nothing but its
// own close removes. Each of those is a small rule that can be deleted with
// everything still looking alive in most tests, which is why each is broken
// on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-followup-guards.js            # report
//   node test/tools/mutate-attachments-followup-guards.js --markdown # the same, as a table
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
// The hand-over machine: which transitions hold a switch, and their failsafe.
const SERVER = { src: path.join(ROOT, 'server.js'), suite: RECEIVE };
// The switch handlers, which wait for files and then for a hand-over.
const WORKSPACE = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'workspace.js'), suite: RECEIVE };
// The window: the arm, the notice and the strip it goes in.
const NOTICE_SUITE = 'test/unit/attachments-delete-notice.test.js';
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: NOTICE_SUITE };
const NOTICE = { src: path.join(ROOT, 'public', 'views', 'conversations.js'), suite: NOTICE_SUITE };
const PAGE = { src: path.join(ROOT, 'public', 'index.html'), suite: NOTICE_SUITE };

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

// The strip moved into the message view, as one replace: the page from the
// strip's own line to the message view, with the strip taken out of main and
// put inside the message view. A page missing either end, or with the message
// view before the strip, gives the strip's line joined to the message view as
// the search text: that can stand in such a page nowhere, so the row is
// reported as not found rather than breaking something else.
const STRIP_LINE = '    <div id="files-kept-notices" role="status" hidden></div>\n';
const MESSAGES = '<div class="messages" id="messages"></div>';
function stripIntoMessages() {
  const html = fs.readFileSync(PAGE.src, 'utf-8');
  const start = html.indexOf(STRIP_LINE);
  const end = start === -1 ? -1 : html.indexOf(MESSAGES, start);
  if (end === -1) return [STRIP_LINE + MESSAGES, ''];
  const from = html.slice(start, end + MESSAGES.length);
  const to = from.slice(STRIP_LINE.length, -MESSAGES.length)
    + MESSAGES.replace('></div>', `>${STRIP_LINE.trim()}</div>`);
  return [from, to];
}

const MUTATIONS = [
  // ===== A SWITCH WAITS FOR A CHAT A HAND-OVER HOLDS =====
  [only(SERVER, 'set_workspace waits while a hand-over holds a stored message, which is recorded and dispatched in the first workspace'),
    'a switch waits while a hand-over holds a chat',
    '  return [...convoTransitions.values()].some((t) => t.queued.length > 0);',
    '  return false;'],
  [only(WORKSPACE, 'create_workspace waits while a hand-over holds a stored message the same way'),
    'creating a workspace waits for a hand-over too',
    '  if (afterHandOver(handleCreateWorkspace, ctx, ws, msg)) return;\n',
    ''],
  [only(SERVER, 'set_workspace waits while a hand-over holds a text chat, whose row and prompt stay in the first workspace'),
    'a text chat a hand-over holds holds a switch as a stored one does',
    '  return [...convoTransitions.values()].some((t) => t.queued.length > 0);',
    '  return [...convoTransitions.values()].some((t) => t.queued.some((m) => m.attachmentEntry));'],
  [only(WORKSPACE, 'a switch that waited for files waits again while the hand-over holds them, with the chat behind them'),
    'a switch that waited for files checks for a hand-over again',
    'whenAllReceived().then(() => handler(ctx, ws, msg))',
    'whenAllReceived().then(() => handler({ ...ctx, transitions: null }, ws, msg))'],
  [only(SERVER, 'a hand-over holding a chat holds a switch until it replays the chat, then a hand-over holding nothing lets the next switch answer at once'),
    'only a hand-over holding a chat holds a switch',
    '  return [...convoTransitions.values()].some((t) => t.queued.length > 0);',
    '  return convoTransitions.size > 0;'],
  [only(SERVER, 'a hand-over nothing else ends holds the switch until its failsafe flushes it, and no longer'),
    'a hand-over nothing else ends is ended by its failsafe, which bounds the wait',
    '    endConvoTransition(convoId, t.owner);\n',
    ''],

  // ===== THE FILES-KEPT NOTICE STAYS ABOVE THE VIEW UNTIL IT IS CLOSED =====
  [APP, 'the notice goes to its strip, never into the conversation',
    "case 'conversation_files_kept': showFilesKeptNotice(d.text); break;",
    "case 'conversation_files_kept': addSystemMsgToConvo(d.text, null, false); break;"],
  [NOTICE, 'the notice the page\'s dispatch calls is the one that draws the row',
    '  showFilesKeptNotice,\n};',
    '  showFilesKeptNotice: function showFilesKeptNotice(text) {},\n};'],
  [NOTICE, 'the notice shows the server\'s text as text',
    '  span.textContent = text;',
    '  span.innerHTML = text;'],
  [NOTICE, 'a close removes its own row only',
    'close.onclick = () => { row.remove();',
    'close.onclick = () => { box.replaceChildren();'],
  [NOTICE, 'the strip is hidden when its last row is closed',
    ' if (!box.children.length) box.hidden = true;',
    ''],
  [PAGE, 'the strip sits in main, outside the message view', ...stripIntoMessages()],
  [APP, 'nothing but a close clears a row, a workspace change included',
    'composersWorkspaceChanged(); }',
    "composersWorkspaceChanged(); document.getElementById('files-kept-notices').replaceChildren(); }"],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-followup-harness-'));
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
