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
let ws = null;
// The card for a batch that starts teammates: answered Allow unless a test
// says otherwise. `cards` holds each card raised.
let cards = [];
let cardAnswer = (req) => req.onDecision(true, null, { card: true });
const used = new Set();
before(() => {
  ws = makeWorkspace({ agents: team });
  srv.setWorkspace(ws);
  if (fs.existsSync(HELPERS)) {
    const m = require(HELPERS);
    m.HELPERS_ENABLED = true;
    prevDeps = m.wireHelpersDeps({
      safeSend: (s) => sent.push(JSON.parse(s)),
      requestServerPermission: (req) => { cards.push(req); cardAnswer(req); },
    });
  }
});
afterEach(() => {
  sent = [];
  cards = [];
  cardAnswer = (req) => req.onDecision(true, null, { card: true });
  // A call still held at the cap is let go, so no hold outlives its test.
  const m = require(HELPERS);
  if (typeof m.leadClosed === 'function') for (const convo of used) m.leadClosed(convo, null);
  used.clear();
});
after(() => {
  if (fs.existsSync(HELPERS)) {
    const m = require(HELPERS);
    m.HELPERS_ENABLED = false;
    if (prevDeps) m.wireHelpersDeps(prevDeps);
  }
  cleanup();
});

let n = 0;
const freshConvo = () => { const convo = String(1764000000000 + (++n)); used.add(convo); return convo; };
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

// ---------------------------------------------------------------------------
// The cap: at most five helpers at once in a conversation
// ---------------------------------------------------------------------------

const CAP_NOTICE = 'At most five helpers run at once. Wait for these to report back, then start the rest.';
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
// Whether an answer has come back yet, without waiting for one that hasn't.
const settled = (answer) => Promise.race([answer.then(() => 'answered'), tick(30).then(() => 'open')]);
// One lead message with these calls, each put to the hook. Returns each
// call's answer as it comes, so a test can see which are still open.
function ask(convo, calls, entry = lead) {
  const m = names('runningCount', 'helperRows');
  m.placeMessage(convo, entry, calls);
  return calls.map((c) => m.answerAgentRequest({ convoId: convo, askedBy: entry.agentId, data: { tool_use_id: c.id, tool_input: c.input } }));
}
const explores = (count, from = 1) => Array.from({ length: count }, (_, i) => explore(`c${from + i}`, `Part ${from + i}`));
const teammate = (id, agent) => ({ id, input: { subagent_type: agent, description: `Part for ${agent}`, prompt: 'Draft it.' } });
const finishTask = (convo, id, status = 'completed') => line(convo, fx.taskNotification({ taskId: `task_${id}`, toolUseId: id, status }));
const states = (convo) => helpers().helperRows(convo).map((r) => r.state);
// Hold `fn` with a different hold, and put the old one back.
async function withHold(ms, fn) {
  const m = helpers();
  const before = m.HELPER_HOLD_MS;
  m.HELPER_HOLD_MS = ms;
  try { return await fn(); } finally { m.HELPER_HOLD_MS = before; }
}
// The cap's events for a conversation, as written to the workspace's events
// file. The file is appended to without waiting, so a test waits for `count`.
function capEvents(convo) {
  const dir = path.join(ws, '.rundock', 'state');
  const out = [];
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => /^events-\d{4}-\d{2}\.jsonl$/.test(f)); } catch (e) { return out; }
  for (const f of files) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l.trim()) out.push(JSON.parse(l));
  }
  return out.filter((e) => e.e === 'helper_cap' && e.conv === convo);
}
async function capEventsAt(convo, count) {
  for (let i = 0; i < 100 && capEvents(convo).length < count; i++) await tick(10);
  return capEvents(convo);
}
// Each line is appended without waiting for the one before, so lines written
// close together can land in either order: outcomes are compared sorted, and
// the order calls start in is read from their answers.
const outcomes = (events) => events.map((e) => e.d && e.d.outcome).sort();

