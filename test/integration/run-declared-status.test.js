'use strict';
// Integration: a routine run whose agent declares that it failed is recorded
// as failed, with the agent's reason.
//
// An agent that reports a failure in its final message still exits cleanly,
// and the run's status used to come from the exit alone, so a triage that
// applied nothing was recorded as succeeded, twice, and found by a person
// noticing labels had stopped appearing. Rundock does not read intent from
// prose, so the fix is a contract: a final line `RUN STATUS: failed: <reason>`
// (docs/ROUTINES.md). A run that declares nothing is recorded exactly as
// before, so no existing routine changes state unannounced.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const h = require('../helpers/harness.js');
const { agentFile } = require('../helpers/workspace.js');
const scheduler = require('../../lib/scheduler.js');

const AGENT = 'triager';
let client;

before(async () => {
  await h.boot({ agents: { triager: agentFile({ name: AGENT, type: 'specialist', order: 1 }) } });
  h.writeScenario([
    { match: { agent: AGENT, promptIncludes: 'declares failure' },
      turn: [{ text: 'I read and classified everything, but could not apply any labels.\n\nRUN STATUS: failed: labels could not be applied (keychain unavailable)' }] },
    { match: { agent: AGENT, promptIncludes: 'says so in prose' },
      turn: [{ text: 'DIGEST FAILED: I read everything, but could not write the digest.' }] },
    { match: { agent: AGENT, promptIncludes: 'declares success' },
      turn: [{ text: 'All done.\n\nRUN STATUS: succeeded' }] },
  ]);
  h.internal.stopScheduler();
  client = await h.connect();
});
after(async () => h.shutdown());

const runsDir = () => path.join(h.workspaceDir, '.rundock', 'runs');
const records = () => (fs.existsSync(runsDir()) ? fs.readdirSync(runsDir()) : [])
  .map(name => JSON.parse(fs.readFileSync(path.join(runsDir(), name), 'utf-8')));

async function runOnce(name, prompt) {
  client.send({ type: 'save_routine', agentId: AGENT, routine: { name, schedule: 'every day at 07:00', prompt, runOn: 'local' } });
  await client.waitFor(m => m.type === 'routine_saved' && m.name === name, { label: `${name} saved` });
  client.send({ type: 'run_routine_now', agentId: AGENT, name, occurrence: 0 });
  assert.ok(await h.waitUntil(() => records().some(r => r.routine === name && r.status !== 'running'), 10000), `${name} closed`);
  return records().find(r => r.routine === name);
}

test('a run whose agent declares failure is recorded as failed, with the agent\'s reason', async () => {
  const record = await runOnce('declared', 'this run declares failure');
  assert.strictEqual(record.status, 'failed');
  assert.strictEqual(record.error, 'labels could not be applied (keychain unavailable)');
  assert.strictEqual(record.declared, true, 'marked as the agent\'s own report, apart from a crash');
});

test('a run that says it failed only in prose is still recorded as succeeded', async () => {
  const record = await runOnce('prose', 'this run says so in prose');
  assert.strictEqual(record.status, 'succeeded');
  assert.strictEqual(record.error, null);
  assert.ok(!('declared' in record), 'and its record carries no new field');
});

test('a run that declares success is recorded as succeeded, exactly as one that declares nothing', async () => {
  const record = await runOnce('declared-ok', 'this run declares success');
  assert.strictEqual(record.status, 'succeeded');
  assert.ok(!('declared' in record));
});

test('the contract reads only the last line of the final message', () => {
  const said = (text) => scheduler.declaredOutcome({ kind: 'text', text });
  assert.deepStrictEqual(said('Work.\nRUN STATUS: failed: no labels'), { status: 'failed', reason: 'no labels' });
  assert.deepStrictEqual(said('**RUN STATUS: failed: no labels**'), { status: 'failed', reason: 'no labels' });
  assert.deepStrictEqual(said('`RUN STATUS: FAILED`'), { status: 'failed', reason: 'The agent reported that the run failed, and gave no reason.' });
  assert.strictEqual(said('RUN STATUS: failed: no labels\nBut then I fixed it.'), null, 'a line that is not last is not a declaration');
  assert.strictEqual(said('RUN STATUS: succeeded'), null);
  assert.strictEqual(said('The run status: failed'), null, 'only the exact form counts');
  assert.strictEqual(scheduler.declaredOutcome({ kind: 'tool', tool: 'Bash' }), null, 'a run that ended on a tool call declared nothing');
  assert.strictEqual(scheduler.declaredOutcome(null), null);
});
