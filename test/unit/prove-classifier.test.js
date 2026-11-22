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
  // Node trims a full name before comparing it, so a top-level `blocker `
  // is selected beside `blocker`. A nested one is not: its full name holds
  // its suite's name, and Node leaves it out of the report.
  'blocker-top': 'selected 2',
  'blocker-nested': 'assertion failed',
  // A real test can carry its file's path as its name, the name Node also
  // reports a file under when it selects nothing or fails to load.
  'path-named': 'passed',
  // A test named as its file whose process a signal ends before it reports
  // leaves only the file's own result, under that same name.
  'signal-ended': 'failed to load',
};

// The eight summary lines Node prints after the top-level plan, for TAP
// written by hand.
const summary = (counts) => ['tests', 'suites', 'pass', 'fail', 'cancelled', 'skipped', 'todo']
  .map((key) => `# ${key} ${counts[key] || 0}`)
  .concat('# duration_ms 1.5');

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
    'a duplicated type line': base.replace("  type: 'test'", "  type: 'test'\n  type: 'suite'"),
    'a subtest after the last test': `${base}    ok 1 - orphan\n`,
  };

  // One TAP document, strictly: each edit below is to a real capture, and
  // the ones that keep the plan and counts in step leave only the rule they
  // name to catch them.
  const block = base.slice(base.indexOf('not ok 1 - '), base.indexOf('\n1..1\n') + 1);
  const STRICT = {
    'a second version line': base.replace('# Subtest:', 'TAP version 13\n# Subtest:'),
    'a second document after the first': base + base,
    'a second top-level plan': base.replace('\n1..1\n', '\n1..1\n1..1\n'),
    'a 1..0 plan anywhere but directly after the version line': base.replace('# Subtest:', '# a comment\n1..0\n# Subtest:'),
    'a duplicated result, with the plan and counts raised to match': base
      .replace(block, block + block).replace('\n1..1\n', '\n1..2\n')
      .replace('\n# tests 1\n', '\n# tests 2\n').replace('\n# fail 1\n', '\n# fail 2\n'),
    'a renumbered result': tap('two-selected').replace('\nok 2 - ', '\nok 3 - '),
    'a renumbered result inside a test': tap('subtest-assertion-failure').replace('    not ok 1 - the inner check', '    not ok 2 - the inner check'),
    'an extra result line': base.replace('\n1..1\n', '\nok 2 - an extra result\n1..1\n'),
    'an extra result line, with the plan raised to match': base.replace('\n1..1\n', '\nok 2 - an extra result\n1..2\n'),
    'an extra result inside a suite, with its plan raised to match': tap('nested-by-full-name')
      .replace('\n    1..1\n', '\n    ok 2 - an extra result\n    1..2\n'),
    'a result inside a test with no plan for its level': tap('subtest-assertion-failure').replace('\n    1..1\n', '\n'),
    'an empty line outside a YAML block': base.replace('# Subtest:', '\n# Subtest:'),
    'a summary line missing': base.replace('\n# todo 0\n', '\n'),
    'a summary line twice': base.replace('\n# todo 0\n', '\n# todo 0\n# todo 0\n'),
    'a summary line only before the top-level plan': base.replace('\n# todo 0\n', '\n').replace('\n1..1\n', '\n# todo 0\n1..1\n'),
    'the duration twice': `${base}# duration_ms 1\n`,
    'a count written with a leading zero': base.replace('\n# tests 1\n', '\n# tests 01\n'),
    'a suite counted as a test': tap('nested-by-full-name').replace('\n# tests 1\n# suites 1\n', '\n# tests 2\n# suites 0\n'),
    'a timeout counted as a failure, where Node counts it cancelled': tap('timeout').replace('\n# fail 0\n# cancelled 1\n', '\n# fail 1\n# cancelled 0\n'),
    'a skipped test counted as a pass': tap('skipped').replace('\n# pass 0\n', '\n# pass 1\n').replace('\n# skipped 1\n', '\n# skipped 0\n'),
    'a todo test counted as a failure': tap('todo').replace('\n# fail 0\n', '\n# fail 1\n').replace('\n# todo 1\n', '\n# todo 0\n'),
  };
  for (const [key, from, to] of [['tests', 1, 2], ['suites', 0, 1], ['pass', 0, 1], ['fail', 1, 0], ['cancelled', 0, 1], ['skipped', 0, 1], ['todo', 0, 1]]) {
    STRICT[`the ${key} count changed`] = base.replace(`\n# ${key} ${from}\n`, `\n# ${key} ${to}\n`);
  }
  Object.assign(SHAPES, STRICT);

  test('the specimen itself reads', () => {
    assert.ok(base.endsWith('\n1..1\n# tests 1\n# suites 0\n# pass 0\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 58.120042\n'));
    assert.ok(parseTap(base), 'the unaltered capture parses');
    assert.strictEqual(outcome(base, name, file), 'assertion failed');
  });

  test('every capture parses strictly, its counts agreeing with its results', () => {
    for (const [slug] of CASES) assert.ok(parseTap(tap(slug)), slug);
    for (const slug of ['mixed-1', 'mixed-2', 'mixed-3']) assert.ok(parseTap(tap(slug)), slug);
  });

  test('a 1..0 plan directly after the version line is the form Node prints when nothing is selected', () => {
    const none = tap('none-selected');
    assert.ok(none.startsWith('TAP version 13\n1..0\n'));
    const { name: noName, file: noFile } = caseOf('none-selected');
    assert.strictEqual(outcome(none, noName, noFile), 'selected 0');
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
      ...summary({ tests: 3, pass: 3 }),
      '',
    ].join('\n');
    assert.strictEqual(outcome(text, 'a\nb', 'test/x.test.js'), 'selected 2');
  });

  // Top-level tests by printed name: each passes but the last, which fails
  // on an assertion.
  const failing = (printed) => [
    'TAP version 13',
    ...printed.flatMap((p, k) => (k + 1 < printed.length
      ? [`ok ${k + 1} - ${p}`, '  ---', "  type: 'test'", '  ...']
      : [`not ok ${k + 1} - ${p}`, '  ---', "  type: 'test'", "  failureType: 'testCodeFailure'", "  code: 'ERR_ASSERTION'", '  ...'])),
    `1..${printed.length}`,
    ...summary({ tests: printed.length, pass: printed.length - 1, fail: 1 }),
    '',
  ].join('\n');

  test('a full name that trims to the name is counted, with whitespace or a TAP whitespace escape at either end', () => {
    assert.strictEqual(outcome(failing(['blocker']), 'blocker', 'test/x.test.js'), 'assertion failed');
    // As printed: a space, U+00A0, U+2028, and the escapes for a tab, a
    // newline, a carriage return, a vertical tab and a form feed.
    for (const p of ['blocker ', ' blocker', ' blocker', 'blocker ', 'blocker\\\\t', '\\\\nblocker', 'blocker\\\\r\\\\v\\\\f', ' \\\\t blocker \\\\n ']) {
      assert.strictEqual(outcome(failing([p, 'blocker']), 'blocker', 'test/x.test.js'), 'selected 2', JSON.stringify(p));
    }
  });

  test('a full name with anything else at its ends is not counted', () => {
    // As printed: an escaped backspace, other words, and an escaped backslash.
    for (const p of ['blocker\\\\b', 'blocker x', 'x blocker', 'blocker\\\\', 'block er']) {
      assert.strictEqual(outcome(failing([p, 'blocker']), 'blocker', 'test/x.test.js'), 'assertion failed', JSON.stringify(p));
    }
  });

  test('a nested name that trims to the name is not counted, since its full name holds its suite', () => {
    const text = [
      'TAP version 13',
      '    ok 1 - blocker ',
      '      ---', "      type: 'test'", '      ...',
      '    1..1',
      'ok 1 - a suite',
      '  ---', "  type: 'suite'", '  ...',
      'not ok 2 - blocker',
      '  ---', "  type: 'test'", "  failureType: 'testCodeFailure'", "  code: 'ERR_ASSERTION'", '  ...',
      '1..2',
      ...summary({ tests: 2, suites: 1, pass: 1, fail: 1 }),
      '',
    ].join('\n');
    assert.strictEqual(outcome(text, 'blocker', 'test/x.test.js'), 'assertion failed');
  });

  test('a nested test is selected by its full name once trimmed', () => {
    const text = [
      'TAP version 13',
      '    not ok 1 - blocker\\\\t',
      '      ---', "      type: 'test'", "      failureType: 'testCodeFailure'", "      code: 'ERR_ASSERTION'", '      ...',
      '    1..1',
      'not ok 1 - a suite',
      '  ---', "  type: 'suite'", "  failureType: 'subtestsFailed'", "  code: 'ERR_TEST_FAILURE'", '  ...',
      '1..1',
      ...summary({ tests: 1, suites: 1, fail: 1 }),
      '',
    ].join('\n');
    assert.strictEqual(outcome(text, 'a suite blocker', 'test/x.test.js'), 'assertion failed');
    assert.strictEqual(outcome(text, 'blocker', 'test/x.test.js'), 'selected 0');
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
      ...summary({
        tests: 2,
        fail: directive ? 1 : 2,
        skipped: directive === ' # SKIP' ? 1 : 0,
        todo: directive === ' # TODO' ? 1 : 0,
      }),
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

  // Node reports a file that selects no test, or that ends with an exit code
  // or a signal before its tests report, as a top-level result named as the
  // file. Asked for a test with that same name, the classifier still tells
  // the file's own result from a test.
  test('a file that selected nothing is not the test, even when the test asked for is named as the file', () => {
    const { file } = caseOf('none-selected');
    assert.strictEqual(outcome(tap('none-selected'), file, file), 'selected 0');
  });

  test('a file that failed as it loaded is not the test, even when the test asked for is named as the file', () => {
    const { file } = caseOf('load-error');
    assert.strictEqual(outcome(tap('load-error'), file, file), 'failed to load');
  });

  test('a file ended by a signal is not the test, even when the test asked for is named as the file', () => {
    const { file, name } = caseOf('signal-ended');
    assert.strictEqual(name, file);
    assert.strictEqual(outcome(tap('signal-ended'), name, file), 'failed to load');
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
      ...summary({ tests: 2, fail: 2 }),
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
