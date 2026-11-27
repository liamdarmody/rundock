#!/usr/bin/env node
'use strict';
// Break each rule that showing a sent message's files depends on, in turn,
// and report which tests notice.
//
// The file route serves a stored file only as its record describes it, from
// the bytes the record check read. The history reply says which of the files
// its own messages name are there, for this conversation only. In the window,
// a person's bubble draws each attached-file line as its file, from what the
// server said of it, and an image or a PDF opens larger and closes back to
// the button that opened it. Each of those is a small rule that can be
// deleted with the files still looking right in most tests, which is why each
// is broken on purpose here and a test must go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-attachments-show-guards.js            # report
//   node test/tools/mutate-attachments-show-guards.js --markdown # the same, as a table
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

const SHOW = 'test/integration/attachments-show.test.js';
const SHOW_UNIT = 'test/unit/attachments-show.test.js';
// The file route, and the history reply's files.
const ROUTE = { src: path.join(ROOT, 'lib', 'http-router.js'), suite: SHOW };
const HISTORY = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'history.js'), suite: SHOW };
// The attached-file lines in a message's text, shared by the window and the server.
const LINES = { src: path.join(ROOT, 'public', 'attachment-lines.js'), suite: 'test/unit/attachment-lines.test.js' };
// The bubble's files, what the page knows of them, and the open file.
const PAGE = { src: path.join(ROOT, 'public', 'sent-files.js'), suite: SHOW_UNIT };
// Where the history reply is drawn.
const CHAT = { src: path.join(ROOT, 'public', 'views', 'chat.js'), suite: SHOW_UNIT };
// The files pane's viewers, which the open file mounts.
const VIEWERS = { src: path.join(ROOT, 'public', 'viewers', 'registry.js'), suite: 'test/unit/viewers-registry.test.js' };

// ONE NAMED TEST, FOR A ROW WHOSE SUITE STARTS A SERVER. The show suite
// starts a server, and a broken guard can leave its tests waiting out their
// timeouts, so a row that ran all of it would cost minutes. Such a row names
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
  // ===== THE ROUTE SERVES A STORED FILE ONLY AS ITS RECORD DESCRIBES IT =====
  [only(ROUTE, 'the bytes served are the ones the record check read, never read again by path'),
    'the route reads the file by path after the record check',
    '    res.end(answer.bytes);\n',
    '    fs.createReadStream(path.join(getWorkspace(), ...segments)).pipe(res);\n'],
  [only(ROUTE, 'a stored PNG rewritten at the same size with other bytes is refused'),
    'the folder rule is skipped, so a stored file is served by path',
    '    if (stored) { serveStoredFile(res, stored, inside); return; }\n',
    ''],
  [only(ROUTE, 'the folder spelled in other case is refused for a rewritten file'),
    'the segment compare tells case apart',
    'segment.toLowerCase() === name',
    'segment === name'],
  [only(ROUTE, 'a stored PNG the record gives as a pdf is refused'),
    'the type compare is skipped',
    "answer.state === 'present' && answer.described.type === name[1]",
    "answer.state === 'present'"],

  // ===== THE HISTORY SAYS ONLY WHICH OF ITS OWN NAMED FILES ARE THERE =====
  [only(HISTORY, 'a file of the record that no message names gives no key'),
    'the map is built from every file of the record',
    '      files[line.file] = recordedFile(conversationId, line.file);\n    }\n  }\n  return files;\n',
    '      files[line.file] = recordedFile(conversationId, line.file);\n    }\n  }\n'
      + '  for (const message of store.readRecord(getWorkspace(), conversationId).messages) {\n'
      + '    for (const f of message.files) if (!Object.hasOwn(files, f.file)) files[f.file] = recordedFile(conversationId, f.file);\n'
      + '  }\n'
      + '  return files;\n'],
  [only(HISTORY, "a line naming another conversation's present file gives no key"),
    'the map takes a line naming another conversation',
    "line.kind !== 'attached' || line.id !== conversationId || Object.hasOwn",
    "line.kind !== 'attached' || Object.hasOwn"],

  // ===== A LINE IS FOUND ONLY WHOLE, AND TAKES ONE BREAK WITH IT =====
  [LINES, 'the stripper removes the breaks on both sides of a line',
    'if (file) { files.push(file); continue; }',
    'if (file) { files.push(file); first = true; continue; }'],
  [LINES, 'the stripper finds a line inside a sentence',
    'const whole = (core) => new RegExp(`^${core}$`);',
    'const whole = (core) => new RegExp(core);'],

  // ===== THE BUBBLE DRAWS EACH FILE FROM WHAT THE SERVER SAID OF IT =====
  [PAGE, 'changed draws as present',
    "if (!entry || entry.state !== 'present' || entry.type !== ext)",
    "if (!entry || (entry.state !== 'present' && entry.state !== 'changed') || entry.type !== ext)"],
  [PAGE, 'the fit lets a small image grow',
    'Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height, 1)',
    'Math.min(THUMB_WIDTH / width, THUMB_HEIGHT / height)'],
  [PAGE, 'a name is set through innerHTML',
    "const n = el('span', 'att-name');\n    n.textContent = name;",
    "const n = el('span', 'att-name');\n    n.innerHTML = name;"],
  [PAGE, 'a line naming another conversation is looked up in the map',
    "line.kind === 'attached' && line.id === conversationId ? api.entryFor(conversationId, line.file) : null",
    "line.kind === 'attached' ? api.entryFor(line.id, line.file) : null"],
  [CHAT, "renderSessionHistory doesn't merge a reply's files",
    "  if (typeof RundockSentFiles !== 'undefined') RundockSentFiles.mergeSentFiles(d.conversationId, d.files);\n",
    ''],

  // ===== AN OPEN FILE CLOSES BACK TO ITS BUTTON, AND ITS IMAGE IS NAMED =====
  [PAGE, "focus isn't put back on close",
    '    if (opener.isConnected) opener.focus();\n',
    ''],
  [VIEWERS, 'mountImageViewer ignores alt',
    '  img.alt = alt || path;',
    '  img.alt = path;'],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'attachments-show-harness-'));
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
