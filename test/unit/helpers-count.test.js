'use strict';
// THE RUNNING COUNT: HOW MANY HELPERS A LEAD HAS WORKING AT ONCE.
//
// Each helper a lead starts gets a row: a call answered allow counts from its
// answer, Claude Code's task_* lines say when each helper starts, what it is
// doing and how it ended, and the count is the rows still running. Every
// change sends the lead's rows to the page as helpers_changed.
//
// The team: Wren leads; Ash and Rowan (agent name example-research-lead)
// report to Wren.
const { test, describe, before, after, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { _internal: srv } = require('../../server.js');
const { makeWorkspace, agentFile, cleanup } = require('../helpers/workspace.js');
const fx = require('../fixtures/stream-json.js');

const HELPERS = path.join(__dirname, '..', '..', 'lib', 'delegation', 'helpers.js');
// Asserted before the module is required, so a missing module fails here on
// an assertion instead of throwing from require.
function helpers() {
  assert.ok(fs.existsSync(HELPERS), 'lib/delegation/helpers.js exists');
  return require(HELPERS);
}
// Each name this file uses is asserted first, so a module without it fails on
// that assertion, never on a call that throws.
function names(...wanted) {
  const m = helpers();
  for (const name of wanted) assert.strictEqual(typeof m[name], 'function', `helpers.${name} is exported`);
  return m;
}

const team = {
  wren: agentFile({ name: 'wren', displayName: 'Wren', role: 'Lead', order: 1 }),
  ash: agentFile({ name: 'ash', displayName: 'Ash', order: 2, reportsTo: 'wren' }),
  'example-research-lead': agentFile({ name: 'example-research-lead', displayName: 'Rowan', order: 3, reportsTo: 'wren' }),
};

let sent = [];
let prevDeps = null;
before(() => {
  srv.setWorkspace(makeWorkspace({ agents: team }));
  if (fs.existsSync(HELPERS)) {
    const m = require(HELPERS);
    m.HELPERS_ENABLED = true;
    prevDeps = m.wireHelpersDeps({ safeSend: (s) => sent.push(JSON.parse(s)) });
  }
});
afterEach(() => { sent = []; });
after(() => {
  if (fs.existsSync(HELPERS)) {
    const m = require(HELPERS);
    m.HELPERS_ENABLED = false;
    if (prevDeps) m.wireHelpersDeps(prevDeps);
  }
  cleanup();
});

let n = 0;
const freshConvo = () => String(1764000000000 + (++n));
const lead = { agentId: 'wren', process: null };
const changes = (convo) => sent.filter((m) => m.type === 'helpers_changed' && m._conversationId === convo);
const lastRows = (convo) => { const all = changes(convo); return all.length ? all[all.length - 1].helpers : []; };

// One lead message with these calls, each answered through the hook. Built-in
// helpers start with no card. Returns the answers in call order.
async function allowed(convo, calls) {
  const m = names('runningCount', 'helperRows');
  m.placeMessage(convo, lead, calls);
  return Promise.all(calls.map((c) => m.answerAgentRequest({ convoId: convo, askedBy: 'wren', data: { tool_use_id: c.id, tool_input: c.input } })));
}
const explore = (id, description = 'Look around', prompt = 'Find the config.') => ({ id, input: { subagent_type: 'Explore', description, prompt } });
const line = (convo, parsed) => names('readTaskLine').readTaskLine(convo, lead, parsed);

describe('the task each row is shown with', () => {
  test('a row\'s task collapses whitespace runs to one space', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1', '  Read\n\tthe   notes  ')]);
    assert.strictEqual(helpers().helperRows(convo)[0].task, 'Read the notes');
  });

  test('a row\'s task is cut at a word to eighty characters, the closing mark included', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1', 'word '.repeat(20).trim())]);
    const task = helpers().helperRows(convo)[0].task;
    assert.strictEqual(task, `${'word '.repeat(16).trim()}…`);
    assert.ok(task.length <= 80, `${task.length}`);
  });

  test('a row with an empty description takes the brief\'s first non-empty line, cut the same way', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1', '  ', '\n \n  Read the   notes\nThen write.'), explore('t2', '', `\n${'line '.repeat(30)}`)]);
    assert.deepStrictEqual(helpers().helperRows(convo).map((r) => r.task), ['Read the notes', `${'line '.repeat(16).trim()}…`]);
  });

  test('a row whose description is one word longer than the limit is cut at seventy-nine characters', async () => {
    const convo = freshConvo();
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', description: 'y'.repeat(120), subagentType: 'Explore' }));
    assert.strictEqual(helpers().helperRows(convo)[0].task, `${'y'.repeat(79)}…`);
  });

  test('a description worded as a handoff is only the task: the row\'s state comes from task lines alone', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1', 'Handing you over to Ash now')]);
    let row = helpers().helperRows(convo)[0];
    assert.deepStrictEqual([row.task, row.state, row.agent, row.kind], ['Handing you over to Ash now', 'running', 'Explore', 'builtin']);
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 't1', description: 'Handing you over to Ash now', subagentType: 'Explore' }));
    assert.strictEqual(helpers().helperRows(convo)[0].state, 'running', 'still running');
    line(convo, fx.taskNotification({ taskId: 'k1', toolUseId: 't1', status: 'completed', summary: 'Handing you over to Ash now' }));
    row = helpers().helperRows(convo)[0];
    assert.deepStrictEqual([row.task, row.state], ['Handing you over to Ash now', 'completed']);
  });
});

