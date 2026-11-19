'use strict';
// The console a person reconnects Claude Code in, and the check that says
// whether they have. Nothing here starts a real window or a real `claude`: a
// fake spawn stands in, and says what it was asked to start.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');

const C = require('../../lib/runtime/claude-console.js');

// A made-up home folder for each test that could write a console's script,
// so nothing here ever writes to the real one.
const made = [];
function madeUpHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-console-home-'));
  made.push(dir);
  return dir;
}
after(() => { for (const dir of made) fs.rmSync(dir, { recursive: true, force: true }); });
const scriptAt = (home) => path.join(home, '.rundock-console', 'Reconnect Claude.command');
const signinScriptAt = (home) => path.join(home, '.rundock-console', 'Sign in to Claude.command');
// Writing the macOS script takes POSIX file modes, owners and links.
const POSIX_ONLY = process.platform === 'win32' && 'file modes and links are POSIX here';
// A PATH holding a stand-in x-terminal-emulator, never run: the spawn is fake.
function terminalOnPath() {
  const dir = madeUpHome();
  fs.writeFileSync(path.join(dir, 'x-terminal-emulator'), '#!/bin/sh\n', { mode: 0o755 });
  return { DISPLAY: ':0', PATH: dir };
}

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
  // Both consoles, the first-run wizard's and the reconnect card's, run
  // Claude Code's own login command, `claude auth login`, which goes straight
  // to the browser: a bare `claude` asks first whether the home folder is
  // trusted, and with a refused session can start ready to chat and only say
  // "Please run /login" once a message is sent.
  const BIN = '/opt/example/bin/claude';
  const HOME = '/home/example';
  // A Claude Code that has `claude auth login`, as `claude --version` says it.
  const version = '2.1.309 (Claude Code)';
  const reconnect = { purpose: 'reconnect', home: HOME, version };
  test('macOS: the wizard\'s console opens Terminal on claude itself', () => {
    assert.deepStrictEqual(C.consoleCommand(BIN, 'darwin', {}), { command: 'open', args: ['-a', 'Terminal', BIN], options: {} });
  });
  test('macOS: the reconnect console opens Terminal on a script whose whole content runs claude auth login', () => {
    // Terminal runs a file it is given, never words after it, and driving it
    // by AppleScript raises an Automation prompt: so a script, of fixed words.
    const file = path.join(HOME, '.rundock-console', 'Reconnect Claude.command');
    assert.deepStrictEqual(C.consoleCommand(BIN, 'darwin', {}, reconnect), {
      command: 'open', args: ['-a', 'Terminal', file], options: {},
      script: { file, content: "#!/bin/sh\nexec '/opt/example/bin/claude' auth login\n" },
    });
  });
  test('macOS: a quote in the path is written so the shell reads the path as it is', () => {
    const c = C.consoleCommand("/opt/it's here/claude", 'darwin', {}, reconnect);
    assert.strictEqual(c.script.content, "#!/bin/sh\nexec '/opt/it'\\''s here/claude' auth login\n");
  });
  test('Windows opens a console that stays open, the path quoted for spaces and the words after it', () => {
    // cmd takes the first and last quote off what follows /k, which leaves
    // the path in its own quotes and the words outside them.
    const W = 'C:\\Program Files\\claude.exe';
    const signin = C.consoleCommand(W, 'win32', {});
    assert.deepStrictEqual(signin, { command: 'start "Sign in to Claude" cmd /k ""C:\\Program Files\\claude.exe""', args: [], options: { shell: true } });
    assert.deepStrictEqual(C.consoleCommand(W, 'win32', {}, reconnect), { command: 'start "Reconnect Claude" cmd /k ""C:\\Program Files\\claude.exe" auth login"', args: [], options: { shell: true } });
  });
  test('Linux needs a display and a terminal to open, and hands the terminal each word on its own', () => {
    // Debian policy for x-terminal-emulator: the words after -e are the
    // program's argument list, run as by execvp, never one string for a shell.
    const withTerminal = { DISPLAY: ':0', PATH: __dirname };
    const found = () => true;
    assert.strictEqual(C.consoleCommand(BIN, 'linux', { PATH: '/nowhere' }), null, 'no display');
    assert.strictEqual(C.consoleCommand(BIN, 'linux', { DISPLAY: ':0', PATH: '/nowhere' }), null, 'no terminal on the path');
    assert.deepStrictEqual(C.consoleCommand(BIN, 'linux', withTerminal, { found }),
      { command: 'x-terminal-emulator', args: ['-e', BIN], options: {} });
    assert.deepStrictEqual(C.consoleCommand(BIN, 'linux', withTerminal, { ...reconnect, found }),
      { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'], options: {} });
  });
  test('a purpose it does not know opens what the wizard opens', () => {
    const linux = { DISPLAY: ':0' };
    const found = () => true;
    for (const purpose of ['__proto__', 'constructor', 'toString', '" & calc & "', undefined]) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        assert.deepStrictEqual(C.consoleCommand(BIN, platform, linux, { found, purpose, home: HOME, version }),
          C.consoleCommand(BIN, platform, linux, { found, purpose: 'signin', home: HOME, version }), `${platform} ${String(purpose)}`);
      }
    }
  });
  test('a purpose it does not know opens the wizard\'s console as it is, claude auth login titled "Sign in to Claude" from Sign in to Claude.command, with nothing of the caller\'s in it', () => {
    const file = path.join(HOME, '.rundock-console', 'Sign in to Claude.command');
    const content = "#!/bin/sh\nexec '/opt/example/bin/claude' auth login\n";
    for (const purpose of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', '" & calc & "', '../../outside', 'Reconnect', null, 42, undefined]) {
      const opts = { found: () => true, purpose, home: HOME, version };
      const at = String(purpose);
      assert.deepStrictEqual(C.consoleCommand(BIN, 'darwin', {}, opts),
        { command: 'open', args: ['-a', 'Terminal', file], options: {}, script: { file, content } }, `darwin ${at}`);
      assert.deepStrictEqual(C.consoleCommand(BIN, 'win32', {}, opts),
        { command: 'start "Sign in to Claude" cmd /k ""/opt/example/bin/claude" auth login"', args: [], options: { shell: true } }, `win32 ${at}`);
      assert.deepStrictEqual(C.consoleCommand(BIN, 'linux', { DISPLAY: ':0' }, opts),
        { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'], options: {} }, `linux ${at}`);
    }
  });
  test('the reconnect console is as it was on every platform: its words, its title, and on macOS its script\'s name and content', () => {
    const file = path.join(HOME, '.rundock-console', 'Reconnect Claude.command');
    assert.deepStrictEqual(C.consoleCommand(BIN, 'darwin', {}, reconnect), {
      command: 'open', args: ['-a', 'Terminal', file], options: {},
      script: { file, content: "#!/bin/sh\nexec '/opt/example/bin/claude' auth login\n" },
    });
    assert.deepStrictEqual(C.consoleCommand(BIN, 'win32', {}, reconnect),
      { command: 'start "Reconnect Claude" cmd /k ""/opt/example/bin/claude" auth login"', args: [], options: { shell: true } });
    assert.deepStrictEqual(C.consoleCommand(BIN, 'linux', { DISPLAY: ':0' }, { ...reconnect, found: () => true }),
      { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'], options: {} });
  });
  test('anywhere else there is no console to open', () => {
    assert.strictEqual(C.consoleCommand(BIN, 'freebsd', { DISPLAY: ':0' }), null);
    assert.strictEqual(C.consoleCommand(BIN, 'freebsd', { DISPLAY: ':0' }, { ...reconnect, found: () => true }), null);
  });
});

describe('a Claude Code without its login command', () => {
  // `claude auth login` arrived in Claude Code 2.1.41 ("Added `claude auth
  // login`, `claude auth status`, and `claude auth logout` CLI subcommands").
  // The oldest Claude Code Rundock starts is older than that, so on an older
  // one, or one whose version is not known, both consoles run `claude` bare,
  // as before, rather than a command Claude Code does not have.
  const BIN = '/opt/example/bin/claude';
  const HOME = '/home/example';
  const env = { DISPLAY: ':0' };
  const found = () => true;
  const bare = (platform) => C.consoleCommand(BIN, platform, env, { found, home: HOME });
  const words = (platform, version) => C.consoleCommand(BIN, platform, env, { found, purpose: 'reconnect', home: HOME, version });
  test('the first version with it is 2.1.41', () => {
    assert.deepStrictEqual(C.AUTH_LOGIN_SINCE, [2, 1, 41]);
  });
  test('from 2.1.41 on, the reconnect console runs claude auth login', () => {
    for (const version of ['2.1.41', '2.1.41 (Claude Code)', '2.1.100', '2.1.309', '2.2.0', '3.0.0', '10.0.0']) {
      assert.deepStrictEqual(words('linux', version).args, ['-e', BIN, 'auth', 'login'], version);
      assert.match(words('win32', version).command, / auth login"$/, version);
      assert.ok(words('darwin', version).script, version);
    }
  });
  test('before 2.1.41, or with no version known, it runs claude bare, as the wizard\'s does then', () => {
    for (const version of ['2.1.40', '2.1.4', '2.0.99', '1.9.100', '0.2.21', null, undefined, '', 'unknown', '2.1', 'v', 42]) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const c = words(platform, version);
        assert.deepStrictEqual({ ...c, command: c.command.replace('"Reconnect Claude"', '"Sign in to Claude"') }, bare(platform), `${platform} ${String(version)}`);
      }
      assert.strictEqual(words('darwin', version).script, undefined, 'no script is written for a bare claude');
      assert.match(words('win32', version).command, /^start "Reconnect Claude" /, 'still the reconnect window');
    }
  });
  test('the wizard\'s console keeps the same rule: claude auth login from 2.1.41, claude bare before it or with no version known, and no script on macOS', () => {
    const wizard = (platform, version) => C.consoleCommand(BIN, platform, env, { found, purpose: 'signin', home: HOME, version });
    for (const version of ['2.1.41', '2.1.41 (Claude Code)', '2.1.309', '3.0.0']) {
      assert.deepStrictEqual(wizard('linux', version).args, ['-e', BIN, 'auth', 'login'], version);
      assert.strictEqual(wizard('win32', version).command, 'start "Sign in to Claude" cmd /k ""/opt/example/bin/claude" auth login"', version);
      assert.ok(wizard('darwin', version).script, version);
    }
    for (const version of ['2.1.40', '2.1.4', '2.0.99', '0.2.21', null, undefined, '', 'unknown', '2.1', 42]) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        assert.deepStrictEqual(wizard(platform, version), bare(platform), `${platform} ${String(version)}`);
      }
      assert.strictEqual(wizard('darwin', version).script, undefined, 'no script is written for a bare claude');
    }
  });
  test('the opener asks for the version once Claude Code is found, after the gate, and runs bare when it cannot tell', async () => {
    const opened = async (opts) => {
      const f = fakeSpawn('spawn');
      await C.openClaudeConsole({ bin: BIN, platform: 'linux', env: terminalOnPath(), spawn: f.spawn, purpose: 'reconnect', gate: C.consoleGate(), ...opts });
      return f.calls[0].args;
    };
    assert.deepStrictEqual(await opened({ version: '2.1.41' }), ['-e', BIN, 'auth', 'login']);
    assert.deepStrictEqual(await opened({ version: '2.1.40' }), ['-e', BIN]);
    assert.deepStrictEqual(await opened({ findVersion: () => '2.1.309 (Claude Code)' }), ['-e', BIN, 'auth', 'login']);
    assert.deepStrictEqual(await opened({ findVersion: () => { throw new Error('no answer'); } }), ['-e', BIN]);
    assert.deepStrictEqual(await opened({}), ['-e', BIN]);
    // Never during the pause, nor when there is no Claude Code to ask about.
    const gate = C.consoleGate();
    let asked = 0;
    const findVersion = () => { asked++; return '2.1.309'; };
    const f = fakeSpawn('spawn');
    await C.openClaudeConsole({ bin: BIN, platform: 'linux', env: terminalOnPath(), spawn: f.spawn, purpose: 'reconnect', gate, findVersion });
    await C.openClaudeConsole({ bin: BIN, platform: 'linux', env: terminalOnPath(), spawn: f.spawn, purpose: 'reconnect', gate, findVersion });
    await C.openClaudeConsole({ bin: null, platform: 'linux', env: terminalOnPath(), spawn: f.spawn, purpose: 'reconnect', gate: C.consoleGate(), findVersion });
    assert.strictEqual(asked, 1);
  });
  test('the server passes the version it already probed, and the desktop the one its lookup read', () => {
    const src = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.ok(src('server.js').includes("openClaudeConsole({ bin: resolveClaudeBin(), version: _claudeProbeCache && _claudeProbeCache.version, purpose: 'reconnect' })"));
    const main = src('electron/main.js');
    assert.ok(main.includes('openClaudeConsole({ findBin: findClaude, findVersion: () => claudeFoundVersion, purpose })'));
    assert.ok(main.includes('claudeFoundVersion = String(execSync(`"${bin}" --version`, { timeout: 10000 }));'));
  });
});

