'use strict';
// THE ENVIRONMENT EACH LAUNCH OF THE CLAUDE CLI IS GIVEN, THROUGH THE FUNCTION
// PRODUCTION CALLS.
//
// test/unit/unattended-spawn-paths.test.js lists every place the app starts a
// process. The spawns of an agent are driven end to end in
// test/integration/spawn-path-wording.test.js. The other launches of the
// Claude CLI cannot be: the reconnect check and the sign-in console start no
// agent of Rundock's, so no card is ever raised for them. What they are given
// is tested here instead, through the function production calls with its
// spawn stood in for: no --settings (so none of the workspace's hooks are
// configured), and no environment of Rundock's (so the hook, wherever it is
// configured, decides nothing for them).
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');
const claudeRt = require('../../lib/runtime/claude.js');
const { checkConnection, openClaudeConsole, consoleGate } = require('../../lib/runtime/claude-console.js');

test('the funnel every agent spawn goes through passes on the environment it is given', () => {
  // spawnClaude hands its options to spawn unchanged but for `detached`, so
  // the environment an agent runs with is the one its caller built.
  const src = fs.readFileSync(path.join(ROOT, 'lib', 'runtime', 'claude.js'), 'utf8');
  assert.match(src, /const proc = spawn\(resolveClaudeBin\(\), args, \{ \.\.\.options, detached: process\.platform !== 'win32' \}\);/);
});

test('a routine is started with no conversation, even when the app was given one, and a conversation with its own', () => {
  const before = process.env.RUNDOCK_CONVO_ID;
  process.env.RUNDOCK_CONVO_ID = 'inherited';
  const prev = claudeRt.wireClaudeRuntimeDeps({ getActualPort: () => 1 });
  try {
    assert.strictEqual('RUNDOCK_CONVO_ID' in claudeRt.getSpawnEnv(null), false);
    assert.strictEqual(claudeRt.getSpawnEnv(null).RUNDOCK, '1');
    assert.strictEqual(claudeRt.getSpawnEnv('c1').RUNDOCK_CONVO_ID, 'c1');
    // An empty id is no conversation, which is why the chat message gives one
    // that names none the default conversation rather than its empty id.
    assert.strictEqual('RUNDOCK_CONVO_ID' in claudeRt.getSpawnEnv(''), false);
  } finally {
    claudeRt.wireClaudeRuntimeDeps(prev);
    if (before === undefined) delete process.env.RUNDOCK_CONVO_ID; else process.env.RUNDOCK_CONVO_ID = before;
  }
});

test('the hook decides nothing for a process started with the app\'s own environment', () => {
  const own = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('RUNDOCK')));
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-environments-outside-')));
  try {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'permission-hook.js')], {
      input: JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 's', cwd: os.tmpdir(), tool_name: 'Bash', tool_input: { command: `cat ${path.join(outside, 'notes.md')}` } }),
      encoding: 'utf8', env: { ...own, NODE_V8_COVERAGE: '' }, timeout: 10000,
    });
    assert.strictEqual(r.status, 0, r.stderr);
    assert.deepStrictEqual(JSON.parse(r.stdout), {}, 'no answer, so no card and no notice');
  } finally { fs.rmSync(outside, { recursive: true, force: true }); }
});

// A spawn stood in for, given to the function production calls.
function capture() {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    child.unref = () => {};
    setImmediate(() => { child.emit('spawn'); child.emit('close', 0); });
    return child;
  };
  return { calls, spawn };
}

test('the connection check runs from the home folder with no settings and no environment of Rundock\'s', async () => {
  const { calls, spawn } = capture();
  const answer = await checkConnection({ bin: '/opt/claude/bin/claude', spawn, timeoutMs: 5000 });
  assert.deepStrictEqual(answer, { connected: true, known: true });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, ['--print', 'test', '--output-format', 'text'], 'no --settings, so none of the workspace\'s hooks');
  assert.strictEqual(calls[0].options.cwd, os.homedir());
  assert.strictEqual('env' in calls[0].options, false, 'the app\'s own environment, nothing of Rundock\'s added');
});

test('the sign-in console is opened with no environment of Rundock\'s', async () => {
  const { calls, spawn } = capture();
  const answer = await openClaudeConsole({ bin: '/opt/claude/bin/claude', version: null, platform: 'darwin', spawn, gate: consoleGate() });
  assert.deepStrictEqual(answer, { ok: true });
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual([calls[0].command, calls[0].args], ['open', ['-a', 'Terminal', '/opt/claude/bin/claude']], 'a terminal the person types into, with no --settings');
  assert.strictEqual('env' in calls[0].options, false);
});
