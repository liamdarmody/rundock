'use strict';
// The prove workflow's classifier, run on TAP captured from real runs.
//
// Each job runs one blocker test three times. A run gives an outcome; the
// three outcomes give the job's verdict for its side. On the blocked head
// (red) and on a breakage (break) every run must fail on an assertion. On
// the fix head (green) every run must pass. A run that selects no test, or
// more than one, fails the step that runs the test, on every side.
//
// The TAP was taken by test/fixtures/prove/capture.js, which runs a test the
// way the workflow does. The classifier is cut out of the workflow itself,
// so these tests run the code the workflow runs.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { loadPiece } = require('../helpers/prove-workflow.js');
const { CASES } = require('../fixtures/prove/capture.js');

const { tapName, parseTap, outcome, verdict, selectionProblem } =
  loadPiece('classifier', ['tapName', 'parseTap', 'outcome', 'verdict', 'selectionProblem']);

const DIR = path.join(__dirname, '..', 'fixtures', 'prove');
const tap = (slug) => fs.readFileSync(path.join(DIR, 'tap', `${slug}.tap`), 'utf8');
const caseOf = (slug) => {
  const found = CASES.filter(([s]) => s === slug);
  assert.strictEqual(found.length, 1, `the capture script takes ${slug} once`);
  const [, file, name] = found[0];
  return { file: `test/fixtures/prove/${file}`, name };
};
const outcomeOf = (slug) => {
  const { file, name } = caseOf(slug);
  return outcome(tap(slug), name, file);
};

// What each captured run must classify as.
const EXPECTED = {
  'assertion-failure': 'assertion failed',
  'subtest-assertion-failure': 'assertion failed',
  'nested-by-full-name': 'assertion failed',
  'load-error': 'failed to load',
  'non-assertion-error': 'failed on something else',
  'missing-module': 'failed on something else',
  'timeout': 'failed on something else',
  'pass': 'passed',
  'awkward-name': 'passed',
  'skipped': 'skipped',
  'todo': 'todo',
  'none-selected': 'selected 0',
  'two-selected': 'selected 2',
};

// Which sides accept an outcome on all three runs.
const ACCEPTS = {
  'assertion failed': ['red', 'break'],
  'passed': ['green'],
};

describe('one run of a captured test', () => {
  test('every captured case has an expected outcome, and every expected outcome a capture', () => {
    assert.deepStrictEqual(CASES.map(([s]) => s).sort(), Object.keys(EXPECTED).sort());
  });

  for (const [slug, want] of Object.entries(EXPECTED)) {
    test(`${slug} classifies as "${want}"`, () => {
      assert.strictEqual(outcomeOf(slug), want);
    });
  }
});

describe('three runs of the same captured test, on each side', () => {
  for (const [slug, want] of Object.entries(EXPECTED)) {
    test(`${slug} three times`, () => {
      const outcomes = [want, want, want].map(() => outcomeOf(slug));
      const selecting = want.startsWith('selected ');
      const problem = selectionProblem(outcomes);
      if (selecting) {
        assert.ok(problem && problem.includes('run 1'), `the run step fails on ${want}: ${problem}`);
      } else {
        assert.strictEqual(problem, null, 'one test was selected, so the run step passes');
      }
      for (const side of ['red', 'green', 'break']) {
        const accepted = !selecting && (ACCEPTS[want] || []).includes(side);
        const why = verdict(side, outcomes);
        if (accepted) assert.strictEqual(why, null, `${side} accepts ${want}`);
        else assert.ok(why && why.includes('run 1'), `${side} refuses ${want}, naming the run: ${why}`);
      }
    });
  }
});

describe('a test that passes once and fails twice', () => {
  const file = 'test/fixtures/prove/varies.js';
  const name = 'the result varies between runs';
  const outcomes = ['mixed-1', 'mixed-2', 'mixed-3'].map((slug) => outcome(tap(slug), name, file));

  test('the captures are one pass and two assertion failures', () => {
    assert.deepStrictEqual(outcomes, ['passed', 'assertion failed', 'assertion failed']);
  });

  test('red and break refuse it, naming the run that passed', () => {
    for (const side of ['red', 'break']) {
      const why = verdict(side, outcomes);
      assert.ok(why && why.includes('run 1') && why.includes('passed'), why);
    }
  });

  test('green refuses it, naming the first run that failed', () => {
    const why = verdict('green', outcomes);
    assert.ok(why && why.includes('run 2') && why.includes('assertion failed'), why);
  });

  test('the order of the runs does not change the verdict, only the run named', () => {
    const why = verdict('red', ['assertion failed', 'assertion failed', 'passed']);
    assert.ok(why && why.includes('run 3'), why);
  });
});