describe('what each console runs, as opened', () => {
  const BIN = '/opt/example/claude';
  const SCRIPT = "#!/bin/sh\nexec '/opt/example/claude' auth login\n";
  const version = '2.1.309';
  test('macOS: reconnecting writes the script first, then opens Terminal on it', async () => {
    const home = madeUpHome();
    const file = scriptAt(home);
    const f = fakeSpawn('spawn');
    let there = null;
    const spawn = (command, args, options) => { there = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null; return f.spawn(command, args, options); };
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform: 'darwin', spawn, purpose: 'reconnect', home, gate: C.consoleGate() }), { ok: true });
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(f.calls[0].command, 'open');
    assert.deepStrictEqual(f.calls[0].args, ['-a', 'Terminal', file]);
    assert.strictEqual(there, SCRIPT, 'the script is in place before Terminal is asked to open it');
  });
  test('macOS: the wizard\'s console writes Sign in to Claude.command first, then opens Terminal on it, and each console writes only its own script', { skip: POSIX_ONLY }, async () => {
    const opened = async (purpose, home) => {
      const f = fakeSpawn('spawn');
      let there = null;
      const dir = path.join(home, '.rundock-console');
      const spawn = (command, args, options) => {
        there = fs.existsSync(dir) ? fs.readdirSync(dir).sort().map((n) => [n, fs.readFileSync(path.join(dir, n), 'utf8')]) : null;
        return f.spawn(command, args, options);
      };
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform: 'darwin', spawn, purpose, home, gate: C.consoleGate() }), { ok: true });
      assert.strictEqual(f.calls.length, 1);
      return { command: f.calls[0].command, args: f.calls[0].args, there };
    };
    const home = madeUpHome();
    assert.deepStrictEqual(await opened('signin', home),
      { command: 'open', args: ['-a', 'Terminal', signinScriptAt(home)], there: [['Sign in to Claude.command', SCRIPT]] },
      'its own script, whole and in place before Terminal is asked to open it, and nothing else');
    const other = madeUpHome();
    assert.deepStrictEqual(await opened('reconnect', other),
      { command: 'open', args: ['-a', 'Terminal', scriptAt(other)], there: [['Reconnect Claude.command', SCRIPT]] },
      'the reconnect console writes only its own');
    // Both in one home: the reconnect console leaves the wizard's file as it is.
    const before = fs.statSync(signinScriptAt(home)).ino;
    await opened('reconnect', home);
    assert.strictEqual(fs.statSync(signinScriptAt(home)).ino, before);
    assert.deepStrictEqual(C.CONSOLE_SCRIPT_NAMES, { signin: 'Sign in to Claude.command', reconnect: 'Reconnect Claude.command' });
  });
  test('macOS: with no version known, the wizard\'s console runs claude itself and writes nothing', async () => {
    const home = madeUpHome();
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, home, gate: C.consoleGate() }), { ok: true });
    assert.deepStrictEqual(f.calls[0].args, ['-a', 'Terminal', BIN]);
    assert.deepStrictEqual(fs.readdirSync(home), []);
  });
  test('Windows and Linux: both consoles run claude auth login, the words outside the path\'s quotes on Windows and each its own argument on Linux', async () => {
    const env = terminalOnPath();
    const opened = async (platform, purpose) => {
      const f = fakeSpawn('spawn');
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform, env, spawn: f.spawn, purpose, gate: C.consoleGate() }), { ok: true });
      return { command: f.calls[0].command, args: f.calls[0].args };
    };
    assert.deepStrictEqual(await opened('win32', 'reconnect'), { command: 'start "Reconnect Claude" cmd /k ""/opt/example/claude" auth login"', args: [] });
    assert.deepStrictEqual(await opened('win32', 'signin'), { command: 'start "Sign in to Claude" cmd /k ""/opt/example/claude" auth login"', args: [] });
    assert.deepStrictEqual(await opened('linux', 'reconnect'), { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'] });
    assert.deepStrictEqual(await opened('linux', 'signin'), { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'] });
    assert.strictEqual(C.consoleCommand('C:\\Program Files\\claude.exe', 'win32', {}, { purpose: 'signin', version }).command,
      'start "Sign in to Claude" cmd /k ""C:\\Program Files\\claude.exe" auth login"', 'a path with a space keeps its own quotes');
  });
  test('before 2.1.41, or with no version known, both consoles open claude bare, and macOS writes no script', async () => {
    const env = terminalOnPath();
    for (const version of ['2.1.40', null, 'unknown']) {
      for (const purpose of ['signin', 'reconnect']) {
        const title = purpose === 'signin' ? 'Sign in to Claude' : 'Reconnect Claude';
        const opened = async (platform, home) => {
          const f = fakeSpawn('spawn');
          assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform, env, spawn: f.spawn, purpose, home, gate: C.consoleGate() }), { ok: true });
          return { command: f.calls[0].command, args: f.calls[0].args };
        };
        const home = madeUpHome();
        const at = `${purpose} ${String(version)}`;
        assert.deepStrictEqual(await opened('darwin', home), { command: 'open', args: ['-a', 'Terminal', BIN] }, at);
        assert.deepStrictEqual(fs.readdirSync(home), [], `${at}: no script folder and no script`);
        assert.deepStrictEqual(await opened('win32'), { command: `start "${title}" cmd /k ""/opt/example/claude""`, args: [] }, at);
        assert.deepStrictEqual(await opened('linux'), { command: 'x-terminal-emulator', args: ['-e', BIN] }, at);
      }
    }
  });
  test('the wizard\'s console asked again: nothing more opens during the pause, and once it is over the script is replaced, never written through', { skip: POSIX_ONLY }, async () => {
    // No purpose, as the desktop's setup screen asks.
    const home = madeUpHome();
    const file = signinScriptAt(home);
    const gate = C.consoleGate();
    let t = 1000;
    const now = () => t;
    const f = fakeSpawn('spawn');
    const open = () => C.openClaudeConsole({ bin: BIN, version, platform: 'darwin', spawn: f.spawn, home, gate, now });
    assert.deepStrictEqual(await open(), { ok: true });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), SCRIPT);
    // The file is changed in place, and a second name kept for it: a write
    // through it would show at that second name.
    fs.writeFileSync(file, 'an older script\n');
    const second = path.join(home, 'second-name.command');
    fs.linkSync(file, second);
    t += C.OPEN_COOLDOWN_MS - 1;
    assert.deepStrictEqual(await open(), { ok: true }, 'the window that just opened is the answer');
    assert.strictEqual(f.calls.length, 1);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), 'an older script\n', 'nothing is written during the pause');
    t += 2;
    assert.deepStrictEqual(await open(), { ok: true });
    assert.strictEqual(f.calls.length, 2, 'it opens again once the pause is over');
    assert.deepStrictEqual(f.calls[1].args, ['-a', 'Terminal', file]);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), SCRIPT);
    assert.strictEqual(fs.readFileSync(second, 'utf8'), 'an older script\n', 'the old file was replaced, not written through');
  });
  test('the setup screen\'s Sign in to Claude reaches the wizard\'s console through the desktop, with no purpose and the version its lookup read, and runs claude auth login', async () => {
    const src = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.ok(src('electron/wizard.html').includes('const res = await window.electronAPI.signInClaude();'));
    assert.ok(src('electron/preload.js').includes("signInClaude: () => ipcRenderer.invoke('wizard-signin-claude'),"));
    const main = src('electron/main.js');
    assert.ok(main.includes("ipcMain.handle('wizard-signin-claude', () => launchClaudeSignIn());"));
    assert.ok(main.includes('openClaudeConsole({ findBin: findClaude, findVersion: () => claudeFoundVersion, purpose })'));
    // What that call opens, with a lookup and a version as the desktop has them.
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ findBin: () => BIN, findVersion: () => '2.1.309 (Claude Code)\n', purpose: undefined,
      platform: 'linux', env: terminalOnPath(), spawn: f.spawn, gate: C.consoleGate() }), { ok: true });
    assert.deepStrictEqual(f.calls[0].args, ['-e', BIN, 'auth', 'login']);
  });
  test('the wizard\'s script that cannot be written, its folder a link or another account\'s, is a failure: nothing opens, and the setup screen says it could not start', { skip: POSIX_ONLY }, async (t) => {
    const f = fakeSpawn('spawn');
    const home = madeUpHome();
    const elsewhere = madeUpHome();
    fs.symlinkSync(elsewhere, path.join(home, '.rundock-console'));
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform: 'darwin', spawn: f.spawn, home, gate: C.consoleGate() }), { ok: false, reason: 'failed' }, 'a link');
    assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'nothing is written where the link points');
    // A folder this account made, as seen by a process running as another.
    const owned = madeUpHome();
    fs.mkdirSync(path.join(owned, '.rundock-console'), { mode: 0o700 });
    const uid = process.getuid();
    t.mock.method(process, 'getuid', () => uid + 1);
    try {
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform: 'darwin', spawn: f.spawn, home: owned, gate: C.consoleGate() }), { ok: false, reason: 'failed' }, 'another account\'s');
    } finally { t.mock.restoreAll(); }
    assert.deepStrictEqual(fs.readdirSync(path.join(owned, '.rundock-console')), []);
    assert.strictEqual(f.calls.length, 0);
    const wizard = fs.readFileSync(path.join(__dirname, '..', '..', 'electron', 'wizard.html'), 'utf8');
    assert.ok(wizard.includes("failed: 'Something stopped it opening.',") && wizard.includes("('Could not start sign-in: ' + why)"));
  });
  test('a script that cannot be written is a failure, and nothing is opened', async () => {
    const home = madeUpHome();
    fs.symlinkSync(madeUpHome(), path.join(home, '.rundock-console'));
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version, platform: 'darwin', spawn: f.spawn, purpose: 'reconnect', home, gate: C.consoleGate() }), { ok: false, reason: 'failed' });
    assert.strictEqual(f.calls.length, 0);
  });
  test('a path holding a line break or NUL opens nothing on any platform: the steps to run instead', async () => {
    // It would end the line it is written into, the script's or cmd's, and
    // start another. Unsupported rather than failed: trying again cannot work,
    // so the card shows the step to run by hand.
    const env = terminalOnPath();
    for (const bad of ['/opt/example/cla\nude', '/opt/example/cla\rude', '/opt/example/cla\0ude']) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const home = madeUpHome();
        const f = fakeSpawn('spawn');
        assert.deepStrictEqual(await C.openClaudeConsole({ bin: bad, version, platform, env, spawn: f.spawn, purpose: 'reconnect', home, gate: C.consoleGate() }),
          { ok: false, reason: 'unsupported' }, `${platform} ${JSON.stringify(bad)}`);
        assert.strictEqual(f.calls.length, 0);
        assert.deepStrictEqual(fs.readdirSync(home), []);
      }
    }
  });
  test('Windows: a path holding &, ^ or % opens nothing, for either console: the steps to run instead', async () => {
    // The doubled quotes leave the path outside the outer cmd's quotes, where
    // & ends the command, ^ escapes and % expands: a profile such as
    // C:\Users\R&D would split the command in two.
    for (const bad of ['C:\\Users\\R&D\\.local\\bin\\claude.exe', 'C:\\Users\\a^b\\claude.exe', 'C:\\Users\\100%\\claude.exe', 'C:\\x\\%PATH%\\claude.exe']) {
      for (const purpose of ['reconnect', 'signin']) {
        assert.strictEqual(C.consoleCommand(bad, 'win32', {}, { purpose, version }), null, `${purpose} ${bad}`);
      }
    }
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/R&D/claude', version, platform: 'win32', spawn: f.spawn, purpose: 'reconnect', gate: C.consoleGate() }), { ok: false, reason: 'unsupported' });
    assert.deepStrictEqual(await C.openClaudeConsole({ bin: '/opt/R&D/claude', version, platform: 'win32', spawn: f.spawn, gate: C.consoleGate() }), { ok: false, reason: 'unsupported' });
    assert.strictEqual(f.calls.length, 0);
  });
  test('the wizard\'s console with its login words opens nothing for a path holding a line break or NUL, nor on Windows for one holding &, ^ or %', async () => {
    const env = terminalOnPath();
    const f = fakeSpawn('spawn');
    for (const bad of ['/opt/example/cla\nude', '/opt/example/cla\rude', '/opt/example/cla\0ude']) {
      for (const platform of ['darwin', 'win32', 'linux']) {
        const home = madeUpHome();
        assert.deepStrictEqual(await C.openClaudeConsole({ bin: bad, version, platform, env, spawn: f.spawn, purpose: 'signin', home, gate: C.consoleGate() }),
          { ok: false, reason: 'unsupported' }, `${platform} ${JSON.stringify(bad)}`);
        assert.deepStrictEqual(fs.readdirSync(home), []);
      }
    }
    for (const bad of ['/opt/R&D/claude', '/opt/a^b/claude', '/opt/100%/claude', '/opt/%PATH%/claude']) {
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: bad, version, platform: 'win32', spawn: f.spawn, purpose: 'signin', gate: C.consoleGate() }),
        { ok: false, reason: 'unsupported' }, bad);
    }
    assert.strictEqual(f.calls.length, 0);
  });
  test('elsewhere those characters are only part of the path: Linux hands it over as one word, and the macOS script quotes it', () => {
    const odd = '/opt/R&D 100%/^/claude';
    assert.deepStrictEqual(C.consoleCommand(odd, 'linux', { DISPLAY: ':0' }, { found: () => true, purpose: 'reconnect', version }).args, ['-e', odd, 'auth', 'login']);
    assert.strictEqual(C.consoleCommand(odd, 'darwin', {}, { purpose: 'reconnect', version, home: '/home/example' }).script.content,
      "#!/bin/sh\nexec '/opt/R&D 100%/^/claude' auth login\n");
  });
});

