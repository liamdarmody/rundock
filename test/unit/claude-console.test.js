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
  // Each test opens through a gate of its own, so one test's console is not
  // another's "opened a moment ago".
  test('opened: the child is let go and the answer is ok', async () => {
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/example/claude', platform: 'darwin', spawn: f.spawn, gate: C.consoleGate() }), { ok: true });
    assert.strictEqual(f.calls.length, 1);
    assert.deepStrictEqual(f.calls[0].options, { detached: true, stdio: 'ignore' });
    assert.ok(f.calls[0].child.unrefed);
  });
  test('no claude: not found, and nothing is started', async () => {
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: null, platform: 'darwin', spawn: f.spawn, gate: C.consoleGate() }), { ok: false, reason: 'not-found' });
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: 'claude', platform: 'darwin', spawn: f.spawn, gate: C.consoleGate() }), { ok: false, reason: 'not-found' },
      'a bare name is what a failed lookup leaves, not a found binary');
    assert.strictEqual(f.calls.length, 0);
  });
  test('no console on this platform: unsupported, and nothing is started', async () => {
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/example/claude', platform: 'linux', env: {}, spawn: f.spawn, gate: C.consoleGate() }), { ok: false, reason: 'unsupported' });
    assert.strictEqual(f.calls.length, 0);
  });
  test('a start that fails, at once or a moment later, is a failure and never an unhandled error', async () => {
    for (const answer of ['error', 'throw']) {
      const f = fakeSpawn(answer);
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/example/claude', platform: 'darwin', spawn: f.spawn, gate: C.consoleGate() }), { ok: false, reason: 'failed' }, answer);
    }
  });
});

describe('how many consoles open', () => {
  const BIN = '/opt/example/claude';
  test('ten asks at once open one console, and every ask is answered', async () => {
    const f = fakeSpawn('spawn');
    const gate = C.consoleGate();
    const answers = await Promise.all(Array.from({ length: 10 }, () => C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, gate })));
    assert.strictEqual(f.calls.length, 1);
    for (const a of answers) assert.deepStrictEqual(a, { ok: true });
  });

  test('an ask straight after one opened opens nothing more, and one after the pause opens again', async () => {
    const f = fakeSpawn('spawn');
    const gate = C.consoleGate();
    let t = 1000;
    const now = () => t;
    await C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, gate, now });
    t += C.OPEN_COOLDOWN_MS - 1;
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, gate, now }), { ok: true }, 'the window that just opened is the answer');
    assert.strictEqual(f.calls.length, 1);
    t += 2;
    await C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, gate, now });
    assert.strictEqual(f.calls.length, 2, '"Open the window again" still works once the pause is over');
  });

  test('an ask while one opens, or during the pause, does not look for Claude Code again', async () => {
    // On the desktop, looking for Claude Code runs a command on the main
    // process, so the gate is asked first.
    const f = fakeSpawn('spawn');
    const gate = C.consoleGate();
    let t = 1000;
    const now = () => t;
    let looked = 0;
    const findBin = () => { looked++; return BIN; };
    await Promise.all(Array.from({ length: 5 }, () => C.openClaudeConsole({ findBin, platform: 'darwin', spawn: f.spawn, gate, now })));
    assert.strictEqual(looked, 1, 'once for five asks at once');
    t += 100;
    await C.openClaudeConsole({ findBin, platform: 'darwin', spawn: f.spawn, gate, now });
    assert.strictEqual(looked, 1, 'not at all during the pause');
    t += C.OPEN_COOLDOWN_MS;
    await C.openClaudeConsole({ findBin, platform: 'darwin', spawn: f.spawn, gate, now });
    assert.strictEqual(looked, 2, 'and again once the pause is over');
    assert.strictEqual(f.calls.length, 2);
  });

  test('a lookup that finds nothing, or throws, is not found', async () => {
    for (const findBin of [() => null, () => { throw new Error('lookup failed'); }]) {
      const f = fakeSpawn('spawn');
      assert.deepStrictEqual(await C.openClaudeConsole({ findBin, platform: 'darwin', spawn: f.spawn, gate: C.consoleGate() }), { ok: false, reason: 'not-found' });
      assert.strictEqual(f.calls.length, 0);
    }
  });

  test('the desktop app hands the opener its lookup rather than its answer', () => {
    const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
    assert.match(main, /openClaudeConsole\(\{ findBin: findClaude, purpose \}\)/);
    assert.doesNotMatch(main, /openClaudeConsole\(\{ bin: findClaude\(\)/);
  });

  test('a console that failed to open does not hold back the next try', async () => {
    const gate = C.consoleGate();
    const bad = fakeSpawn('error');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: bad.spawn, gate }), { ok: false, reason: 'failed' });
    const good = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: good.spawn, gate }), { ok: true });
    assert.strictEqual(good.calls.length, 1);
  });

  test('the server\'s route and the desktop\'s channel open through the one shared gate', async () => {
    // Neither caller passes a gate of its own, so both share the module's.
    const f = fakeSpawn('spawn');
    const [a, b] = await Promise.all([
      C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, purpose: 'reconnect' }),
      C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn }),
    ]);
    assert.deepStrictEqual([a, b], [{ ok: true }, { ok: true }]);
    assert.strictEqual(f.calls.length, 1);
    const src = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', file), 'utf8');
    assert.doesNotMatch(src('server.js'), /openClaudeConsole\(\{[^}]*gate:/, 'the server passes no gate of its own');
    assert.doesNotMatch(src('electron/main.js'), /openClaudeConsole\(\{[^}]*gate:/, 'nor does the desktop app');
  });
});

