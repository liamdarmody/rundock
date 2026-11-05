'use strict';
// Every routine is told, before it starts, that nobody is watching.
//
// A routine's output goes nowhere and no reply can reach it. Until a step was
// refused, nothing said so: the refusal line (scripts/refusal-notice.js) told
// a routine to carry on only after the refusal, and a run that had already
// asked a question in its final message, or stopped to wait for an answer,
// read as finished with nothing saved. So every routine run, on either
// runtime, carries one fixed line in its session-level instructions: the
// system prompt on Claude Code, the thread's developer instructions on Codex.
// It never goes in the turn input, because the routine prompt is the plan an
// approval was given for, and changing that would lapse every approval.
//
// A conversation has somebody to ask, so it never gets the line.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');
const { UNATTENDED_RUN, UNATTENDED_NEXT, FAILED_LINE } = require('../../scripts/refusal-notice.js');
const { UNATTENDED_NEXT_UNLOADED } = require('../../scripts/permission-hook.js');

let client;

before(async () => {
  await h.boot({
    agents: {
      lead: agentFile({
        name: 'lead', description: 'Runs the team', type: 'orchestrator', order: 0,
      }),
      writer: agentFile({
        name: 'writer', description: 'Writes things', type: 'specialist', order: 1, reportsTo: 'lead',
        routines: [{ name: 'sweep', schedule: 'every day at 07:00', prompt: 'writer sweep', enabled: true }],
      }),
      helper: agentFile({
        name: 'helper', description: 'Helps on Codex', type: 'specialist', order: 2, reportsTo: 'lead', runtime: 'codex',
        routines: [{ name: 'check', schedule: 'every day at 07:00', prompt: 'helper check', enabled: true }],
      }),
    },
  });
  h.writeScenario([{ match: {}, turn: [{ text: 'done.' }] }]);
  h.writeCodexScenario([]);
  h.internal.stopScheduler();
  client = await h.connect();
});

after(async () => h.shutdown());

function settle(key) {
  return h.waitUntil(() => !scheduler.runningRuns().some(r => r.key === key), 20000);
}

// The value a flag was given in a child's argument list, or null.
const flagValue = (argv, flag) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : null);

test('the line says what a refused step is also told, and contradicts none of it', () => {
  assert.ok(UNATTENDED_RUN.endsWith(FAILED_LINE), 'it ends on the failure line the record reads');
  assert.ok(UNATTENDED_NEXT.endsWith(FAILED_LINE), 'the line a refused step is given ends on the same words');
  assert.strictEqual(UNATTENDED_NEXT_UNLOADED, UNATTENDED_NEXT, 'and so does the hook\'s copy of it');
  assert.match(UNATTENDED_RUN, /carry on with the rest of the job without it/, 'a refused step is carried on without, as the refusal says');
  assert.match(UNATTENDED_RUN, /Do not ask/);
  assert.match(UNATTENDED_RUN, /Save the work/);
  assert.match(UNATTENDED_RUN, /RUN STATUS: succeeded/);
  assert.doesNotMatch(UNATTENDED_RUN, /stop and ask|ask the person|wait for (their|an) answer/i,
    'nothing in it tells a run to wait for somebody');
  assert.doesNotMatch(UNATTENDED_RUN, /\n/, 'one line');
});

test('a routine on Claude Code carries the line in its system prompt, and its routine prompt is unchanged', async () => {
  h.clearInvocations();
  client.send({ type: 'run_routine_now', agentId: 'writer', name: 'sweep', occurrence: 0 });
  assert.ok(await h.waitUntil(() => h.readInvocations().some(i => i.print), 10000), 'the routine started a child');
  const spawn = h.readInvocations().find(i => i.print);
  assert.strictEqual(flagValue(spawn.argv, '--append-system-prompt'), UNATTENDED_RUN);
  assert.strictEqual(spawn.argv[spawn.argv.length - 1], 'writer sweep', 'the routine prompt is the plan that was approved, untouched');
  assert.strictEqual(spawn.argv.filter(a => a === '--append-system-prompt').length, 1);
  await settle('writer:sweep');
});

// The thread/start each Codex request in the stub's log asked for.
const codexThreadStarts = () => h.readInvocations()
  .filter(i => i.mode === 'app-server' && i.method === 'thread/start')
  .map(i => i.params || {});

test('a routine on Codex carries the line in its thread\'s developer instructions, and its turn input is unchanged', async () => {
  h.clearInvocations();
  client.send({ type: 'run_routine_now', agentId: 'helper', name: 'check', occurrence: 0 });
  assert.ok(await h.waitUntil(() => h.codexTurnPrompts().some(p => p.includes('helper check')), 20000), 'the routine started a turn');
  const [thread] = codexThreadStarts();
  assert.ok(thread, 'the routine started a thread');
  assert.strictEqual(thread.developerInstructions, UNATTENDED_RUN, 'the line is in the session-level channel');
  const prompt = h.codexTurnPrompts().find(p => p.includes('helper check'));
  assert.ok(!prompt.includes('Nobody is watching'), 'and nowhere in the turn input');
  assert.ok(prompt.endsWith('helper check'), 'whose routine prompt is last, as it was approved');
  await settle('helper:check');
});

test('a conversation has somebody to ask, on either runtime, and never gets the line', async () => {
  h.clearInvocations();
  const claudeConvo = h.freshConvoId('watched');
  client.send({ type: 'chat', conversationId: claudeConvo, agent: 'writer', content: 'hello writer' });
  await client.waitForEvent('system', 'done', claudeConvo);
  const conversation = h.readInvocations().find(i => !i.print && Array.isArray(i.argv));
  assert.ok(conversation, 'the conversation started a child');
  assert.ok(conversation.argv.includes('--append-system-prompt'), 'a conversation has a system prompt of its own');
  assert.ok(!conversation.argv.some(a => String(a).includes('Nobody is watching')), 'without the routine line in it');
  h.reapConvo(claudeConvo);

  const codexConvo = h.freshConvoId('watched-codex');
  client.send({ type: 'chat', conversationId: codexConvo, agent: 'helper', content: 'hello helper' });
  await client.waitForEvent('system', 'done', codexConvo);
  const turn = h.codexTurnPrompts().find(p => p.includes('hello helper'));
  assert.ok(turn, 'the Codex conversation started a turn');
  assert.ok(!turn.includes('Nobody is watching'), 'and its prompt carries no routine line');
  const threads = codexThreadStarts();
  assert.ok(threads.length, 'on a thread it started');
  assert.ok(threads.every(t => !String(t.developerInstructions || '').includes('Nobody is watching')),
    'whose developer instructions carry no routine line either');
});