describe('the cap of five helpers at once', () => {
  test('five helpers start at once and a call that would make a sixth is held, its request left open', async () => {
    const m = names('runningCount', 'helperRows');
    const convo = freshConvo();
    const answers = ask(convo, explores(6));
    for (const answer of answers.slice(0, 5)) assert.deepStrictEqual(await answer, { allow: true });
    assert.strictEqual(await settled(answers[5]), 'open', 'the sixth waits');
    assert.strictEqual(m.runningCount(convo), 5, 'a held call is not counted');
    assert.deepStrictEqual(states(convo), ['running', 'running', 'running', 'running', 'running', 'waiting']);
    assert.strictEqual(lastRows(convo)[5].state, 'waiting', 'the page is shown it waiting');
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 1)), ['held']);
  });

  test('when a helper finishes, the earliest held call starts, is counted, and the start is recorded', async () => {
    const m = names('runningCount', 'helperRows');
    const convo = freshConvo();
    const answers = ask(convo, explores(6));
    await Promise.all(answers.slice(0, 5));
    finishTask(convo, 'c2');
    assert.deepStrictEqual(await answers[5], { allow: true });
    assert.strictEqual(m.runningCount(convo), 5);
    assert.deepStrictEqual(states(convo), ['running', 'completed', 'running', 'running', 'running', 'running']);
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 2)), ['held', 'started']);
  });

  test('held calls start in the order they arrived', async () => {
    const convo = freshConvo();
    const answers = ask(convo, explores(7));
    await Promise.all(answers.slice(0, 5));
    finishTask(convo, 'c1');
    assert.deepStrictEqual(await answers[5], { allow: true }, 'the first held starts first');
    assert.strictEqual(await settled(answers[6]), 'open', 'the second still waits');
    finishTask(convo, 'c3');
    assert.deepStrictEqual(await answers[6], { allow: true });
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 4)), ['held', 'held', 'started', 'started']);
  });

  test('a held call that no slot frees for within the hold is refused with the cap\'s reason', async () => {
    const m = names('runningCount', 'helperRows');
    const convo = freshConvo();
    await withHold(40, async () => {
      const answers = ask(convo, explores(6));
      await Promise.all(answers.slice(0, 5));
      assert.deepStrictEqual(await answers[5], { allow: false, notice: CAP_NOTICE });
    });
    assert.strictEqual(m.runningCount(convo), 5);
    assert.deepStrictEqual(states(convo), ['running', 'running', 'running', 'running', 'running'], 'the refused call is dropped');
    assert.strictEqual(lastRows(convo).length, 5, 'and the page is told');
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 2)), ['held', 'refused']);
  });

  test('a held call that starts before its hold runs out is never refused afterwards', async () => {
    const convo = freshConvo();
    await withHold(60, async () => {
      const answers = ask(convo, explores(6));
      await Promise.all(answers.slice(0, 5));
      finishTask(convo, 'c4');
      assert.deepStrictEqual(await answers[5], { allow: true });
      await tick(120);
    });
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 2)), ['held', 'started']);
    assert.deepStrictEqual(states(convo).filter((s) => s === 'running').length, 5);
  });

  test('each cap event names the conversation and the lead, and holds its outcome and nothing else', async () => {
    const convo = freshConvo();
    await withHold(40, async () => {
      const answers = ask(convo, explores(7));
      await Promise.all(answers.slice(0, 5));
      finishTask(convo, 'c1');
      await answers[5];
      await answers[6];
    });
    const events = await capEventsAt(convo, 4);
    assert.deepStrictEqual(outcomes(events), ['held', 'held', 'refused', 'started']);
    for (const e of events) {
      assert.deepStrictEqual(Object.keys(e).sort(), ['agent', 'conv', 'd', 'e', 'ts']);
      assert.deepStrictEqual([e.conv, e.agent], [convo, 'wren']);
      assert.deepStrictEqual(Object.keys(e.d), ['outcome']);
    }
    assert.ok(!JSON.stringify(events).includes('Part '), 'no task or brief is recorded');
  });

  test('the cap is per conversation: two conversations each run five at once', async () => {
    const m = names('runningCount');
    const one = freshConvo();
    const two = freshConvo();
    const first = ask(one, explores(5));
    const second = ask(two, explores(5));
    for (const answer of [...first, ...second]) assert.strictEqual(await settled(answer), 'answered');
    for (const answer of [...first, ...second]) assert.deepStrictEqual(await answer, { allow: true });
    assert.deepStrictEqual([m.runningCount(one), m.runningCount(two)], [5, 5]);
    assert.deepStrictEqual(capEvents(one).concat(capEvents(two)), [], 'nothing was held');
  });

  test('Allow on the card for six teammate calls starts five and holds the sixth', async () => {
    const m = names('runningCount', 'helperRows');
    const convo = freshConvo();
    const calls = ['ash', 'example-research-lead', 'ash', 'example-research-lead', 'ash', 'example-research-lead']
      .map((agent, i) => teammate(`m${i + 1}`, agent));
    const answers = ask(convo, calls);
    for (const answer of answers.slice(0, 5)) assert.deepStrictEqual(await answer, { allow: true, card: true });
    assert.strictEqual(cards.length, 1, 'one card for the batch');
    assert.strictEqual(await settled(answers[5]), 'open');
    assert.strictEqual(m.runningCount(convo), 5);
    assert.deepStrictEqual(m.helperRows(convo).map((r) => [r.kind, r.state]),
      [...Array(5).fill(['teammate', 'running']), ['teammate', 'waiting']]);
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 1)), ['held']);
  });

  test('a held call whose lead closes is answered { allow: false } and dropped, and its helpers end', async () => {
    const m = names('runningCount', 'helperRows', 'leadClosed');
    const convo = freshConvo();
    const proc = { pid: 4242 };
    const answers = ask(convo, explores(6), { agentId: 'wren', process: proc });
    await Promise.all(answers.slice(0, 5));
    m.leadClosed(convo, { pid: 4343 });
    assert.strictEqual(await settled(answers[5]), 'open', 'another process closing leaves it held');
    m.leadClosed(convo, proc);
    assert.deepStrictEqual(await answers[5], { allow: false });
    assert.strictEqual(m.runningCount(convo), 0);
    assert.deepStrictEqual(lastRows(convo).map((r) => r.state), Array(5).fill('killed'), 'the held call is dropped, the rest ended');
    assert.deepStrictEqual(outcomes(await capEventsAt(convo, 1)), ['held'], 'no refusal is recorded');
  });

  test('when another process leads, the last one\'s held calls are refused and its helpers ended, and the new call counts alone', async () => {
    const m = names('runningCount', 'helperRows');
    const convo = freshConvo();
    const answers = ask(convo, explores(6), { agentId: 'wren', process: { pid: 4242 } });
    await Promise.all(answers.slice(0, 5));
    const next = ask(convo, explores(1, 7), { agentId: 'wren', process: { pid: 4343 } });
    assert.strictEqual(await settled(answers[5]), 'answered', 'the held call is answered');
    assert.deepStrictEqual(await answers[5], { allow: false });
    assert.strictEqual(await settled(next[0]), 'answered', 'the new call is not held');
    assert.deepStrictEqual(await next[0], { allow: true });
    assert.strictEqual(m.runningCount(convo), 1);
    assert.deepStrictEqual(states(convo), [...Array(5).fill('killed'), 'running']);
  });
});