describe('the count, read from the lead\'s task lines', () => {
  test('a call answered allow counts from its answer, before its task_started arrives', async () => {
    const convo = freshConvo();
    assert.deepStrictEqual(await allowed(convo, [explore('t1'), explore('t2')]), [{ allow: true }, { allow: true }]);
    assert.strictEqual(helpers().runningCount(convo), 2);
  });

  test('task_started links the task to its call, which then runs as one helper', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1')]);
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 't1', description: 'Look around', subagentType: 'Explore' }));
    assert.strictEqual(helpers().runningCount(convo), 1, 'one helper, not two');
    line(convo, fx.taskUpdated('k1', 'completed'));
    assert.strictEqual(helpers().runningCount(convo), 0, 'the task id alone finds its call');
    assert.strictEqual(helpers().helperRows(convo)[0].state, 'completed');
  });

  test('a task_started whose call is not known is counted all the same', () => {
    const convo = freshConvo();
    assert.strictEqual(line(convo, fx.taskStarted({ taskId: 'k9', toolUseId: 'toolu_unknown', description: 'Plan it', subagentType: 'Plan' })), true);
    assert.strictEqual(helpers().runningCount(convo), 1);
    assert.deepStrictEqual(helpers().helperRows(convo)[0], { toolUseId: 'toolu_unknown', agent: 'Plan', kind: 'builtin', task: 'Plan it', state: 'running', step: null });
  });

  test('a task_started naming a teammate gives a teammate row', () => {
    const convo = freshConvo();
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', description: 'Draft it', subagentType: 'ash' }));
    const row = helpers().helperRows(convo)[0];
    assert.deepStrictEqual([row.agent, row.kind], ['ash', 'teammate']);
  });

  test('task_progress sets the row\'s step and leaves the count', () => {
    const convo = freshConvo();
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', description: 'Look', subagentType: 'Explore' }));
    line(convo, fx.taskProgress({ taskId: 'k1', toolUseId: 'u1', lastToolName: 'Grep' }));
    assert.strictEqual(helpers().helperRows(convo)[0].step, 'Grep');
    assert.strictEqual(helpers().runningCount(convo), 1);
  });

  for (const status of ['completed', 'killed', 'failed']) {
    test(`task_updated with status ${status} sets the row ${status} and lowers the count`, () => {
      const convo = freshConvo();
      line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
      line(convo, fx.taskStarted({ taskId: 'k2', toolUseId: 'u2', subagentType: 'Explore' }));
      line(convo, fx.taskUpdated('k1', status));
      assert.strictEqual(helpers().runningCount(convo), 1);
      assert.deepStrictEqual(helpers().helperRows(convo).map((r) => r.state), [status, 'running']);
    });
  }

  test('task_updated with a status that is not final leaves the row running', () => {
    const convo = freshConvo();
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
    line(convo, fx.taskUpdated('k1', 'running'));
    assert.strictEqual(helpers().runningCount(convo), 1);
  });

  for (const [status, state] of [['completed', 'completed'], ['failed', 'failed'], ['stopped', 'killed']]) {
    test(`task_notification with status ${status} sets the row ${state} and lowers the count`, () => {
      const convo = freshConvo();
      line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
      line(convo, fx.taskNotification({ taskId: 'k1', toolUseId: 'u1', status }));
      assert.strictEqual(helpers().runningCount(convo), 0);
      assert.strictEqual(helpers().helperRows(convo)[0].state, state);
    });
  }

  test('a killed helper, which reports no stop of its own, lowers the count', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1'), explore('t2')]);
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 't1', subagentType: 'Explore' }));
    line(convo, fx.taskUpdated('k1', 'killed'));
    assert.strictEqual(helpers().runningCount(convo), 1);
  });

  test('a task_updated then a task_notification for one task set its end once', () => {
    const convo = freshConvo();
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
    line(convo, fx.taskStarted({ taskId: 'k2', toolUseId: 'u2', subagentType: 'Explore' }));
    line(convo, fx.taskUpdated('k1', 'killed'));
    const before = changes(convo).length;
    line(convo, fx.taskNotification({ taskId: 'k1', toolUseId: 'u1', status: 'completed' }));
    assert.strictEqual(helpers().runningCount(convo), 1, 'lowered once');
    assert.strictEqual(helpers().helperRows(convo)[0].state, 'killed', 'the first line\'s state stands');
    assert.strictEqual(changes(convo).length, before, 'the second line changes nothing');
  });

  test('a task_notification then a task_updated for one task set its end once', () => {
    const convo = freshConvo();
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
    line(convo, fx.taskNotification({ taskId: 'k1', toolUseId: 'u1', status: 'failed' }));
    line(convo, fx.taskUpdated('k1', 'completed'));
    assert.strictEqual(helpers().runningCount(convo), 0);
    assert.strictEqual(helpers().helperRows(convo)[0].state, 'failed');
  });

  test('a background shell\'s task lines are not helpers', () => {
    const convo = freshConvo();
    assert.strictEqual(line(convo, { ...fx.taskStarted({ taskId: 'b1', toolUseId: 'u1', description: 'npm test' }), task_type: 'local_bash' }), true);
    assert.strictEqual(helpers().runningCount(convo), 0);
    assert.deepStrictEqual(changes(convo), []);
  });

  test('a line that is not a task line is not read as one', () => {
    const convo = freshConvo();
    for (const parsed of [fx.init('s1'), fx.result({ text: 'done' }), fx.textDelta('task_started')]) assert.strictEqual(line(convo, parsed), false);
    assert.strictEqual(helpers().runningCount(convo), 0);
  });

  test('the count is kept per conversation', () => {
    const one = freshConvo();
    const two = freshConvo();
    line(one, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
    assert.deepStrictEqual([helpers().runningCount(one), helpers().runningCount(two)], [1, 0]);
  });
});

