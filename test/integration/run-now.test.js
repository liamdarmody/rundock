'use strict';
// A pressed run, end to end on the real server: the row's message through
// the real dispatch, into the real scheduler, spawning the stub runtime, and
// read back from the two stores it lands in and the one it must not.
//
// The clock is wired to an instant before the routine's slot and the boot
// tick is stopped, so the only run in this file is the one that was pressed.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');

const AGENT = 'runner';
const ROUTINE = 'pressed-check';
const KEY = `${AGENT}:${ROUTINE}`;
const PROMPT = 'pressed routine body';
// November 2026, local components, half past six before a seven o'clock slot.
const clock = { at: new Date(2026, 10, 3, 6, 30, 0) };
let prevDeps = null;
before(async () => {
  await h.boot({ agents: { runner: agentFile({ name: AGENT, type: 'specialist', order: 1 }) } });
  h.writeScenario([{ match: { agent: AGENT, promptIncludes: PROMPT }, turn: [{ text: 'pressed run ran' }] }]);
  prevDeps = scheduler.wireSchedulerDeps({ now: () => clock.at });
  h.internal.stopScheduler();
});
after(async () => {
  if (prevDeps) scheduler.wireSchedulerDeps(prevDeps);
  await h.shutdown();
});

const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .map(name => JSON.parse(fs.readFileSync(path.join(runsDir(), name), 'utf-8')));
const stateFile = () => path.join(h.workspaceDir, '.rundock', 'routine-state.json');
const readIfThere = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : null);
const rosterRoutine = (msg) => msg.agents.find(a => a.id === AGENT).routines.find(r => r.name === ROUTINE);

test('a routine made through save_routine, run by the row\'s message, is recorded as manual and moves no schedule', async () => {
  const client = await h.connect();
  client.send({ type: 'save_routine', agentId: AGENT, routine: { name: ROUTINE, schedule: 'every day at 07:00', prompt: PROMPT, runOn: 'local' } });
  await client.waitFor(m => m.type === 'routine_saved', { label: 'routine_saved' });
  const before = await client.waitFor(m => m.type === 'agents' && rosterRoutine(m), { label: 'the roster carrying the routine' });
  const rosterBefore = rosterRoutine(before.msg);
  assert.strictEqual(rosterBefore.refusal, null, 'born approved and runnable');
  assert.ok(rosterBefore.nextRun, 'sanity: the roster names a next run');
  assert.strictEqual(rosterBefore.running, null);
  const stateBefore = JSON.stringify(h.internal.routineState[KEY] || null);
  const fileBefore = readIfThere(stateFile());
  const nextBefore = scheduler.nextRunFor(KEY, 'every day at 07:00').toISOString();
  const since = client.messages.length;
  client.send({ type: 'run_routine_now', agentId: AGENT, name: ROUTINE, occurrence: 0 });
  client.send({ type: 'run_routine_now', agentId: AGENT, name: ROUTINE, occurrence: 0 });
  const started = await client.waitFor(m => m.type === 'routine_run_started', { since, label: 'routine_run_started' });
  assert.strictEqual(started.msg.name, ROUTINE);
  const refused = await client.waitFor(m => m.type === 'routine_action_error', { since, label: 'the second press refused' });
  assert.strictEqual(refused.msg.reason, 'running');
  const going = await client.waitFor(m => m.type === 'agents' && rosterRoutine(m).running, { since, label: 'the roster carrying the in-flight fact' });
  assert.strictEqual(rosterRoutine(going.msg).running.trigger, 'manual');
  assert.ok(await h.waitUntil(() => records().some(r => r.status !== 'running')), 'the record closed');
  const done = records();
  assert.strictEqual(done.length, 1, 'two presses left one record');
  assert.strictEqual(done[0].trigger, 'manual');
  assert.strictEqual(done[0].status, 'succeeded');
  assert.strictEqual(h.readInvocations().filter(inv => inv.agent === AGENT).length, 1, 'and one spawn');
  assert.strictEqual(JSON.stringify(h.internal.routineState[KEY] || null), stateBefore, 'the routine state is unchanged');
  assert.strictEqual(readIfThere(stateFile()), fileBefore, 'and so is its file');
  assert.strictEqual(scheduler.nextRunFor(KEY, 'every day at 07:00').toISOString(), nextBefore, 'and the next-run instant');
  const after = await client.waitFor(m => m.type === 'agents' && rosterRoutine(m).running === null, { since: going.index + 1, label: 'the roster after the run' });
  assert.strictEqual(rosterRoutine(after.msg).nextRun, rosterBefore.nextRun, 'the roster publishes the same next run it did before');
  assert.strictEqual(rosterRoutine(after.msg).state, null, 'and no state slot was written');
  client.close();
});
