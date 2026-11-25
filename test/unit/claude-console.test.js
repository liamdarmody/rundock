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
const { createRequire } = require('node:module');
const { JSDOM } = require('jsdom');

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
  test('the server passes the version it already probed, and the desktop the one its last setup check read', () => {
    const src = (file) => fs.readFileSync(path.join(__dirname, '..', '..', file), 'utf8');
    assert.ok(src('server.js').includes("openClaudeConsole({ bin: resolveClaudeBin(), version: _claudeProbeCache && _claudeProbeCache.version, purpose: 'reconnect' })"));
    const main = src('electron/main.js');
    assert.ok(main.includes('openClaudeConsole({ findBin: () => setupCheck.found().bin, findVersion: () => setupCheck.found().version, purpose })'));
    const check = src('electron/setup-check.js');
    assert.ok(check.includes("version = stdout.toString('utf8');"));
    assert.ok(check.includes('found = { bin, version };'));
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
  test('macOS: a purpose that is not a string, even one that reads as "reconnect", writes and opens Sign in to Claude.command, titled "Sign in to Claude"; only the exact words choose the reconnect console', { skip: POSIX_ONLY }, async () => {
    const opened = async (purpose) => {
      const home = madeUpHome();
      const f = fakeSpawn('spawn');
      assert.deepStrictEqual(await C.openClaudeConsole({ bin: BIN, version: '2.1.41', platform: 'darwin', spawn: f.spawn, purpose, home, gate: C.consoleGate() }), { ok: true });
      assert.strictEqual(f.calls.length, 1);
      const titled = fakeSpawn('spawn');
      await C.openClaudeConsole({ bin: BIN, version: '2.1.41', platform: 'win32', spawn: titled.spawn, purpose, gate: C.consoleGate() });
      return {
        args: f.calls[0].args,
        written: fs.readdirSync(path.join(home, '.rundock-console')),
        title: /^start "([^"]*)" /.exec(titled.calls[0].command)[1],
        home,
      };
    };
    const reads = { toString: () => 'reconnect' };
    for (const [purpose, at] of [[['reconnect'], "['reconnect']"], [reads, "an object whose toString gives 'reconnect'"], [new String('reconnect'), "new String('reconnect')"]]) {
      const { args, written, title, home } = await opened(purpose);
      assert.deepStrictEqual({ args, written, title },
        { args: ['-a', 'Terminal', signinScriptAt(home)], written: ['Sign in to Claude.command'], title: 'Sign in to Claude' }, at);
    }
    const reconnect = await opened('reconnect');
    assert.deepStrictEqual({ args: reconnect.args, written: reconnect.written, title: reconnect.title },
      { args: ['-a', 'Terminal', scriptAt(reconnect.home)], written: ['Reconnect Claude.command'], title: 'Reconnect Claude' }, "'reconnect'");
    const signin = await opened('signin');
    assert.deepStrictEqual({ args: signin.args, written: signin.written, title: signin.title },
      { args: ['-a', 'Terminal', signinScriptAt(signin.home)], written: ['Sign in to Claude.command'], title: 'Sign in to Claude' }, "'signin'");
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
  // The setup screen's Sign in to Claude, end to end on the desktop:
  // wizard.html in JSDOM, preload.js's checkRuntimes and signInClaude,
  // main.js's channels for them, its setup check and launchClaudeSignIn, then
  // the real opener. main.js and preload.js cannot be loaded outside Electron,
  // so those lines are cut from their source by name, failing loudly when one
  // is renamed or lost, and run together with the real setup check and
  // stand-ins only for what they reach outside: the children the check
  // starts, and the IPC between the two processes. The require main.js's
  // lines are given returns the real opener with this test's seams added, and
  // records what it was asked and what it answered. Nothing real is ever
  // spawned.
  const ELECTRON = path.join(__dirname, '..', '..', 'electron');
  const piece = (file, pattern, what) => {
    const found = pattern.exec(fs.readFileSync(path.join(ELECTRON, file), 'utf8'));
    assert.ok(found, `electron/${file} no longer carries ${what}`);
    return found;
  };
  const { loadSetupCheck, answerChildren, claudeAt, VERSION } = require('../helpers/setup-check-children.js');
  function setupScreen(t, { platform, env, home, claude: answers = {} }) {
    const asked = [];
    const answered = [];
    const f = fakeSpawn('spawn');
    const gate = C.consoleGate();
    const mainRequire = createRequire(path.join(ELECTRON, 'main.js'));
    const opener = require.resolve('../../lib/runtime/claude-console.js');
    const setupCheck = path.join(ELECTRON, 'setup-check.js');
    const requireForMain = (id) => {
      if (mainRequire.resolve(id) === setupCheck) return mainRequire(id);
      assert.strictEqual(mainRequire.resolve(id), opener, `main.js's lines asked for ${id}`);
      return {
        ...C,
        openClaudeConsole: (opts) => {
          asked.push(opts);
          return C.openClaudeConsole({ ...opts, platform, env, spawn: f.spawn, gate, home })
            .then((answer) => { answered.push(answer); return answer; });
        },
      };
    };
    // How the stand-in Claude Code answers each child the setup check starts,
    // read when each starts. It is found, starts and is not signed in, unless
    // `answers` says otherwise for the check the page runs when it loads.
    const claude = { ...answers };
    const ran = answerChildren(t, claudeAt(BIN, claude));
    const handlers = new Map();
    const ipcMain = { handle: (channel, handler) => { handlers.set(channel, handler); } };
    const { createSignInReason } = require('../../electron/sign-in-reason.js');
    new Function('require', 'process', 'app', 'shellConfigDir', 'signInReason', 'ensurePath', 'detectCodexForWizard', 'ipcMain', [
      piece('main.js', /^const \{ createSetupCheck \} = require\('\.\/setup-check\.js'\);\n/m, "the line that loads its setup check, const { createSetupCheck } = require('./setup-check.js');")[0],
      piece('main.js', /^const setupCheck = createSetupCheck\(\{\n[\s\S]*?\n\}\);\n/m, 'the line that makes its setup check, const setupCheck = createSetupCheck({ ... });')[0],
      piece('main.js', /^function launchClaudeSignIn\(purpose\) \{\n[\s\S]*?\n\}\n/m, 'launchClaudeSignIn')[0],
      piece('main.js', /^ *ipcMain\.handle\('wizard-check-runtimes', [^\n]*\);\n/m, "the setup screen's runtime check, wizard-check-runtimes")[0],
      piece('main.js', /^ *ipcMain\.handle\('wizard-signin-claude', [^\n]*\);\n/m, "the setup screen's sign-in channel, wizard-signin-claude")[0],
    ].join('\n'))(requireForMain, { platform, env: { PATH: '/usr/bin' } }, { getPath: () => null },
      { checkAuthenticated: (run) => run() }, createSignInReason(), () => {}, () => ({ installed: false, authenticated: false }), ipcMain);
    // As Electron's invoke: the handler main.js registered gets the call and
    // its answer comes back as a copy; a channel nothing handles is refused.
    const ipcRenderer = {
      invoke: async (channel, ...args) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for '${channel}'`);
        return structuredClone(await handler({}, ...args));
      },
    };
    const preload = (name) => new Function('ipcRenderer',
      `return ${piece('preload.js', new RegExp(`^ *${name}: ([^\\n]*),\\n`, 'm'), name)[1]};`)(ipcRenderer);
    // The wizard as its own suites load it: intervals are recorded and never
    // fire, and the test runs each automatic check itself.
    const state = { intervals: [], cleared: [] };
    const dom = new JSDOM(fs.readFileSync(path.join(ELECTRON, 'wizard.html'), 'utf8'), {
      runScripts: 'dangerously',
      beforeParse(window) {
        window.electronAPI = {
          platform,
          checkRuntimes: preload('checkRuntimes'),
          signInClaude: preload('signInClaude'),
          signInCodex: async () => ({ ok: true }),
          wizardDone: () => {},
        };
        window.setInterval = (fn, ms) => state.intervals.push({ fn, ms });
        window.clearInterval = (id) => { state.cleared.push(id); };
      },
    });
    return {
      w: dom.window, doc: dom.window.document, state, claude, asked, answered, ran, f, gate,
      settle: () => new Promise((resolve) => setTimeout(resolve, 20)),
    };
  }
  // Holds each child the setup check starts that `pick` picks until the test
  // calls its release(reply), with reply as answerChildren's. Every start is
  // still recorded in `ran`, and answerChildren puts the check's own spawn
  // back when the test ends, this wrapper with it.
  function holdChildren(pick) {
    const mod = loadSetupCheck();
    const inner = mod.deps.spawn;
    const held = [];
    mod.deps.spawn = (program, args, options) => {
      const child = inner(program, args, options);
      if (!pick(program, args)) return child;
      const stand = new EventEmitter();
      stand.stdout = new EventEmitter();
      stand.stderr = new EventEmitter();
      stand.kill = () => true;
      held.push({ release: (reply = {}) => {
        if (reply.stdout) stand.stdout.emit('data', Buffer.from(reply.stdout));
        stand.emit('close', reply.status || 0, null);
      } });
      return stand;
    };
    return held;
  }
  const CHECKED = ['which claude', `${BIN} --version`, `${BIN} --print test --output-format text`];
  test('the setup screen\'s Sign in to Claude goes through preload, the desktop\'s channel and launchClaudeSignIn to the wizard\'s console, with no purpose and the copy and version the last setup check found, and runs claude auth login; once signed in, the next automatic check moves the wizard on', async (t) => {
    const s = setupScreen(t, { platform: 'linux', env: terminalOnPath() });
    await s.settle();
    // The first load's install poll stops itself once Claude Code is found,
    // so the sign-in starts its own automatic check.
    await s.state.intervals[0].fn();
    assert.deepStrictEqual(s.ran, [...CHECKED, ...CHECKED], 'each check found Claude Code, started it and checked its sign-in');
    s.doc.getElementById('btn-signin').click();
    await s.settle();
    assert.strictEqual(s.asked.length, 1, 'the click reaches the opener, once');
    assert.strictEqual(s.asked[0].purpose, undefined, 'no purpose: the wizard\'s console');
    assert.deepStrictEqual(s.ran, [...CHECKED, ...CHECKED], 'signing in starts no lookup and no version run');
    assert.strictEqual(s.asked[0].findBin(), BIN, 'the opener is given the copy the last check found');
    assert.strictEqual(s.asked[0].findVersion(), VERSION, 'and the version it read');
    assert.deepStrictEqual(s.answered, [{ ok: true }]);
    assert.strictEqual(s.f.calls.length, 1);
    assert.deepStrictEqual({ command: s.f.calls[0].command, args: s.f.calls[0].args },
      { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'] });
    assert.strictEqual(s.doc.getElementById('btn-signin').textContent, 'Waiting for sign-in...');
    const poll = s.state.intervals[s.state.intervals.length - 1];
    assert.strictEqual(poll.fn, s.w.checkStatus, 'signing in schedules the automatic check');
    assert.strictEqual(poll.ms, 3000);
    assert.ok(!s.doc.getElementById('step-auth').className.includes('done'), 'not past sign-in before it is done');
    s.claude.signedIn = true;
    await poll.fn();
    assert.ok(s.doc.getElementById('step-auth').className.includes('done'), 'the wizard is past sign-in');
    assert.strictEqual(s.doc.getElementById('btn-check').textContent, 'Continue');
    s.w.close();
  });
  test('Sign in to Claude with no copy found by the last check, or one that did not start, is not found: nothing is looked up, started or opened', async (t) => {
    for (const [what, claude, checked] of [
      ['nothing found', { found: false }, ['which claude']],
      ['a copy that did not start', { starts: false }, ['which claude', `${BIN} --version`]],
    ]) {
      const s = setupScreen(t, { platform: 'linux', env: terminalOnPath(), claude });
      await s.settle();
      assert.deepStrictEqual(s.ran, checked, `sanity: the load's check, with ${what}`);
      assert.deepStrictEqual(await s.w.electronAPI.signInClaude(), { ok: false, reason: 'not-found' }, what);
      assert.strictEqual(s.asked.length, 1, 'the ask reaches the opener');
      assert.deepStrictEqual(s.ran, checked, `${what}: signing in starts no lookup and no version run`);
      assert.strictEqual(s.f.calls.length, 0, `${what}: nothing opens`);
      s.w.close();
    }
  });
  // A Check again holds its recheck where `held` says, and Sign in is clicked
  // there: it opens the copy and version the last completed check found, and
  // starts nothing. Once the recheck ends, Sign in has what that one found.
  const NEW_BIN = '/opt/example/bin/claude';
  const NEW_VERSION = '2.2.0 (Claude Code)\n';
  const isWhich = (program) => program === 'which';
  const isVersionRun = (program, args) => args.includes('--version');
  async function signInDuringRecheck(t, held, outcome) {
    const s = setupScreen(t, { platform: 'linux', env: terminalOnPath() });
    await s.settle();
    assert.deepStrictEqual(s.ran, CHECKED, 'sanity: the load\'s check found Claude Code and started it');
    const hold = holdChildren((program, args) => isWhich(program) || isVersionRun(program, args));
    const recheck = s.w.electronAPI.checkRuntimes();
    await s.settle();
    if (held === 'version run') {
      hold[0].release({ stdout: `${NEW_BIN}\n` });
      await s.settle();
    }
    assert.strictEqual(hold.length, held === 'version run' ? 2 : 1, `sanity: the recheck is held in its ${held}`);
    const ran = [...s.ran];
    assert.deepStrictEqual(await s.w.electronAPI.signInClaude(), { ok: true }, `Sign in during the held ${held} opens`);
    assert.strictEqual(s.asked[0].findBin(), BIN, `held in its ${held}: the copy the last completed check found`);
    assert.strictEqual(s.asked[0].findVersion(), VERSION, `held in its ${held}: and the version it read`);
    assert.deepStrictEqual({ command: s.f.calls[0].command, args: s.f.calls[0].args },
      { command: 'x-terminal-emulator', args: ['-e', BIN, 'auth', 'login'] });
    assert.deepStrictEqual(s.ran, ran, `held in its ${held}: signing in starts no lookup and no version run`);
    if (held === 'lookup') {
      hold[0].release(outcome === 'a new copy' ? { stdout: `${NEW_BIN}\n` } : { status: 1 });
      await s.settle();
    }
    if (outcome === 'a new copy') hold[1].release({ stdout: NEW_VERSION });
    else if (held === 'version run') hold[1].release({ status: 1 });
    await recheck;
    s.gate.openedAt = null;
    const after = [...s.ran];
    const answer = await s.w.electronAPI.signInClaude();
    assert.deepStrictEqual(s.ran, after, 'after the recheck, signing in starts no lookup and no version run');
    s.w.close();
    return { s, answer };
  }
  for (const held of ['lookup', 'version run']) {
    test(`Sign in during a Check again held in its ${held} opens the copy and version the last completed check found and starts nothing; once the recheck finds another copy and starts it, Sign in opens that one`, async (t) => {
      const { s, answer } = await signInDuringRecheck(t, held, 'a new copy');
      assert.deepStrictEqual(answer, { ok: true });
      assert.strictEqual(s.asked[1].findBin(), NEW_BIN, 'the recheck\'s copy');
      assert.strictEqual(s.asked[1].findVersion(), NEW_VERSION, 'and the version it read');
      assert.deepStrictEqual({ command: s.f.calls[1].command, args: s.f.calls[1].args },
        { command: 'x-terminal-emulator', args: ['-e', NEW_BIN, 'auth', 'login'] });
    });
    test(`Sign in during a Check again held in its ${held} opens the copy and version the last completed check found and starts nothing; once the recheck ends with no copy started, Sign in is not found`, async (t) => {
      const { s, answer } = await signInDuringRecheck(t, held, 'nothing');
      assert.deepStrictEqual(answer, { ok: false, reason: 'not-found' });
      assert.strictEqual(s.f.calls.length, 1, 'nothing more opens');
    });
  }
  test('the wizard\'s script that cannot be written, its folder a link or another account\'s, is a failure and nothing opens', { skip: POSIX_ONLY }, async (t) => {
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
  });
  test('macOS: when the wizard\'s script cannot be written because its folder is a link, the setup screen\'s Sign in to Claude opens nothing and the screen says it could not start', { skip: POSIX_ONLY }, async (t) => {
    const home = madeUpHome();
    const elsewhere = madeUpHome();
    fs.symlinkSync(elsewhere, path.join(home, '.rundock-console'));
    const s = setupScreen(t, { platform: 'darwin', home });
    await s.settle();
    await s.state.intervals[0].fn();
    const before = s.state.intervals.length;
    s.doc.getElementById('btn-signin').click();
    await s.settle();
    assert.strictEqual(s.asked.length, 1, 'the click reaches the opener, once');
    assert.strictEqual(s.asked[0].purpose, undefined);
    assert.strictEqual(s.asked[0].findVersion(), VERSION, 'a version that writes a script first');
    assert.deepStrictEqual(s.answered, [{ ok: false, reason: 'failed' }]);
    assert.strictEqual(s.f.calls.length, 0, 'nothing opens');
    assert.deepStrictEqual(fs.readdirSync(elsewhere), [], 'nothing is written where the link points');
    assert.strictEqual(s.doc.getElementById('auth-hint').textContent, 'Could not start sign-in: Something stopped it opening.');
    assert.strictEqual(s.doc.getElementById('btn-signin').textContent, 'Sign in to Claude', 'the button can be pressed again');
    assert.strictEqual(s.state.intervals.length, before, 'no automatic check waits for a sign-in that never opened');
    s.w.close();
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

  test('the desktop app hands the opener what its last setup check found, and runs no check of its own', () => {
    const main = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', '..', 'electron', 'main.js'), 'utf8');
    const signIn = /^function launchClaudeSignIn\(purpose\) \{\n[\s\S]*?\n\}\n/m.exec(main);
    assert.ok(signIn, 'electron/main.js no longer carries launchClaudeSignIn');
    assert.match(signIn[0], /openClaudeConsole\(\{ findBin: \(\) => setupCheck\.found\(\)\.bin, findVersion: \(\) => setupCheck\.found\(\)\.version, purpose \}\)/);
    assert.doesNotMatch(signIn[0], /setupCheck\.check\(|findClaude/);
    assert.doesNotMatch(main, /openClaudeConsole\(\{ bin: /);
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
