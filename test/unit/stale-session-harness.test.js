'use strict';
// Every row of the stale-session mutation harness is read through one
// invocation of node --test. A fault in it, an option node refuses or output
// that no longer parses, would misreport every row at once, so the harness
// checks that invocation on a fixture before it mutates anything. These pin
// that check: the invocation reads a passing run as green and a failing one
// as red, by name, from inside a test as well as from a terminal; a real row's
// run is green with nothing mutated; and a misread is refused.
//
// Loading the harness is safe: it runs only under `require.main`.
const { test } = require('node:test');
const assert = require('node:assert');
const harness = require('../tools/mutate-stale-session-guards.js');

test('the harness\'s own invocation reads a passing test as green and a failing one as red, by name', async () => {
  assert.strictEqual(await harness.invocationProblem(), null);
});

// Read through the invocation the test above proves: on its own, a run that
// exits 0 with output this cannot read would look green here too.
test('a row\'s run is green with nothing mutated', async () => {
  const row = harness.MUTATIONS.find(([target]) => /(^|\/)child-stdin\.test\.js$/.test(target.suite));
  assert.ok(row, 'a row runs the stdin handler\'s unit suite');
  assert.deepStrictEqual(await harness.redTests(row[0].suite), [], `${row[0].suite} is green, read through the rows' own invocation`);
});

test('an invocation that misreads either result, or gives none, is refused', async () => {
  const answering = (green, red) => (suite) => (suite.endsWith('#passes with nothing broken') ? green : red);
  assert.strictEqual(await harness.invocationProblem(answering([], ['fails when broken'])), null, 'a correct read passes');
  assert.match(await harness.invocationProblem(answering(['passes with nothing broken'], ['fails when broken'])), /not green/,
    'a passing test read as red');
  assert.match(await harness.invocationProblem(answering({ unparsable: true }, ['fails when broken'])), /not green/,
    'a run with no verdict, as an option node refuses gives');
  assert.match(await harness.invocationProblem(answering([], [])), /not that test red/, 'a failing test read as green');
  assert.match(await harness.invocationProblem(answering([], { unparsable: true })), /not that test red/, 'a failing run with no verdict');
  assert.match(await harness.invocationProblem(answering([], ['some other test'])), /not that test red/, 'a failure read under the wrong name');
});
