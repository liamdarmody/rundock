'use strict';
// A person's routine switches carried onto the author's new version of an
// agent: on or off, paused, where it runs, and the plan approval, matched by
// routine name and occurrence. What the author wrote is otherwise untouched,
// and a file the carry cannot address is a refusal, never a pass-through.

const { test, describe } = require('node:test');
const assert = require('node:assert');

const { routineStateOf, withRoutineState } = require('../../lib/packages/routine-carry.js');
const { parseRoutineBlocks, computePlanHash, normalizeRoutine, planApproved } = require('../../lib/agents/routines.js');

const agent = (routines, body = 'You scout.') => `---\nname: scout\nroutines:\n${routines}---\n\n${body}\n`;
const block = (name, prompt, extra = '') => `  - name: ${name}\n    schedule: every day at 08:00\n    prompt: ${prompt}\n${extra}`;
const blocksOf = (text) => parseRoutineBlocks(/^---\n([\s\S]*?)\n---/.exec(text)[1]);

const LIVE = agent(block('Morning briefing', 'Summarise.', '    enabled: true\n    planHash: xyz\n    paused: false\n    runOn: this-computer\n    planApprovedHash: abc\n    planApprovedAt: 2026-09-24T08:00:00.000Z\n')
  + block('Evening wrap', 'Wrap up.', '    enabled: false\n'));

describe('routineStateOf', () => {
  test('reads the carried fields of every routine, by name and occurrence', () => {
    assert.deepStrictEqual(routineStateOf(LIVE), [
      { name: 'Morning briefing', occurrence: 0, fields: { enabled: 'true', paused: 'false', runOn: 'this-computer', planApprovedHash: 'abc', planApprovedAt: '2026-09-24T08:00:00.000Z' } },
      { name: 'Evening wrap', occurrence: 0, fields: { enabled: 'false' } },
    ]);
  });
  test('an agent without routines has none', () => {
    assert.deepStrictEqual(routineStateOf('---\nname: scout\n---\n\nHi.\n'), []);
  });
});

describe('withRoutineState', () => {
  const incoming = agent(block('Morning briefing', 'Summarise the week.') + block('Brand new', 'New thing.'), 'You scout better.');

  test('the person\'s switches land on the author\'s routine of the same name, and nothing else changes', () => {
    const out = withRoutineState(incoming, routineStateOf(LIVE));
    const [morning, fresh] = blocksOf(out);
    assert.strictEqual(morning.enabled, 'true');
    assert.strictEqual(morning.runOn, 'this-computer');
    assert.strictEqual(morning.prompt, 'Summarise the week.', 'the author\'s instruction is kept');
    assert.ok(!('enabled' in fresh), 'a routine new in this version gets nothing it did not arrive with');
    assert.ok(out.endsWith('You scout better.\n'));
  });

  test('a changed instruction keeps the old approval, which no longer matches, so the next run asks', () => {
    const out = withRoutineState(incoming, routineStateOf(LIVE));
    const morning = normalizeRoutine(blocksOf(out)[0]);
    morning.planApprovedHash = computePlanHash(normalizeRoutine(blocksOf(LIVE)[0]));
    assert.strictEqual(planApproved(morning), false);
  });

  test('a routine the new version no longer has takes its state with it', () => {
    const out = withRoutineState(incoming, routineStateOf(LIVE));
    assert.ok(!out.includes('Evening wrap'));
  });

  test('no state to carry leaves the bytes exactly as the author wrote them', () => {
    assert.strictEqual(withRoutineState(incoming, []), incoming);
  });

  test('a file the carry cannot address, or a value that would split a line, is refused', () => {
    assert.throws(() => withRoutineState(incoming.replace(/\n/g, '\r\n'), routineStateOf(LIVE)), /cannot carry/);
    assert.throws(() => withRoutineState(incoming, [{ name: 'Morning briefing', occurrence: 0, fields: { enabled: 'true\nprompt: evil' } }]));
    assert.throws(() => withRoutineState(incoming, [{ name: 'Morning briefing', occurrence: 0, fields: { prompt: 'x' } }]), /not a routine switch/);
    // A value with space round it used to be written bare, read back trimmed,
    // and so refused here. The writer now quotes a value YAML would misread,
    // which is what lets it read back exactly as it was written: carried,
    // quoted, and equal.
    const spaced = withRoutineState(incoming, [{ name: 'Morning briefing', occurrence: 0, fields: { enabled: ' true' } }]);
    assert.ok(spaced.includes('    enabled: " true"'), 'the spaced value is written in quotes');
    assert.strictEqual(blocksOf(spaced)[0].enabled, ' true', 'and reads back as written');
    // A switch that still cannot land is refused, never written and passed.
    // A block that repeats the key is one: the writer changes the first line
    // and the reader keeps the last, so what was written does not read back.
    const repeated = agent(block('Morning briefing', 'Go.', '    enabled: false\n    enabled: false\n'));
    assert.throws(() => withRoutineState(repeated, [{ name: 'Morning briefing', occurrence: 0, fields: { enabled: 'true' } }]),
      /cannot carry "enabled" onto the routine "Morning briefing"/, 'a switch that did not land is a refusal');
  });
});