describe('the script macOS\'s Terminal is opened on', { skip: process.platform === 'win32' && 'file modes and links are POSIX here' }, () => {
  const CONTENT = "#!/bin/sh\nexec '/opt/example/claude' auth login\n";
  const mode = (p) => fs.lstatSync(p).mode & 0o777;
  test('written new: exactly its two lines, in a folder and a file only this account can use', () => {
    const file = scriptAt(madeUpHome());
    C.writeConsoleScript(file, CONTENT);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), CONTENT);
    assert.ok(fs.lstatSync(file).isFile());
    assert.strictEqual(mode(path.dirname(file)), 0o700);
    assert.strictEqual(mode(file), 0o700);
  });
  test('the folder is made closed, never made open and closed after', () => {
    const file = scriptAt(madeUpHome());
    const mkdir = fs.mkdirSync;
    const asked = [];
    fs.mkdirSync = (p, o) => { asked.push(o && o.mode); return mkdir(p, o); };
    try { C.writeConsoleScript(file, CONTENT); } finally { fs.mkdirSync = mkdir; }
    assert.deepStrictEqual(asked, [0o700]);
  });
  test('a umask that clears even the user bits still leaves the folder and the file 0700', () => {
    const file = scriptAt(madeUpHome());
    const was = process.umask(0o177);
    try { C.writeConsoleScript(file, CONTENT); } finally { process.umask(was); }
    assert.strictEqual(mode(path.dirname(file)), 0o700);
    assert.strictEqual(mode(file), 0o700);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), CONTENT);
  });
  test('a folder left open to others is closed again before anything is written', () => {
    const file = scriptAt(madeUpHome());
    fs.mkdirSync(path.dirname(file));
    fs.chmodSync(path.dirname(file), 0o777);
    C.writeConsoleScript(file, CONTENT);
    assert.strictEqual(mode(path.dirname(file)), 0o700);
  });
  test('a leftover script is replaced', () => {
    const file = scriptAt(madeUpHome());
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.writeFileSync(file, 'an older script, longer than the new one is, by some way\n');
    fs.chmodSync(file, 0o644);
    C.writeConsoleScript(file, CONTENT);
    assert.strictEqual(fs.readFileSync(file, 'utf8'), CONTENT);
    assert.strictEqual(mode(file), 0o700);
  });
  test('a link planted at the script\'s path is replaced, never followed', () => {
    for (const to of ['a file', 'nowhere']) {
      const home = madeUpHome();
      const file = scriptAt(home);
      const target = path.join(home, to === 'a file' ? 'outside.txt' : path.join('missing', 'outside.txt'));
      if (to === 'a file') fs.writeFileSync(target, 'untouched');
      fs.mkdirSync(path.dirname(file), { mode: 0o700 });
      fs.symlinkSync(target, file);
      C.writeConsoleScript(file, CONTENT);
      assert.ok(!fs.lstatSync(file).isSymbolicLink() && fs.lstatSync(file).isFile(), to);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), CONTENT, to);
      if (to === 'a file') assert.strictEqual(fs.readFileSync(target, 'utf8'), 'untouched');
      else assert.strictEqual(fs.existsSync(path.dirname(target)), false, 'nothing made where the link pointed');
    }
  });
  test('a file or a link that appears once the leftover is gone is refused, never written through', () => {
    // Made only by exclusive create: an existing path, a link included, fails.
    for (const plant of ['file', 'link']) {
      const home = madeUpHome();
      const file = scriptAt(home);
      const outside = path.join(home, 'outside.txt');
      fs.writeFileSync(outside, 'untouched');
      const unlink = fs.unlinkSync;
      fs.unlinkSync = (p) => {
        try { return unlink(p); } finally { if (plant === 'file') fs.writeFileSync(p, 'planted'); else fs.symlinkSync(outside, p); }
      };
      try {
        assert.throws(() => C.writeConsoleScript(file, CONTENT), { code: 'EEXIST' }, plant);
      } finally { fs.unlinkSync = unlink; }
      assert.strictEqual(fs.readFileSync(outside, 'utf8'), 'untouched', plant);
      if (plant === 'file') assert.strictEqual(fs.readFileSync(file, 'utf8'), 'planted');
    }
  });
  test('a folder that is a link is refused, and nothing is written or changed where it points', () => {
    const home = madeUpHome();
    const file = scriptAt(home);
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.chmodSync(elsewhere, 0o755);
    fs.symlinkSync(elsewhere, path.dirname(file));
    assert.throws(() => C.writeConsoleScript(file, CONTENT));
    assert.deepStrictEqual(fs.readdirSync(elsewhere), []);
    assert.strictEqual(mode(elsewhere), 0o755);
  });
  test('a folder another account owns is refused', () => {
    const file = scriptAt(madeUpHome());
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    assert.throws(() => C.writeConsoleScript(file, CONTENT, { uid: process.getuid() + 1 }));
    assert.strictEqual(fs.existsSync(file), false);
  });

  // One write call may take fewer bytes than it is handed (a nearly full
  // drive, a limit on file size), and the count it returns is the only sign.
  // Terminal runs whatever the file holds, so a script cut short would run
  // half a command. Here the system call is swapped for one that really
  // writes at most `most` bytes of what it is handed, at the position it was
  // asked for. A runaway loop is stopped with an error of its own rather
  // than left to hang the suite, and the standard streams pass straight
  // through.
  const realWriteSync = fs.writeSync;
  function writesAtMost(most) {
    const stub = function writeSync(fd, buffer, offset, length, position) {
      if (fd <= 2) return realWriteSync.apply(fs, arguments);
      stub.calls += 1;
      if (stub.calls > 1000) throw new Error('the write was tried over a thousand times');
      // Either shape fs.writeSync takes: a string with its position and
      // encoding, or a buffer with an offset, a length and a position.
      const text = typeof buffer === 'string';
      const bytes = text
        ? Buffer.from(buffer, typeof length === 'string' ? length : 'utf8')
        : buffer.subarray(offset || 0, length == null ? buffer.length : (offset || 0) + length);
      return realWriteSync(fd, bytes, 0, Math.min(most, bytes.length), text ? offset : position);
    };
    stub.calls = 0;
    return stub;
  }
  test('a write the system takes a few bytes at a time still leaves the whole script', (t) => {
    // A character of two bytes in the path, so a cut can land inside one.
    const whole = "#!/bin/sh\nexec '/opt/café tools/claude' auth login\n";
    const file = scriptAt(madeUpHome());
    const stub = writesAtMost(5);
    t.mock.method(fs, 'writeSync', stub);
    C.writeConsoleScript(file, whole);
    t.mock.restoreAll();
    assert.ok(stub.calls > 2, `the write was cut short more than once (${stub.calls} calls)`);
    assert.ok(fs.readFileSync(file).equals(Buffer.from(whole, 'utf8')), 'every byte of the script is on disk');
    assert.strictEqual(mode(file), 0o700);
  });
  test('a write that takes nothing fails the script rather than leaving it short or trying forever', (t) => {
    const file = scriptAt(madeUpHome());
    t.mock.method(fs, 'writeSync', writesAtMost(0));
    try {
      assert.throws(() => C.writeConsoleScript(file, CONTENT), { code: 'EIO' });
    } finally { t.mock.restoreAll(); }
  });
});

