'use strict';
// The console a person reconnects Claude Code in, and the check that says
// whether they have. Nothing here starts a real window or a real `claude`: a
// fake spawn stands in, and says what it was asked to start.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const C = require('../../lib/runtime/claude-console.js');

// A spawn that records its call and answers with the event it is told to,
// after writing `said` to stderr when it closes.
function fakeSpawn(answer, { code = 0, said = '' } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.unref = () => { child.unrefed = true; };
    child.kill = () => { child.killed = true; };
    calls.push({ command, args, options, child });
    if (answer === 'throw') throw new Error('spawn refused');
    setImmediate(() => {
      if (answer === 'spawn') child.emit('spawn');
      if (answer === 'error') child.emit('error', Object.assign(new Error('not found'), { code: 'ENOENT' }));
      if (answer === 'close') {
        if (said) child.stderr.emit('data', Buffer.from(said));
        child.emit('close', code);
      }
    });
    return child;
  };
  return { spawn, calls };
}
// What the server passes: whether a failed turn's words say it is signed out.
const isAuthFailure = (text) => /please run \/login|invalid authentication credentials/i.test(text);

describe('what opens the console, per platform', () => {
  const BIN = '/opt/example/bin/claude';
  test('macOS opens Terminal running claude', () => {
    assert.deepStrictEqual(C.consoleCommand(BIN, 'darwin', {}), { command: 'open', args: ['-a', 'Terminal', BIN], options: {} });
  });
  test('Windows opens a console that stays open, the path quoted for spaces', () => {
    const c = C.consoleCommand('C:\\Program Files\\claude.exe', 'win32', {});
    assert.strictEqual(c.command, 'start "Sign in to Claude" cmd /k ""C:\\Program Files\\claude.exe""');
    assert.deepStrictEqual(c.options, { shell: true });
  });
  test('Linux needs a display and a terminal to open', () => {
    const withTerminal = { DISPLAY: ':0', PATH: __dirname };
    assert.strictEqual(C.consoleCommand(BIN, 'linux', { PATH: '/nowhere' }), null, 'no display');
    assert.strictEqual(C.consoleCommand(BIN, 'linux', { DISPLAY: ':0', PATH: '/nowhere' }), null, 'no terminal on the path');
    assert.deepStrictEqual(C.consoleCommand(BIN, 'linux', withTerminal, () => true),
      { command: 'x-terminal-emulator', args: ['-e', BIN], options: {} });
  });
  test('anywhere else there is no console to open', () => {
    assert.strictEqual(C.consoleCommand(BIN, 'freebsd', { DISPLAY: ':0' }), null);
  });
});

describe('opening it', () => {
  test('opened: the child is let go and the answer is ok', async () => {
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/example/claude', platform: 'darwin', spawn: f.spawn }), { ok: true });
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(f.calls[0].options, { detached: true, stdio: 'ignore' });
    assert.ok(f.calls[0].child.unrefed);
  });
  test('no claude: not found, and nothing is started', async () => {
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: null, platform: 'darwin', spawn: f.spawn }), { ok: false, reason: 'not-found' });
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: 'claude', platform: 'darwin', spawn: f.spawn }), { ok: false, reason: 'not-found' },
      'a bare name is what a failed lookup leaves, not a found binary');
    assert.strictEqual(f.calls.length, 0);
  });
  test('no console on this platform: unsupported, and nothing is started', async () => {
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/example/claude', platform: 'linux', env: {}, spawn: f.spawn }), { ok: false, reason: 'unsupported' });
    assert.strictEqual(f.calls.length, 0);
  });
  test('a start that fails, at once or a moment later, is a failure and never an unhandled error', async () => {
    for (const answer of ['error', 'throw']) {
      const f = fakeSpawn(answer);
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/example/claude', platform: 'darwin', spawn: f.spawn }), { ok: false, reason: 'failed' }, answer);
    }
  });
});

describe('checking the connection', () => {
  test('a turn that finishes is connected; one refused for its sign-in is not', async () => {
    const ok = fakeSpawn('close', { code: 0 });
    assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: ok.spawn, isAuthFailure }), { connected: true, known: true });
    assert.deepStrictEqual(ok.calls[0].args, ['--print', 'test', '--output-format', 'text'], 'the first-run check, unchanged');
    assert.deepStrictEqual(ok.calls[0].options.stdio, ['ignore', 'pipe', 'pipe'], 'what it says is read, so a failure can be told apart');
    const no = fakeSpawn('close', { code: 1, said: 'Invalid API key. Please run /login\n' });
    assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: no.spawn, isAuthFailure }), { connected: false, known: true });
  });

  test('a turn that fails for any other reason says it does not know', async () => {
    // A dropped connection or an overloaded service says nothing about the
    // sign-in, so it must not mark Claude Code signed out.
    for (const said of ['API Error: Connection error.\n', '']) {
      const f = fakeSpawn('close', { code: 1, said });
      assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: f.spawn, isAuthFailure }), { connected: false, known: false }, said);
    }
  });

  test('the check runs from the home folder, never from a temp folder another account can write to', async () => {
    // `--print` skips the trust prompt, so project settings and hooks in the
    // folder it runs in would run unasked. On Linux the temp folder is the
    // shared /tmp.
    const f = fakeSpawn('close', { code: 0 });
    await C.checkConnection({ bin: '/opt/example/claude', spawn: f.spawn, isAuthFailure });
    assert.strictEqual(f.calls[0].options.cwd, os.homedir());
    assert.notStrictEqual(f.calls[0].options.cwd, os.tmpdir());
  });

  test('a start that throws at once does not leave the one-at-a-time guard holding its answer', async () => {
    const thrown = fakeSpawn('throw');
    assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: thrown.spawn, isAuthFailure }), { connected: false, known: false });
    const next = fakeSpawn('close', { code: 0 });
    assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: next.spawn, isAuthFailure }), { connected: true, known: true },
      'the next check runs rather than being handed the failed one');
    assert.strictEqual(next.calls.length, 1);
  });
  test('a check that cannot run, or runs too long, says it does not know', async () => {
    const err = fakeSpawn('error');
    assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: err.spawn, isAuthFailure }), { connected: false, known: false });
    const slow = fakeSpawn('never');
    assert.deepStrictEqual(await C.checkConnection({ bin: '/opt/example/claude', spawn: slow.spawn, timeoutMs: 20, isAuthFailure }), { connected: false, known: false });
    assert.ok(slow.calls[0].child.killed, 'the check that ran too long is stopped');
  });
  test('one check at a time: a second ask while one runs gets the same answer', async () => {
    const f = fakeSpawn('close', { code: 0 });
    const [a, b] = await Promise.all([C.checkConnection({ bin: '/x/claude', spawn: f.spawn }), C.checkConnection({ bin: '/x/claude', spawn: f.spawn })]);
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(a, b);
  });
});