// ---------------------------------------------------------------------------
// Placement rows 4 and 5: a lone teammate call while helpers work
// ---------------------------------------------------------------------------

describe('a lone teammate call while helpers work, or after a cap refusal', () => {
  // By design this passes before the count exists. Its sibling, "while an
  // Explore helper runs, a lone teammate call is a helper", shares its setup
  // and fails there.
  test('with nothing running and no cap refusal in the request, a lone teammate call is a handoff', () => {
    const m = helpers();
    const convo = freshConvo();
    assert.strictEqual(m.placeMessage(convo, lead, [teammate('h1', 'ash')]).kind, 'handoff');
  });

  test('while an Explore helper runs, a lone teammate call is a helper', async () => {
    const m = names('runningCount');
    const convo = freshConvo();
    await Promise.all(ask(convo, [explore('e1')]));
    const [answer] = ask(convo, [teammate('h1', 'ash')]);
    assert.strictEqual(m.stateOf(convo).latest.kind, 'helpers');
    assert.deepStrictEqual(await answer, { allow: true, card: true });
    assert.strictEqual(m.runningCount(convo), 2);
  });

  test('while a teammate helper runs, a lone teammate call is a helper', async () => {
    const m = names('runningCount');
    const convo = freshConvo();
    await Promise.all(ask(convo, [teammate('h1', 'ash'), explore('e1')]));
    finishTask(convo, 'e1');
    assert.strictEqual(m.runningCount(convo), 1, 'only Ash runs');
    const [answer] = ask(convo, [teammate('h2', 'example-research-lead')]);
    assert.strictEqual(m.stateOf(convo).latest.kind, 'helpers');
    assert.deepStrictEqual(await answer, { allow: true });
    assert.strictEqual(m.runningCount(convo), 2);
  });

  test('after a cap refusal in the request, with the others finished, a lone teammate call is a helper', async () => {
    const m = names('runningCount');
    const convo = freshConvo();
    await withHold(40, async () => {
      const answers = ask(convo, explores(6));
      await Promise.all(answers.slice(0, 5));
      assert.deepStrictEqual(await answers[5], { allow: false, notice: CAP_NOTICE });
    });
    for (const id of ['c1', 'c2', 'c3', 'c4', 'c5']) finishTask(convo, id);
    assert.strictEqual(m.runningCount(convo), 0);
    const [answer] = ask(convo, [teammate('h1', 'ash')]);
    assert.strictEqual(m.stateOf(convo).latest.kind, 'helpers');
    assert.deepStrictEqual(await answer, { allow: true, card: true });
    assert.strictEqual(m.runningCount(convo), 1);
  });

  // By design this passes before the count exists. Its sibling, "while an
  // Explore helper runs, a lone teammate call is a helper", shares its setup
  // and fails there.
  test('once every helper has finished, with no cap refusal, a lone teammate call is a handoff again', async () => {
    const m = helpers();
    const convo = freshConvo();
    await Promise.all(ask(convo, [explore('e1')]));
    finishTask(convo, 'e1');
    assert.strictEqual(m.placeMessage(convo, lead, [teammate('h1', 'ash')]).kind, 'handoff');
  });
});
