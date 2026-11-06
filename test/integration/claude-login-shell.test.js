'use strict';
// THE #401 MACHINE, DRIVEN THROUGH THE SERVER.
//
// An old Claude Code (2.0.58) sits in ~/.local/bin, first on the PATH the app
// was started with, as the desktop app's ensurePath puts it. The person's
// login shell finds the current copy (the stub) in a folder the app does not
// list. Every path that starts Claude Code, a new chat, a resumed one, a
// delegation and a routine run, starts the current copy, the Settings probe
// and the desktop app's check report it, the old copy is never run, not even
// for its version, and the shell is asked once.
//
// Before the login shell was asked, the old copy was found first, and the
// harness refuses to boot on anything but the stub: this file failed there.
//
// The install folders the lookup tries after the login PATH are the two in
// this file's home, so the system folders of the machine running the suite
// are never looked in.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const h = require('../helpers/harness.js');
const { agentFile, standardTeam, makeTempDir } = require('../helpers/workspace.js');
const { makeLoginShell, makeClaude, OLD } = require('../helpers/login-shell.js');
const scheduler = require('../../lib/scheduler.js');
const lookup = require('../../lib/runtime/claude-lookup.js');

const POSIX = process.platform === 'win32' ? 'the stubs are POSIX scripts and the login shell is a POSIX idea' : false;

let client;
let old;
let shell;
let restoreDeps;
const stub = path.join(h.STUB_DIR, 'claude');

before(async () => {
  if (POSIX) return;
  const root = makeTempDir('login-shell-401-');
  const home = path.join(root, 'home');
  const local = path.join(home, '.local', 'bin');
  old = makeClaude(local, OLD);
  shell = makeLoginShell(root, { loginPath: [h.STUB_DIR, h.CODEX_STUB_DIR, '/usr/bin', '/bin'].join(':') });
  restoreDeps = lookup.wireLookupDeps({ installFolders: () => [local, path.join(home, '.claude', 'bin')] });
  await h.boot({
    agents: {
      ...standardTeam(),
      'note-keeper': agentFile({
        name: 'note-keeper', description: 'Keeps notes', type: 'specialist', order: 5, reportsTo: 'chief-of-staff',
        routines: [{ name: 'tidy', schedule: 'every day at 07:00', prompt: 'login tidy', enabled: true }],
      }),
    },
    env: { HOME: home, SHELL: shell.file, PATH: [local, h.STUB_DIR, h.CODEX_STUB_DIR, process.env.PATH].join(path.delimiter) },
  });
  h.internal.stopScheduler();
  client = await h.connect();
});

after(async () => {
  if (POSIX) return;
  await h.shutdown();
  lookup.wireLookupDeps(restoreDeps);
  lookup.forget();
});

const startedFor = (agent) => h.readInvocations().filter((r) => r.agent === agent);

test('a new chat and a resumed one start the copy the login shell finds', { skip: POSIX }, async () => {
  h.clearInvocations();
  // A resumed chat is started without --agent, so the rule matches any turn.
  h.writeScenario([{ match: {}, turn: [{ text: 'Started on the current copy.' }] }]);
  for (const extra of [{}, { sessionId: '7d1f0a52-4c1e-4b8e-9a51-1d2f3e4a5b6c' }]) {
    const convoId = h.freshConvoId('login401');
    const since = client.messages.length;
    client.send({ type: 'chat', conversationId: convoId, agent: 'chief-of-staff', content: 'hello', ...extra });
    const { msg } = await client.waitFor((m) => m.type === 'result' && m._conversationId === convoId, { since, label: 'the turn' });
    assert.ok(String(msg.result).includes('Started on the current copy.'), `the turn ran: ${JSON.stringify(msg.result)}`);
    h.reapConvo(convoId);
  }
  assert.strictEqual(h.readInvocations().length, 2, 'both chats reached the current copy');
});

test('a delegation starts the copy the login shell finds', { skip: POSIX }, async () => {
  h.clearInvocations();
  h.writeScenario([{ match: { agent: 'lead-designer' }, turn: [{ text: 'Delegated on the current copy.' }] }]);
  const convoId = h.freshConvoId('login401delegate');
  h.internal.chatProcesses.set(convoId, { agentId: 'chief-of-staff', processId: 'login-parent', exited: false, toolCalls: [] });
  try {
    client.send({ type: 'delegate', conversationId: convoId, targetAgent: 'lead-designer', context: 'design the notice' });
    const started = await h.waitUntil(() => startedFor('lead-designer').length > 0, { timeout: 10000 });
    assert.ok(started, 'the delegate reached the current copy');
  } finally {
    h.reapConvo(convoId);
  }
});

test('a routine run starts the copy the login shell finds', { skip: POSIX }, async () => {
  h.clearInvocations();
  h.writeScenario([{ match: { agent: 'note-keeper' }, turn: [{ text: 'Tidied.' }] }]);
  const before = scheduler.readRunRecords().length;
  client.send({ type: 'run_routine_now', agentId: 'note-keeper', name: 'tidy', occurrence: 0 });
  const ended = await h.waitUntil(() => scheduler.readRunRecords().length > before
    && !scheduler.runningRuns().some((r) => r.key === 'note-keeper:tidy'), { timeout: 15000 });
  assert.ok(ended, 'the run ended and left its record');
  assert.strictEqual(startedFor('note-keeper').length, 1, 'the routine reached the current copy');
  const record = scheduler.readRunRecords().find((r) => r.routine === 'tidy');
  assert.notStrictEqual(record && record.status, 'failed', `the run did not fail: ${record && record.error}`);
});

test('the Settings probe and the desktop app\'s check report the current copy; the old one never ran, and the shell was asked once', { skip: POSIX }, async () => {
  const since = client.messages.length;
  client.send({ type: 'get_runtime_status' });
  const { msg } = await client.waitFor((m) => m.type === 'runtime_status', { since, label: 'runtime_status' });
  assert.strictEqual(msg.claude.installed, true);
  assert.strictEqual(msg.claude.version, '2.1.318-stub', 'the Settings probe reads the current copy');
  assert.strictEqual(h.internal.resolveClaudeBin(), stub);
  const found = lookup.installedClaude();
  assert.strictEqual(found && found.bin, stub, 'the app\'s check names the current copy');
  assert.match(String(found.version), /2\.1\.318-stub/);
  assert.deepStrictEqual(old.runs(), [], 'the old copy in ~/.local/bin was never run');
  assert.strictEqual(shell.runs().length, 1, 'the login shell was asked once, never per spawn');
  assert.ok(fs.existsSync(path.join(old.dir, 'claude')), 'the old copy is still there: it was passed over, not removed');
});
