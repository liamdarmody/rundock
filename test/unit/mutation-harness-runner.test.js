'use strict';
// Every mutation harness starts a row's suite through the one runner in
// test/tools/mutation-run.js, and reports a row whose suite did not finish as
// its own outcome.
//
// WHY AN INVENTORY. The runner's limit, its ending of the whole process group
// and its restore on a signal hold only for suites it starts. A harness that
// went back to starting its own suite, with a synchronous call and no limit,
// would bring back the run that waited six hours with a mutation in the
// source, and nothing else would notice until a row hung. So every harness is
// read here, and held to four things:
//
// - it starts no process itself and loads no child_process;
// - it takes runSuite from the runner and awaits it, and sets no limit of its
//   own;
// - its run waits for each row, so a row's result is never a pending promise;
// - a row whose suite did not finish is carried from its redTests, through
//   the push site in its run, to its report as "did not finish", by its own
//   code, never as caught and never as survived.
//
// The last is driven rather than read: each harness's own redTests, push site
// and report are cut out and run against a runner that says the suite did not
// finish, the way the parsing tests in sdlc-gate-hardening drive a refusal.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { didNotFinishWhy, exitCodeFor, NO_VERDICT } = require('../tools/mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
const TOOLS = path.join(ROOT, 'test', 'tools');
const HARNESS_FILES = fs.readdirSync(TOOLS).filter((n) => /^mutate-.*\.js$/.test(n)).sort();

// The ranges of a JavaScript source that are not code: comments, string
// literals, the text of template literals, and regular expression literals.
// The harnesses carry source text in their rows, some of it naming the very
// calls this looks for, so a match inside a literal is not a call.
//
// A regular expression is told from a division by what precedes it, the rule
// tokenizers use: an operator, an opening bracket or one of a few keywords
// before a `/` means an expression is starting.
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'instanceof', 'yield', 'await']);
function literalRanges(src) {
  const ranges = [];
  const templates = [];
  let depth = 0;
  let prev = '';
  let word = '';
  let i = 0;
  const n = src.length;
  // The text of a template literal from `from`, the opening backtick or the
  // brace closing an interpolation, to its end or its next interpolation.
  const templateText = (from) => {
    let j = from + 1;
    while (j < n) {
      if (src[j] === '\\') { j += 2; continue; }
      if (src[j] === '`') { ranges.push([from, j + 1]); prev = '`'; word = ''; return j + 1; }
      if (src[j] === '$' && src[j + 1] === '{') { ranges.push([from, j]); templates.push(depth); prev = '{'; word = ''; return j + 2; }
      j++;
    }
    ranges.push([from, n]);
    return n;
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const end = e === -1 ? n : e; ranges.push([i, end]); i = end; continue; }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const end = e === -1 ? n : e + 2; ranges.push([i, end]); i = end; continue; }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1;
      ranges.push([i, j + 1]);
      i = j + 1; prev = c; word = '';
      continue;
    }
    if (c === '`') { i = templateText(i); continue; }
    if (c === '/' && (!prev || '(,=:[!&|?{};+-*%<>~^'.includes(prev) || REGEX_AFTER_WORD.has(word))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j])) j++;
      ranges.push([i, j]);
      i = j; prev = '/'; word = '';
      continue;
    }
    if (c === '}' && templates.length && templates[templates.length - 1] === depth) {
      templates.pop();
      i = templateText(i);
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    if (/\s/.test(c)) { i++; continue; }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i;
      while (j < n && /[\w$]/.test(src[j])) j++;
      word = src.slice(i, j); prev = 'a';
      i = j;
      continue;
    }
    prev = c; word = '';
    i++;
  }
  return ranges;
}
/** Every match of `re` in `src` that starts in code rather than in a literal or comment. */
function inCode(src, re, ranges) {
  const out = [];
  for (const m of src.matchAll(re)) {
    if (!ranges.some(([a, b]) => m.index >= a && m.index < b)) out.push(m);
  }
  return out;
}