describe('helpers_changed', () => {
  test('each change sends the lead\'s rows to the page', async () => {
    const convo = freshConvo();
    await allowed(convo, [explore('t1', 'Look around')]);
    line(convo, fx.taskStarted({ taskId: 'k1', toolUseId: 't1', description: 'Look around', subagentType: 'Explore' }));
    line(convo, fx.taskProgress({ taskId: 'k1', toolUseId: 't1', lastToolName: 'Read' }));
    line(convo, fx.taskNotification({ taskId: 'k1', toolUseId: 't1', status: 'completed' }));
    const all = changes(convo);
    assert.deepStrictEqual(all.map((m) => m.helpers.map((r) => [r.state, r.step])), [[['running', null]], [['running', 'Read']], [['completed', 'Read']]]);
    assert.deepStrictEqual(all[2], {
      type: 'helpers_changed', _conversationId: convo, agentId: 'wren',
      helpers: [{ toolUseId: 't1', agent: 'Explore', kind: 'builtin', task: 'Look around', state: 'completed', step: 'Read' }],
    });
  });

  // By design the switch gates the page's message too. Its sibling, "each
  // change sends the lead's rows to the page", shows what it sends when on.
  test('with helpers off, a change sends nothing to the page', () => {
    const m = names('readTaskLine');
    const convo = freshConvo();
    try {
      m.HELPERS_ENABLED = false;
      m.readTaskLine(convo, lead, fx.taskStarted({ taskId: 'k1', toolUseId: 'u1', subagentType: 'Explore' }));
    } finally {
      m.HELPERS_ENABLED = true;
    }
    assert.deepStrictEqual(changes(convo), []);
  });
});

describe('another runtime reports its helpers into the same count', () => {
  test('a helper counts from noteStarted until noteEnded', () => {
    const m = names('noteStarted', 'noteEnded', 'runningCount');
    const convo = freshConvo();
    m.noteStarted(convo, { lead: 'wren' }, { toolUseId: 'c1', agent: 'ash', kind: 'teammate', task: 'Draft   it' });
    assert.strictEqual(m.runningCount(convo), 1);
    assert.deepStrictEqual(lastRows(convo), [{ toolUseId: 'c1', agent: 'ash', kind: 'teammate', task: 'Draft it', state: 'running', step: null }]);
    m.noteEnded(convo, 'c1', 'killed');
    assert.strictEqual(m.runningCount(convo), 0);
    assert.strictEqual(lastRows(convo)[0].state, 'killed');
  });
});
