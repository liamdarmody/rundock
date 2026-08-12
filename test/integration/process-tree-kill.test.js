'use strict';
// Integration: killing an agent must kill the subprocess tree it owns.
//
// Rundock does not spawn MCP servers. It passes --mcp-config and the agent CLI
// spawns each one over stdio, so they are GRANDCHILDREN of the server, which
// holds no handle on them and never records their pids. Every kill path
// signals a single pid, so those grandchildren survive, get reparented, and go
// on holding memory until the machine is restarted.
//
// The stub models this with `spawnChild: true`, which makes it spawn a
// long-lived, signal-quiet child of its own before answering, and log the pid.
const { test, describe, before, after } = require('node:test');
const assert = require('node:assert');

const h = require('../helpers/harness.js');

let client;

before(async () => {
  await h.boot();
  client = await h.connect();
});
after(async () => h.shutdown());

/**
 * Start a turn whose agent spawns a grandchild, and return that pid.
 *
 * `delayMs` holds the turn open so the entry is still working rather than
 * idle. That matters for cancel: the handler is a deliberate no-op on an idle
 * entry (there is no in-flight work to stop), so a cancel sent after the
 * result would exercise nothing. The grandchild is spawned as soon as the
 * prompt arrives, before the delay, so it exists throughout.
 */
async function startAgentWithChild(convoId, keyword, { delayMs = 0 } = {}) {
  h.clearInvocations();
  h.writeScenario([
    { match: { agent: 'chief-of-staff', promptIncludes: keyword },
      spawnChild: true,
      delayMs,
      turn: [{ text: 'Working, tools attached.' }] },
  ]);
  client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: keyword });

  // Sequence off the grandchild appearing, not off the result: with a delayed
  // turn there is no result yet, and this is the state we want to act on.
  const deadline = Date.now() + 5000;
  let kids = [];
  while (Date.now() < deadline && kids.length === 0) {
    kids = h.readGrandchildren();
    if (kids.length === 0) await h.delay(25);
  }
  assert.strictEqual(kids.length, 1, `expected exactly one modelled MCP process, got ${kids.length}`);
  assert.ok(h.pidAlive(kids[0].pid), 'precondition: the modelled MCP process is running');
  return kids[0].pid;
}

describe('agent subprocess trees', () => {
  test('cancelling a conversation kills the agent subprocess tree, not just the agent', async () => {
    const convoId = h.freshConvoId('tree-cancel');
    // Hold the turn open so the entry is mid-work and genuinely cancellable.
    const kidPid = await startAgentWithChild(convoId, 'tree-kill-cancel', { delayMs: 5000 });

    client.send({ type: 'cancel', conversationId: convoId });

    const exited = await h.waitForPidExit(kidPid);
    assert.ok(exited,
      `cancelling the conversation must take the agent's subprocess tree with it. `
      + `The modelled MCP process (pid ${kidPid}) is still running, which is how these `
      + `accumulate across a session until the machine is restarted.`);
  });

  test('shutting the server down kills agent subprocess trees', async () => {
    const convoId = h.freshConvoId('tree-shutdown');
    const kidPid = await startAgentWithChild(convoId, 'tree-kill-shutdown');

    // killAllChildren is what the SIGINT/SIGTERM handler and the Electron quit
    // path both run, so this is the real shutdown behaviour.
    h.internal.killAllChildren();

    const exited = await h.waitForPidExit(kidPid);
    assert.ok(exited,
      `shutting down must not leave agent subprocess trees behind. `
      + `The modelled MCP process (pid ${kidPid}) outlived the server's own cleanup.`);
  });
});

describe('orphan cleanup on launch', () => {
  // cleanOrphanedProcesses is what boot runs against a previous session's
  // pid file. Three record fates: a dead pid is forgotten (continue), a live
  // pid is signalled, and a signalled pid still alive on the immediate
  // re-check stays tracked so a later launch can try again.
  test('signals live records, keeps SIGTERM survivors, forgets the dead', async () => {
    const { spawn } = require('child_process');
    const fs = require('fs');
    const path = require('path');
    const pidFile = path.join(h.workspaceDir, '.rundock', 'child-pids.json');
    const priorContent = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf-8') : null;

    // A record whose process has exited (and been reaped): skipped, forgotten.
    const dead = spawn(process.execPath, ['-e', '']);
    await new Promise(res => dead.on('exit', res));
    // A record whose process ignores SIGTERM: signalled, observed still
    // alive, kept for the next launch. The child prints once its handler is
    // installed; signalling before that would hit the default action and
    // kill it (a boot race, not the behaviour under test).
    const ignorer = spawn(process.execPath,
      ['-e', 'process.on("SIGTERM", () => {}); console.log("armed"); setInterval(() => {}, 1000);'],
      { stdio: ['ignore', 'pipe', 'ignore'] });
    try {
      await new Promise((res) => ignorer.stdout.once('data', res));
      fs.mkdirSync(path.dirname(pidFile), { recursive: true });
      fs.writeFileSync(pidFile, JSON.stringify([
        { pid: dead.pid, at: Date.now(), cmd: 'node' },
        { pid: ignorer.pid, at: Date.now(), cmd: 'node' },
      ]));

      h.internal.cleanOrphanedProcesses();

      assert.ok(h.pidAlive(ignorer.pid),
        'the SIGTERM-ignoring orphan survives one signal (cleanup must not assume delivery worked)');
      const remaining = JSON.parse(fs.readFileSync(pidFile, 'utf-8'));
      assert.deepStrictEqual(remaining.map(r => r.pid), [ignorer.pid],
        'the survivor stays tracked for the next launch; the dead record is forgotten');
    } finally {
      try { ignorer.kill('SIGKILL'); } catch (e) {}
      if (priorContent == null) { try { fs.rmSync(pidFile, { force: true }); } catch (e) {} }
      else fs.writeFileSync(pidFile, priorContent);
    }
  });
});