describe('what the console is called', () => {
  const BIN = 'C:\\Program Files\\claude.exe';
  test('opened from the reconnect card it is "Reconnect Claude"; the first-run wizard keeps its own', () => {
    assert.strictEqual(C.consoleCommand(BIN, 'win32', {}, undefined, C.CONSOLE_TITLES.reconnect).command, 'start "Reconnect Claude" cmd /k ""C:\\Program Files\\claude.exe""');
    assert.strictEqual(C.consoleCommand(BIN, 'win32', {}).command, 'start "Sign in to Claude" cmd /k ""C:\\Program Files\\claude.exe""');
  });

  // The opener checks the path is absolute where it runs, so these use one
  // that is absolute here; only the title is under test.
  const HERE = '/opt/example/claude';
  test('the card\'s console asks for "Reconnect Claude" from the server and from the desktop app alike', async () => {
    const f = fakeSpawn('spawn');
    await C.openClaudeConsole({ bin: HERE, platform: 'win32', spawn: f.spawn, purpose: 'reconnect', gate: C.consoleGate() });
    assert.match(f.calls[0].command, /^start "Reconnect Claude" /);
    const src = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', file), 'utf8');
    assert.match(src('server.js'), /openClaudeConsole\(\{ bin: resolveClaudeBin\(\), purpose: 'reconnect' \}\)/);
    assert.match(src('electron/main.js'), /launchClaudeSignIn\('reconnect'\)/);
  });

  test('a purpose it does not know is the wizard\'s title, never text from the caller', async () => {
    const f = fakeSpawn('spawn');
    await C.openClaudeConsole({ bin: HERE, platform: 'win32', spawn: f.spawn, purpose: '" & calc & "', gate: C.consoleGate() });
    assert.match(f.calls[0].command, /^start "Sign in to Claude" /);
  });
});

describe('the desktop channel answers only the main window\'s own page', () => {
  const frame = { name: 'main' };
  const sub = { name: 'sub' };
  const contents = { mainFrame: frame };
  const win = { webContents: contents };
  test('its own top frame is let in; a frame inside it, another window and no window are not', () => {
    assert.strictEqual(C.fromMainFrame({ sender: contents, senderFrame: frame }, win), true);
    assert.strictEqual(C.fromMainFrame({ sender: contents, senderFrame: sub }, win), false, 'a subframe the window hosts');
    assert.strictEqual(C.fromMainFrame({ sender: contents }, win), false, 'a sender with no frame');
    assert.strictEqual(C.fromMainFrame({ sender: { mainFrame: frame }, senderFrame: frame }, win), false, 'another webContents');
    assert.strictEqual(C.fromMainFrame({ sender: contents, senderFrame: frame }, null), false, 'no main window');
  });
  test('the channel asks it', () => {
    const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
    const at = main.indexOf("ipcMain.handle('claude-reconnect'");
    assert.ok(at > 0);
    assert.match(main.slice(at, at + 300), /fromMainFrame\(event, mainWindow\)/);
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
