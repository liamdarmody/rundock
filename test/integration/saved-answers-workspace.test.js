'use strict';
// A request's saved answers are those of its own workspace, never the open
// one's.
//
// THE FAULT. The server applied saved "Always allow" answers from the
// workspace that happened to be open. A switch never ends a routine, so a run
// started in one workspace could still be asking after a person opened
// another, and it was answered from the other's answers: a key saved for one
// folder let a routine in a different folder run what nobody had allowed
// there, with no card.
//
// HOW IT IS DRIVEN. Nothing in the server is stubbed. Workspaces are opened as
// the window opens them, with set_workspace over the socket, through the real
// open path. Answers are saved as the window saves them, with add_tool_allow,
// and the window is closed before any request is put. The routine is started
// the way the scheduler starts every run, and its agent puts each command to
// the real permission hook with the token its run was started with. A turn is
// held on the second workspace's answer-file guard, as a conversation running
// there would hold it, so that workspace's saved answers are live.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, makeWorkspace, makeTempDir } = require('../helpers/workspace.js');
const { seenHere } = require('../helpers/approvals.js');
const guard = require('../../lib/workspace/answer-file-guard.js');
const { readToolAllows } = require('../../lib/workspace/boundary.js');
const config = require('../../lib/config.js');

const AGENT = 'runner';
const TIMEOUT_MS = 1500;
const HOUR = 60 * 60 * 1000;
const COMMAND = 'python3 tools/report.py';

before(async () => {
  await h.boot({
    workspace: false,
    agents: { runner: agentFile({ name: AGENT, type: 'specialist', order: 1 }) },
    env: { RUNDOCK_PERMISSION_TIMEOUT_MS: String(TIMEOUT_MS) },
  });
  h.internal.stopScheduler();
});
after(async () => {
  await h.shutdown();
});

// A workspace with the agent in it, which this install has opened before, so
// its routines run as any approved routine does.
function workspaceWith(name) {
  const dir = makeWorkspace({ claudeMd: `# ${name}\n`, agents: { [AGENT]: agentFile({ name: AGENT, type: 'specialist', order: 1 }) } });
  seenHere(dir);
  return dir;
}

async function noWindow() {
  assert.ok(await h.waitUntil(() => h.internal.wss.clients.size === 0, { timeout: 3000 }), 'no window is connected');
}

// One message from a window with the launch key, as the window sends it, and
// the window closed again once the server has answered.
async function throughWindow(message, settled, label) {
  const window = await h.connect();
  try {
    const since = window.messages.length;
    window.send(message);
    const { msg } = await window.waitFor(settled, { since, label });
    return msg;
  } finally {
    window.close();
    await noWindow();
  }
}
async function choose(dir) {
  const msg = await throughWindow({ type: 'set_workspace', path: dir }, (m) => m.type === 'workspace_set' || m.type === 'workspace_error', `workspace_set for ${dir}`);
  assert.strictEqual(msg.type, 'workspace_set', `opening ${dir} failed: ${msg.message}`);
  assert.strictEqual(config.getWorkspace(), dir, 'the workspace is open');
}
const save = (key) => throughWindow({ type: 'add_tool_allow', key }, (m) => m.type === 'tool_allows' && m.tools.includes(key), `the saved answers after saving ${key}`);

const permissionsOf = (dir) => {
  const file = path.join(dir, '.rundock', 'permissions.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf-8')).allowedTools || [] : [];
};
function recordsIn(dir) {
  const runs = path.join(dir, '.rundock', 'runs');
  if (!fs.existsSync(runs)) return [];
  return fs.readdirSync(runs).filter((n) => n.endsWith('.json')).map((n) => JSON.parse(fs.readFileSync(path.join(runs, n), 'utf-8')));
}
function eventsIn(dir) {
  const state = path.join(dir, '.rundock', 'state');
  if (!fs.existsSync(state)) return [];
  return fs.readdirSync(state).filter((n) => /^events-.*\.jsonl$/.test(n))
    .flatMap((n) => h.readAppendedLog(path.join(state, n)));
}
const bashOutcomes = (...dirs) => dirs.flatMap(eventsIn).filter((e) => e.e === 'permission' && e.d && e.d.tool === 'Bash').map((e) => e.d.decision);
// What the hook told a run's agent, call by call, from the workspace it ran in.
const answersIn = (dir, record) => h.readAppendedLog(path.join(dir, 'stub-hook-answers.jsonl'))
  .filter((a) => a.sessionId === record.sessionId).map((a) => a.answer && a.answer.hookSpecificOutput);