describe('the wizard\'s script, Sign in to Claude.command, as the opener writes it', { skip: POSIX_ONLY }, () => {
  const BIN = '/opt/example/claude';
  const SCRIPT = "#!/bin/sh\nexec '/opt/example/claude' auth login\n";
  const open = (home, f) => C.openClaudeConsole({ bin: BIN, version: '2.1.309', platform: 'darwin', spawn: f.spawn, purpose: 'signin', home, gate: C.consoleGate() });
  test('a leftover is replaced by exactly the script, closed to everyone else', async () => {
    const home = madeUpHome();
    const file = signinScriptAt(home);
    fs.mkdirSync(path.dirname(file), { mode: 0o700 });
    fs.writeFileSync(file, 'an older script, longer than the new one is, by some way\n');
    fs.chmodSync(file, 0o644);
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await open(home, f), { ok: true });
    assert.strictEqual(fs.readFileSync(file, 'utf8'), SCRIPT);
    assert.strictEqual(fs.lstatSync(file).mode & 0o777, 0o700);
  });
  test('a link planted at its path is replaced, never followed', async () => {
    for (const to of ['a file', 'nowhere']) {
      const home = madeUpHome();
      const file = signinScriptAt(home);
      const target = path.join(home, to === 'a file' ? 'outside.txt' : path.join('missing', 'outside.txt'));
      if (to === 'a file') fs.writeFileSync(target, 'untouched');
      fs.mkdirSync(path.dirname(file), { mode: 0o700 });
      fs.symlinkSync(target, file);
      const f = fakeSpawn('spawn');
      assert.deepStrictEqual(await open(home, f), { ok: true }, to);
      assert.ok(!fs.lstatSync(file).isSymbolicLink() && fs.lstatSync(file).isFile(), to);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), SCRIPT, to);
      if (to === 'a file') assert.strictEqual(fs.readFileSync(target, 'utf8'), 'untouched');
      else assert.strictEqual(fs.existsSync(path.dirname(target)), false, 'nothing made where the link pointed');
    }
  });
  test('one that cannot be written, a folder standing at its path, is a failure and nothing opens', async () => {
    const home = madeUpHome();
    const file = signinScriptAt(home);
    fs.mkdirSync(file, { recursive: true });
    fs.writeFileSync(path.join(file, 'inside.txt'), 'untouched');
    const f = fakeSpawn('spawn');
    assert.deepStrictEqual(await open(home, f), { ok: false, reason: 'failed' });
    assert.strictEqual(f.calls.length, 0);
    assert.strictEqual(fs.readFileSync(path.join(file, 'inside.txt'), 'utf8'), 'untouched');
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
    assert.match(main, /openClaudeConsole\(\{ findBin: findClaude, findVersion: \(\) => claudeFoundVersion, purpose \}\)/);
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
    // The reconnect console's script goes to a made-up home.
    const f = fakeSpawn('spawn');
    const home = madeUpHome();
    const [a, b] = await Promise.all([
      C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, purpose: 'reconnect', home }),
      C.openClaudeConsole({ bin: BIN, platform: 'darwin', spawn: f.spawn, home }),
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
    const reconnect = C.consoleCommand(BIN, 'win32', {}, { purpose: 'reconnect' }).command;
    const signin = C.consoleCommand(BIN, 'win32', {}).command;
    assert.ok(reconnect.startsWith('start "Reconnect Claude" cmd /k '), reconnect);
    assert.ok(signin.startsWith('start "Sign in to Claude" cmd /k '), signin);
    assert.deepStrictEqual(C.CONSOLE_TITLES, { signin: 'Sign in to Claude', reconnect: 'Reconnect Claude' });
  });

  // The opener checks the path is absolute where it runs, so these use one
  // that is absolute here; only the title is under test.
  const HERE = '/opt/example/claude';
  test('the card\'s console asks for "Reconnect Claude" from the server and from the desktop app alike', async () => {
    const f = fakeSpawn('spawn');
    await C.openClaudeConsole({ bin: HERE, platform: 'win32', spawn: f.spawn, purpose: 'reconnect', gate: C.consoleGate() });
    assert.match(f.calls[0].command, /^start "Reconnect Claude" /);
    const src = (file) => require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', file), 'utf8');
    assert.match(src('server.js'), /openClaudeConsole\(\{ bin: resolveClaudeBin\(\), version: [^}]*, purpose: 'reconnect' \}\)/);
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