/** A body cut out of a harness by `re`, found exactly once. */
function cut(name, src, re, what) {
  const all = [...src.matchAll(new RegExp(re.source, 'g'))];
  assert.strictEqual(all.length, 1, `${name}: ${what} could not be cut out exactly once (${all.length} found); update this extraction with the new shape`);
  return all[0][0];
}

// A suite that did not finish, as the runner reports one. What it printed
// before it was ended includes a failing test, so a harness that read the
// output anyway would count the row as caught.
const LIMIT_SECONDS = 300;
function didNotFinish() {
  return Object.assign(new Error(`the suite did not finish in ${LIMIT_SECONDS} s`), {
    didNotFinish: LIMIT_SECONDS,
    status: null,
    signal: null,
    stdout: 'failing tests:\n\n✖ a test that was still running when the suite was ended (1.5ms)\n',
    stderr: '',
  });
}

describe('every mutation harness starts a row\'s suite through the runner', () => {
  test('the inventory finds every harness', () => {
    assert.ok(HARNESS_FILES.length >= 35, `only ${HARNESS_FILES.length} harnesses found`);
  });

  test('the literal reader tells a call in code from the same text inside a row', () => {
    const sample = [
      "const { runSuite } = require('./mutation-run.js');",
      "const ROWS = [['x', \"require('child_process').spawn('open', [f]);\", `execFileSync(${'a'})`]];",
      '// execSync(cmd) in a comment',
      'const re = /spawn\\(/; const half = 4 / 2;',
      'async function redTests(suite) { const out = await runSuite(\'node\', [suite]); return out; }',
      "function bad() { return require('node:child_process').execFileSync('node', []); }",
    ].join('\n');
    const ranges = literalRanges(sample);
    assert.deepStrictEqual(inCode(sample, /\b(?:execFileSync|spawnSync|execSync|spawn)\s*\(/g, ranges).map((m) => m[0]), ['execFileSync('],
      'only the call made in code is found');
    assert.strictEqual(inCode(sample, /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/g, ranges).length, 1);
    assert.strictEqual(inCode(sample, /\bawait\s+runSuite\s*\(/g, ranges).length, 1);
  });

  for (const name of HARNESS_FILES) {
    test(`${name} starts its suites through the runner, and through nothing else`, () => {
      const src = fs.readFileSync(path.join(TOOLS, name), 'utf8');
      const ranges = literalRanges(src);
      // The reader kept its place across the whole file: the entry point and
      // the exports are found as code. A reader that lost its place would
      // swallow code as text and could hide a call this exists to find.
      for (const [what, re] of [
        ['the redTests function', /\bfunction\s+redTests\s*\(/g],
        ['the entry point', /if \(require\.main === module\) \{/g],
        ['the exports', /\bmodule\.exports\s*=/g],
      ]) {
        assert.strictEqual(inCode(src, re, ranges).length, 1, `${name}: ${what} is not read as code exactly once`);
      }

      const calls = inCode(src, /\b(?:execFileSync|spawnSync|execSync|spawn)\s*\(/g, ranges);
      assert.deepStrictEqual(calls.map((m) => m[0]), [], `${name} starts a process itself`);
      assert.deepStrictEqual(inCode(src, /require\s*\(\s*['"](?:node:)?child_process['"]\s*\)/g, ranges).map((m) => m[0]), [],
        `${name} loads child_process`);
      assert.ok(/\{[^}]*\brunSuite\b[^}]*\}\s*=\s*require\('\.\/mutation-run\.js'\)/.test(src), `${name} does not take runSuite from the runner`);
      assert.ok(inCode(src, /\bawait\s+runSuite\s*\(/g, ranges).length >= 1, `${name} never starts a suite through runSuite`);
      // ONE LIMIT FOR EVERY ROW, the runner's: no harness sets its own.
      assert.deepStrictEqual(inCode(src, /\b(?:timeout|killSignal|limitMs|graceMs)\s*:/g, ranges).map((m) => m[0]), [],
        `${name} sets a limit of its own`);

      // EVERY ROW IS WAITED FOR. An un-awaited redTests hands its run a
      // promise, which has neither a refusal nor a list of red tests, and an
      // un-awaited run hands its report a promise to iterate.
      for (const m of inCode(src, /(?<![.\w$])(redTests|runTests|invocationProblem|run)\(/g, ranges)) {
        const before = src.slice(Math.max(0, m.index - 16), m.index);
        if (/function\s+$/.test(before)) continue;
        const waited = /(?:await|return)\s+$/.test(before) || /^\w+\([^()]*\)\.then\(/.test(src.slice(m.index));
        const line = src.slice(0, m.index).split('\n').length;
        assert.ok(waited, `${name}:${line}: ${m[1]}() is neither awaited nor chained, so what it returns is a pending promise`);
      }
    });

    test(`${name} reports a row whose suite did not finish as did not finish, through its own code`, async () => {
      const src = fs.readFileSync(path.join(TOOLS, name), 'utf8');

      // Its redTests, with the runner saying the suite did not finish: the
      // node:test path, and the desktop app's path where a harness has one.
      const redTests = cut(name, src, /async function redTests\((?:suite)?\) \{[\s\S]*?\n\}/, 'redTests');
      const build = new Function('runSuite', 'REPORTER', 'ROOT', 'SUITE', `${redTests}; return redTests;`);
      let started = 0;
      const red = build(() => { started++; throw didNotFinish(); }, [], ROOT, 'stub-suite');
      for (const suite of ['stub-suite', 'test/electron/stub.cjs']) {
        assert.deepStrictEqual(await red(suite), { didNotFinish: LIMIT_SECONDS },
          `${name}: a suite that did not finish (${suite}) must come back as did not finish, never read for red tests`);
      }
      assert.strictEqual(started, 2, `${name}: redTests did not start its suite through the runner it was given`);

      // Its run's push site, given that result.
      const push = cut(name, src, /if \(red && red\.didNotFinish\) results\.push\([\s\S]*?\);/, 'the push site for a suite that did not finish');
      const row = new Function('red', 'label', 'matches', 'target',
        `const rows = []; const results = { push: (r) => rows.push(r) }; ${push}; return rows[0];`)(
        { didNotFinish: LIMIT_SECONDS }, 'probe-mutation', 1, { suite: 'stub-suite' });
      assert.strictEqual(row && row.label, 'probe-mutation', `${name}: run() dropped the label of a row that did not finish`);
      assert.strictEqual(row.didNotFinish, LIMIT_SECONDS, `${name}: run() dropped the limit the row ran out of`);
      assert.ok(!row.unparsable && (!row.red || row.red.length === 0), `${name}: a row that did not finish is recorded as something else`);
      assert.strictEqual(exitCodeFor(1, [row]), NO_VERDICT, `${name}: a run whose only failure did not finish must exit as no verdict`);

      // Its report, in both shapes.
      const report = cut(name, src, /function report\(results, markdown\) \{[\s\S]*?\n\}/, 'report');
      for (const markdown of [true, false]) {
        const said = [];
        const fakeConsole = { log: (line) => said.push(String(line)), error: (line) => said.push(String(line)) };
        const failures = new Function('console', 'NOT_MUTATED', 'didNotFinishWhy', `${report}; return report;`)(
          fakeConsole, [], didNotFinishWhy)([row], markdown);
        const out = said.join('\n');
        const shape = markdown ? 'markdown' : 'plain';
        assert.ok(out.includes('probe-mutation'), `${name}: the ${shape} report does not name the row that did not finish`);
        assert.match(out, new RegExp(`did not finish in ${LIMIT_SECONDS} s`, 'i'), `${name}: the ${shape} report does not say the suite did not finish`);
        assert.match(out, /no verdict/i, `${name}: the ${shape} report must say no verdict was reached`);
        assert.doesNotMatch(out, /nothing turned red|could not be parsed/i, `${name}: the ${shape} report reads the row as survived or unreadable`);
        assert.ok(failures >= 1, `${name}: a row that did not finish must count as a failure`);
      }
    });
  }
});