describe('TAP the classifier cannot read is refused', () => {
  const base = tap('assertion-failure');
  const { name, file } = caseOf('assertion-failure');
  const lines = base.split('\n');
  const SHAPES = {
    'nothing at all': '',
    'no version line': lines.slice(1).join('\n'),
    'the final plan cut off': base.slice(0, base.lastIndexOf('1..1')),
    'a plan that disagrees with the results': base.replace(/\n1\.\.1\n/, '\n1..2\n'),
    'a line that is not TAP': base.replace('# Subtest:', 'stray output\n# Subtest:'),
    'a YAML block never closed': lines.filter((l) => l !== '  ...').join('\n'),
    'a result indented off the grid': base.replace('not ok 1 -', '  not ok 1 -'),
    'a duplicated code line': base.replace("  code: 'ERR_ASSERTION'", "  code: 'ERR_ASSERTION'\n  code: 'ERR_ASSERTION'"),
    'a subtest after the last test': `${base}    ok 1 - orphan\n`,
  };

  test('the specimen itself reads', () => {
    assert.ok(parseTap(base), 'the unaltered capture parses');
    assert.strictEqual(outcome(base, name, file), 'assertion failed');
  });

  for (const [shape, text] of Object.entries(SHAPES)) {
    test(`${shape}: unparseable, and refused on every side`, () => {
      assert.notStrictEqual(text, base, 'the specimen was altered');
      assert.strictEqual(parseTap(text), null);
      const o = outcome(text, name, file);
      assert.strictEqual(o, 'unparseable');
      assert.strictEqual(selectionProblem([o, o, o]), null);
      for (const side of ['red', 'green', 'break']) assert.ok(verdict(side, [o, o, o]));
    });
  }
});

describe('names, selection and the shape of a verdict', () => {
  test('a name is compared the way the TAP reporter escapes it', () => {
    assert.strictEqual(tapName('a name with # and \\ in it passes'), 'a name with \\# and \\\\ in it passes');
    // A control character becomes a backslash and a letter first, and that
    // backslash is then doubled with every other one.
    assert.strictEqual(tapName('tab\there, line\nthere'), 'tab\\\\there, line\\\\nthere');
  });

  test('two names the reporter escapes alike select both, and fail closed', () => {
    // A newline and a backslash followed by n print the same. A test whose
    // subtests collide that way must not pass as one selected test.
    const text = [
      'TAP version 13',
      '    ok 1 - a\\\\nb',
      '    ok 2 - a\\\\nb',
      '    1..2',
      'ok 1 - parent',
      '1..1',
      '',
    ].join('\n');
    assert.strictEqual(outcome(text, 'a\nb', 'test/x.test.js'), 'selected 2');
  });

  test('a skip or todo on an enclosing suite or a subtest counts against the test', () => {
    const suite = (directive) => [
      'TAP version 13',
      `    not ok 1 - inner${directive}`,
      '      ---',
      "      failureType: 'testCodeFailure'",
      "      code: 'ERR_ASSERTION'",
      '      ...',
      '    1..1',
      'not ok 1 - outer',
      '  ---',
      "  failureType: 'subtestsFailed'",
      "  code: 'ERR_TEST_FAILURE'",
      '  ...',
      '1..1',
      '',
    ].join('\n');
    assert.strictEqual(outcome(suite(''), 'outer', 'test/x.test.js'), 'assertion failed');
    assert.strictEqual(outcome(suite(' # TODO'), 'outer', 'test/x.test.js'), 'todo');
    assert.strictEqual(outcome(suite(' # SKIP'), 'outer inner', 'test/x.test.js'), 'skipped');
  });

  test('an assertion code outside test code, such as in a hook, is not an assertion failure', () => {
    const text = tap('assertion-failure').replace("failureType: 'testCodeFailure'", "failureType: 'hookFailure'");
    const { name, file } = caseOf('assertion-failure');
    assert.strictEqual(outcome(text, name, file), 'failed on something else');
  });

  test('a failure outside the selected test is refused', () => {
    const text = [
      'TAP version 13',
      'not ok 1 - the selected test',
      '  ---',
      "  failureType: 'testCodeFailure'",
      "  code: 'ERR_ASSERTION'",
      '  ...',
      'not ok 2 - test/x.test.js',
      '  ---',
      "  failureType: 'testCodeFailure'",
      "  code: 'ERR_TEST_FAILURE'",
      '  ...',
      '1..2',
      '',
    ].join('\n');
    assert.strictEqual(outcome(text, 'the selected test', 'test/x.test.js'), 'failed outside the test');
  });

  test('a verdict wants exactly three runs and a known side', () => {
    assert.ok(verdict('red', ['assertion failed', 'assertion failed']));
    assert.ok(verdict('red', ['assertion failed', 'assertion failed', 'assertion failed', 'assertion failed']));
    assert.ok(verdict('blue', ['passed', 'passed', 'passed']));
    assert.strictEqual(verdict('green', ['passed', 'passed', 'passed']), null);
  });
});
