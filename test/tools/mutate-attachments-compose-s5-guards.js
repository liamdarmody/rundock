#!/usr/bin/env node
'use strict';
// Break each rule that adding files to the composer depends on, in turn, and
// report which tests notice.
//
// Files reach the composer three ways, a pick, a paste and a drop, and every
// one goes through the same add: the count first, then each file's own bytes,
// then the total. What an add can't take says why in a message under the
// field, and those messages stack until an add attaches something. A paste
// names its images "Pasted image", then "Pasted image 2" and on, and leaves
// text on the clipboard to the field. A drag of files over the conversation
// is taken by the composer, and one let go anywhere else in the window opens
// nothing. A PDF for an agent on Codex is held with Send off until it goes. A
// file's name is only ever text. Each of those is a small rule that can be
// deleted with adding still looking alive in most tests, which is why each is
// broken on purpose here and a test must go red for it. The colors that let
// the field's quieter lines be read are rules too, and are broken the same
// way.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-compose-s5-guards.js            # report
//   node test/tools/mutate-attachments-compose-s5-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws. The harness
// is the same shape as its siblings, deliberately a separate copy: pulling
// them together means editing instruments already in the gate. No row starts
// a server. Every row runs its whole suite, except a row that breaks the
// server's own check, which runs the one test that proves it (`only` below).

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const {
  beginMutationRun, targetsFromRows, rowsForShard, exitCodeFor, NO_VERDICT,
  runSuite, didNotFinishWhy, suiteOutput,
} = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The composer: the add, the paste, the drop and the hold.
const ADD = { src: path.join(ROOT, 'public', 'views', 'composer.js'), suite: 'test/unit/attachments-add.test.js' };
// The colors of the field's quieter lines, each against its own contrast test.
const CHAT_CSS = path.join(ROOT, 'public', 'styles', 'views', 'chat.css');
const PLACEHOLDER = { src: CHAT_CSS, suite: 'test/unit/composer-placeholder-contrast.test.js' };
const CHIP = { src: CHAT_CSS, suite: 'test/unit/attachment-chip-contrast.test.js' };
const MESSAGE = { src: CHAT_CSS, suite: 'test/unit/attachment-refusal-contrast.test.js' };
const DROP = { src: CHAT_CSS, suite: 'test/unit/composer-field-contrast.test.js' };
// The server's own check of each file's bytes on Send, whatever the page let
// through.
const DETECT = { src: path.join(ROOT, 'lib', 'attachments', 'detect.js'), suite: 'test/unit/attachments-add.test.js' };

// ONE NAMED TEST, FOR A ROW THAT BREAKS THE SERVER. A row that breaks the
// server's own check, rather than the composer, names the test that proves the
// server refuses what the page let through (`suite#test name`), and only that
// test runs, so its red is that test's alone. A name that matches nothing runs
// nothing, which turns nothing red and is reported as a failure.
const named = new Map();
function only(target, testName) {
  const suite = `${target.suite}#${testName}`;
  const key = `${target.src}\n${suite}`;
  if (!named.has(key)) named.set(key, { src: target.src, suite });
  return named.get(key);
}

const MUTATIONS = [
  // ===== ONE ADD, CHECKED IN ORDER =====
  [ADD, 'each file is checked by its own bytes',
    '    (buffer) => checkFile(new Uint8Array(buffer), file.name),',
    '    () => ({ type: \'text\' }),'],
  [ADD, 'the count takes the files already held',
    '  const count = composer.files.length + added.length;',
    '  const count = added.length;'],

  // ===== THE MESSAGES STACK UNTIL AN ADD ATTACHES =====
  [ADD, 'an add that attaches replaces the earlier messages',
    '  composer.notices = own.concat(heldPdfs(',
    '  composer.notices = composer.notices.concat(own, heldPdfs('],
  [ADD, 'an add that attaches none adds its messages to the earlier ones',
    '    composer.notices = composer.notices.concat(own);\n',
    '    composer.notices = own;\n'],

  // ===== PASTE =====
  [ADD, 'a pasted image\'s name counts up',
    "  return new File([file], highest ? `Pasted image ${highest + 1}` : 'Pasted image', { type: file.type });",
    "  return new File([file], 'Pasted image', { type: file.type });"],
  [ADD, 'a paste leaves its default, so text still goes into the field',
    "  if (files && files.length) addFiles(files, 'paste');",
    "  if (files && files.length) { event.preventDefault(); addFiles(files, 'paste'); }"],

  // ===== DROP =====
  [ADD, 'a file let go outside the conversation opens nothing',
    "  window.addEventListener('dragover', guardFileDrag);\n  window.addEventListener('drop', guardFileDrag);\n",
    ''],
  [ADD, 'the window guard takes only a drag of files',
    '  if (carriesFiles(event)) event.preventDefault();',
    '  event.preventDefault();'],

  // ===== THE CODEX HOLD =====
  [ADD, 'Send is not ready while a PDF is held for Codex',
    '  if (composer && (composer.waiting || composer.adds || sendHeld(activeConversation.id))) return false;',
    '  if (composer && (composer.waiting || composer.adds)) return false;'],
  [ADD, 'Send is off while a PDF is held for Codex',
    '  if (activeConversation) button.disabled = sendWaiting(activeConversation.id) || sendHeld(activeConversation.id);',
    '  if (activeConversation) button.disabled = sendWaiting(activeConversation.id);'],

  // ===== A NAME IS TEXT =====
  [ADD, 'a message\'s title shows its file\'s name as text',
    '  title.textContent = notice.title;',
    '  title.innerHTML = notice.title;'],

  // ===== WHAT THE PAGE LETS THROUGH IN ERROR, THE SERVER REFUSES =====
  [only(DETECT, 'with the composer\'s check made to pass, a HEIC photo is refused by the server\'s check on Send in the words the page gives it on add'),
    'the server refuses a HEIC photo as HEIC',
    "    throw refusal(HEIC_BRANDS.has(head(bytes, 8, 12)) ? 'heic' : 'unsupported', { name: label });",
    "    throw refusal('unsupported', { name: label });"],

  // ===== THE QUIETER LINES CAN BE READ =====
  [PLACEHOLDER, 'the field\'s placeholder clears 4.5:1',
    '.chat-input textarea::placeholder { color: var(--text-2-strong); }',
    '.chat-input textarea::placeholder { color: var(--text-2); }'],
  [CHIP, 'a chip\'s second line clears 4.5:1',
    '.composer-chip-meta { font-size: var(--label); color: var(--text-2-strong);',
    '.composer-chip-meta { font-size: var(--label); color: var(--text-2);'],
  [MESSAGE, 'a message\'s reason clears 4.5:1',
    '.composer-notice-text { color: var(--text-2-strong); }',
    '.composer-notice-text { color: var(--text-2); }'],
  [DROP, 'the drop\'s line of file types clears 4.5:1',
    '.composer-drop-msg span { font-size: var(--caption); color: var(--text-2-strong); }',
    '.composer-drop-msg span { font-size: var(--caption); color: var(--text-2); }'],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-compose-s5-harness-'));
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