// A ROUTINE RUN in the open workspace, started the way the scheduler starts
// every run, whose agent puts each of `hooks` to the real permission hook.
let seq = 0;
function startRoutine(dir, hooks) {
  assert.strictEqual(config.getWorkspace(), dir, 'a run starts in the open workspace');
  const name = `bound-routine-${++seq}`;
  const prompt = `bound routine body ${seq}`;
  fs.writeFileSync(path.join(dir, 'stub-scenario.json'), JSON.stringify({
    rules: [{ match: { agent: AGENT, promptIncludes: prompt }, hooks, turn: [{ text: 'done' }] }],
  }));
  const agent = h.internal.discoverAgents().find((a) => a.id === AGENT);
  assert.ok(agent, 'the agent is there');
  h.internal.executeRoutine(agent, { name, schedule: 'every day at 09:00', prompt }, `${AGENT}:${name}`);
  return { name, record: () => recordsIn(dir).find((r) => r.routine === name) };
}
async function finished(run) {
  assert.ok(await h.waitUntil(() => { const r = run.record(); return r && r.status !== 'running'; }, { timeout: 15000 }), `${run.name} finished`);
  return run.record();
}

test('a routine started in one workspace and still running after a switch is answered from its own saved answers, never the open one\'s: it cards and times out', async () => {
  const a = workspaceWith('Started here');
  const b = workspaceWith('Opened since');
  const gate = path.join(makeTempDir('bound-gate-'), 'go');
  await choose(a);
  const run = startRoutine(a, [{ tool: 'Bash', input: { command: COMMAND }, untilFile: gate }]);
  try {
    assert.ok(await h.waitUntil(() => run.record() && guard.answerFilesWatched(a), { timeout: 8000 }), 'the run is going, its turn guarded in its own workspace');
    await choose(b);
    assert.strictEqual(run.record().status, 'running', 'the switch left the run going');
    // A turn running in the open workspace, so its saved answers are live.
    const turn = guard.acquireAnswerFileGuard(b, () => {}, { intervalMs: HOUR, convoId: 'bound-open-conversation' });
    try {
      await save('Bash:python3');
      assert.ok(permissionsOf(b).includes('Bash:python3'), 'saved in the open workspace');
      assert.ok(!permissionsOf(a).includes('Bash:python3'), 'and not in the one the run started in');
      assert.ok(readToolAllows().includes('Bash:python3'));
      // The run's agent now puts its command to the hook.
      fs.writeFileSync(gate, '');
      const record = await finished(run);
      const answers = answersIn(a, record);
      assert.strictEqual(answers.length, 1, 'the command was put to the hook');
      assert.strictEqual(answers[0] && answers[0].permissionDecision, 'deny', `the open workspace's saved answer answered the run: ${JSON.stringify(answers)}`);
      assert.strictEqual(record.refusedCards, 1, 'it waited on a card nobody answered, and the run counts it');
      // Events go to the open workspace's log, as every event does; both are
      // read, so the outcome is counted wherever it lands.
      assert.ok(await h.waitUntil(() => bashOutcomes(a, b).length >= 1, { timeout: 3000 }), 'the outcome is recorded');
      await h.delay(200);
      assert.deepStrictEqual(bashOutcomes(a, b), ['timeout'], 'recorded as timed out, never as allowed');
    } finally {
      turn.release();
    }
  } finally {
    fs.writeFileSync(gate, '');
  }
});

test('the inverse: a routine started in the open workspace is answered from that workspace\'s saved answers, with no window', async () => {
  const b = workspaceWith('Open and saved');
  await choose(b);
  await save('Bash:python3');
  const run = startRoutine(b, [{ tool: 'Bash', input: { command: COMMAND } }]);
  const record = await finished(run);
  assert.strictEqual(record.status, 'succeeded', JSON.stringify(record));
  const answers = answersIn(b, record);
  assert.strictEqual(answers.length, 1, 'the command was put to the hook');
  assert.strictEqual(answers[0] && answers[0].permissionDecision, 'allow', JSON.stringify(answers));
  assert.strictEqual(record.refusedCards, undefined, 'no card was refused');
  assert.ok(await h.waitUntil(() => eventsIn(b).some((e) => e.e === 'permission' && e.d && e.d.reason === 'always-allowed'), { timeout: 3000 }), 'the outcome is recorded');
  const allowed = eventsIn(b).filter((e) => e.e === 'permission' && e.d && e.d.tool === 'Bash');
  assert.deepStrictEqual(allowed.map((e) => e.d), [{ tool: 'Bash', decision: 'allow', reason: 'always-allowed' }], 'answered as saved');
});
