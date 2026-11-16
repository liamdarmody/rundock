'use strict';
// STARTING AN NPM-INSTALLED RUNTIME ON WINDOWS, THROUGH NODE AND NEVER A SHELL.
//
// npm puts `claude.cmd` and `codex.cmd` on PATH on Windows. Node refuses to
// start a .cmd without a shell, and a shell would read `&`, `|`, `%` and `^`
// in a prompt as part of a command. So Rundock never starts the .cmd: it reads
// the entry point from the package npm installed beside it, keeps it inside
// that package's folder, and starts it with the Node Rundock runs on. Anything
// it cannot read is refused, never started some other way.
//
// Every case stands win32 in through the helper's own argument, or through
// the runtime's own seam for the platform, and lays the npm folder out in a
// real temp folder. No start is real: spawn is recorded in its place.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const { makeTempDir, cleanup } = require('../helpers/workspace.js');
const config = require('../../lib/config.js');

after(cleanup);

// Required where used, so a test reports on the behaviour even where the
// module does not exist.
const launcher = () => require('../../lib/runtime/npm-launcher.js');

const NODE = '/opt/example/node';
const WIN = { platform: 'win32', execPath: NODE };

// A folder laid out as npm lays out a global install on Windows
// (`%APPDATA%\npm`): the launcher, and the package it starts beside it in
// node_modules. `pkg` is the package.json, as an object or as raw text, or
// undefined for none; `files` are written inside the package folder.
function npmFolder(runtime, { pkg, files = {}, name = `${runtime.command}.cmd` } = {}) {
  const dir = makeTempDir('npm-launcher-');
  const bin = path.join(dir, name);
  fs.writeFileSync(bin, '@ECHO off\r\n');
  const folder = path.join(dir, 'node_modules', ...runtime.pkg.split('/'));
  if (pkg !== undefined || Object.keys(files).length) fs.mkdirSync(folder, { recursive: true });
  if (pkg !== undefined) fs.writeFileSync(path.join(folder, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(folder, file)), { recursive: true });
    fs.writeFileSync(path.join(folder, file), text);
  }
  return { dir, bin, folder, entry: (file) => fs.realpathSync(path.join(folder, file)) };
}
const claudePackage = (bin = { claude: 'cli.js' }) => ({ name: '@anthropic-ai/claude-code', version: '2.1.318', bin });
// The entry each runtime's package names, and a package naming `entry` for it.
const ENTRY = { claude: 'cli.js', codex: 'bin/codex.js' };
const packageFor = (runtime, entry = ENTRY[runtime.command]) => ({ name: runtime.pkg, version: '1.0.0', bin: { [runtime.command]: entry } });

// RUNDOCK_ELECTRON is how the app says it runs inside Electron. Each test sets
// it as it needs and puts it back.
function inElectron(on, fn) {
  const before = process.env.RUNDOCK_ELECTRON;
  if (on) process.env.RUNDOCK_ELECTRON = '1'; else delete process.env.RUNDOCK_ELECTRON;
  try { return fn(); } finally {
    if (before === undefined) delete process.env.RUNDOCK_ELECTRON; else process.env.RUNDOCK_ELECTRON = before;
  }
}

// The refusal, word for word, for a launcher at `bin`.
const refusalFor = (label, pkg, bin) => `Rundock found ${label} at ${bin}, but could not read the ${label} package installed beside it, `
  + `so it was not started. Reinstall ${label} with npm install -g ${pkg}, then try again.`;

function assertRefused(plan, npm, runtime, why) {
  assert.ok(plan.refusal instanceof Error, `${why}: refused`);
  assert.strictEqual(plan.program, undefined, `${why}: nothing to start`);
  assert.strictEqual(plan.refusal.code, 'NPM_PACKAGE_UNREADABLE', why);
  assert.strictEqual(plan.refusal.path, npm.bin, `${why}: names the launcher found`);
  assert.strictEqual(plan.refusal.message, refusalFor(runtime.label, runtime.pkg, npm.bin), why);
}

// Refused, and so never started: the start hands spawn nothing and surfaces
// the refusal, word for word.
async function notStarted(npm, runtime, why) {
  assertRefused(launcher().launchPlan(npm.bin, runtime, WIN), npm, runtime, why);
  const refusal = refusalFor(runtime.label, runtime.pkg, npm.bin);
  if (runtime.command === 'claude') {
    const chat = await startChat(npm.bin);
    assert.deepStrictEqual(chat.calls, [], `${why}: the chat started nothing`);
    assert.deepStrictEqual(chat.errors.map((e) => e.message), [refusal], `${why}: and said why`);
    const check = await checkFrom(npm.bin);
    assert.deepStrictEqual(check.calls, [], `${why}: the connection check started nothing`);
    assert.deepStrictEqual(check.answer, { connected: false, known: false }, `${why}: and could not tell`);
  } else {
    const codex = await startCodex(npm.bin);
    assert.deepStrictEqual(codex.calls, [], `${why}: the Codex app server started nothing`);
    assert.ok(codex.failure, `${why}: and its start failed`);
    assert.deepStrictEqual([codex.failure.code, codex.failure.message], ['NPM_PACKAGE_UNREADABLE', `codex app-server failed to start: ${refusal}`], `${why}: saying why`);
    assert.strictEqual(codex.failure.cause && codex.failure.cause.message, refusal, `${why}: with the refusal as it was made`);
  }
}

// ── The connection check (checkConnection) ──

const CHECK_ARGS = ['--print', 'test', '--output-format', 'text'];

// One connection check, with the platform stood in and spawn recorded, inside
// the Electron app or under node server.js. Each start closes at once, as a
// signed-in Claude Code's would.
async function checkFrom(bin, { platform = 'win32', electron = false } = {}) {
  const { checkConnection } = require('../../lib/runtime/claude-console.js');
  const calls = [];
  const spawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => true });
    calls.push({ file, args, options, inherited: { ...process.env } });
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const before = process.env.RUNDOCK_ELECTRON;
  try {
    if (electron) process.env.RUNDOCK_ELECTRON = '1'; else delete process.env.RUNDOCK_ELECTRON;
    return { calls, answer: await checkConnection({ bin, spawn, platform, timeoutMs: 5000 }) };
  } finally {
    if (before === undefined) delete process.env.RUNDOCK_ELECTRON; else process.env.RUNDOCK_ELECTRON = before;
  }
}

// ── Starting the Codex app server ──

const APP_SERVER_KEY = require.resolve('../../codex-appserver.js');

// A private copy of the app server client with spawn recorded. The client
// takes spawn from node:child_process as it loads, so the recorder is put
// there for the load only, and every other copy keeps the real one.
function recordedCodex() {
  const childProcess = require('node:child_process');
  const recorded = recordedSpawn();
  const real = childProcess.spawn;
  const cached = require.cache[APP_SERVER_KEY];
  childProcess.spawn = recorded.spawn;
  try {
    delete require.cache[APP_SERVER_KEY];
    return { lib: require(APP_SERVER_KEY), calls: recorded.calls };
  } finally {
    childProcess.spawn = real;
    delete require.cache[APP_SERVER_KEY];
    if (cached) require.cache[APP_SERVER_KEY] = cached;
  }
}

// One start of the Codex app server on a private client, with the platform
// stood in and spawn recorded, inside the Electron app or under node
// server.js. Each child it starts closes before answering. Settles with what
// it handed spawn and why the start failed (null if it did not).
async function startCodex(bin, { platform = 'win32', env = { ...process.env, MARKER: 'given' }, electron = false, codex = recordedCodex(), server } = {}) {
  const cwd = makeTempDir('npm-launcher-codex-');
  server = server || codex.lib.createCodexAppServer({ binPath: bin, cwd, env, platform, requestTimeoutMs: 5000 });
  const before = process.env.RUNDOCK_ELECTRON;
  const from = codex.calls.length;
  let started;
  try {
    if (electron) process.env.RUNDOCK_ELECTRON = '1'; else delete process.env.RUNDOCK_ELECTRON;
    started = server.start().then(() => null, (err) => err);
  } finally {
    if (before === undefined) delete process.env.RUNDOCK_ELECTRON; else process.env.RUNDOCK_ELECTRON = before;
  }
  await new Promise((resolve) => setImmediate(resolve));
  for (const c of codex.calls.slice(from)) c.child.emit('close', 0, null);
  return { calls: codex.calls.slice(from), cwd, env, server, failure: await started };
}

// ── Starting a chat through spawnClaude ──

const LIB_KEY = require.resolve('../../lib/runtime/claude.js');
const CHAT_ARGS = ['--output-format', 'stream-json', '--verbose', '--agent', 'writer'];

// A private copy of the runtime per test, so a path it found or a version it
// read never carries from one test into the next.
function freshClaude() {
  const cached = require.cache[LIB_KEY];
  delete require.cache[LIB_KEY];
  const mod = require(LIB_KEY);
  delete require.cache[LIB_KEY];
  if (cached) require.cache[LIB_KEY] = cached;
  return mod;
}

// The runtime asks `where.exe` for Claude Code only on a real Windows, and
// `which` everywhere else, so a `which` that names `bin`, first on PATH,
// stands in for the lookup.
function finderFor(bin) {
  const dir = makeTempDir('npm-launcher-which-');
  fs.writeFileSync(path.join(dir, 'which'), `#!/bin/sh\nprintf '%s\\n' '${bin}'\n`);
  fs.chmodSync(path.join(dir, 'which'), 0o755);
  return dir;
}

// A binary that answers --version as a current Claude Code, for the version
// floor to read where it runs the copy found: a .exe on Windows, and any copy
// on macOS and Linux. Nothing else runs it: spawn is recorded.
function runnable(name) {
  const bin = path.join(makeTempDir('npm-launcher-bin-'), name);
  fs.writeFileSync(bin, `#!${process.execPath}\nprocess.stdout.write('2.1.318 (Claude Code)\\n');\n`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

// spawn, recorded in place of a start, with the environment the start would
// have inherited. Each start hands back a child that closes when the test
// says so.
function recordedSpawn() {
  const calls = [];
  const spawn = (file, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      pid: 70000 + calls.length,
      stdin: new Writable({ write: (chunk, encoding, done) => done() }),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true,
    });
    calls.push({ file, args, options, inherited: { ...process.env }, child });
    return child;
  };
  return { calls, spawn };
}

// One chat started through spawnClaude, on a private runtime with the
// platform stood in, spawn recorded and a workspace for the pid file, inside
// the Electron app or under node server.js. Settles once anything the start
// surfaces has been surfaced, with what it handed spawn, the errors it
// surfaced, and the pid file as it started and once it closed.
async function startChat(bin, { platform = 'win32', args = CHAT_ARGS, options = { stdio: 'ignore' }, electron = false, rt = freshClaude(), onError } = {}) {
  const previousWs = config.getWorkspace();
  config.setWorkspace(makeTempDir('npm-launcher-ws-'));
  const { calls, spawn } = recordedSpawn();
  const prev = rt.wireClaudeRuntimeDeps({ onClaudeSpawn: () => {}, platform: () => platform, spawn });
  const before = { PATH: process.env.PATH, RUNDOCK_ELECTRON: process.env.RUNDOCK_ELECTRON };
  const errors = [];
  try {
    process.env.PATH = [finderFor(bin), '/usr/bin', '/bin'].join(path.delimiter);
    if (electron) process.env.RUNDOCK_ELECTRON = '1'; else delete process.env.RUNDOCK_ELECTRON;
    rt.spawnClaude(args, options, (err) => { errors.push(err); if (onError) onError(err); });
    const tracked = rt.loadPidFile();
    await new Promise((resolve) => setImmediate(resolve));
    for (const c of calls) c.child.emit('close', 0, null);
    return { calls, errors, tracked, left: rt.loadPidFile() };
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    rt.wireClaudeRuntimeDeps(prev);
    config.setWorkspace(previousWs);
  }
}

describe('the entry point read from the package beside the launcher', () => {
  test('a claude.cmd starts the given Node with the entry its package names for claude first', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const plan = inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN));
    assert.deepStrictEqual(plan, { program: NODE, args: [npm.entry('cli.js')], env: null });
  });

  test('a codex.cmd starts the given Node with the entry its package names for codex first', () => {
    const { launchPlan, CODEX } = launcher();
    const npm = npmFolder(CODEX, { pkg: { name: '@openai/codex', bin: { codex: 'bin/codex.js' } }, files: { 'bin/codex.js': '' } });
    const plan = inElectron(false, () => launchPlan(npm.bin, CODEX, WIN));
    assert.deepStrictEqual(plan, { program: NODE, args: [npm.entry('bin/codex.js')], env: null });
  });

  test('a bin given as one path is that entry', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage('bin/run.js'), files: { 'bin/run.js': '' } });
    assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)).args, [npm.entry('bin/run.js')]);
  });

  test('an entry ending in .exe is started directly, without Node, inside Electron too', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    for (const file of ['bin/claude.exe', 'bin/CLAUDE.EXE']) {
      const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage({ claude: file }), files: { [file]: '' } });
      for (const electron of [false, true]) {
        assert.deepStrictEqual(inElectron(electron, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)),
          { program: npm.entry(file), args: [], env: null }, `${file}, electron ${electron}`);
      }
    }
  });

  test('.cmd, .BAT and .Cmd launchers are read the same way', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    for (const name of ['claude.cmd', 'CLAUDE.BAT', 'claude.Cmd', 'claude.bat']) {
      const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' }, name });
      assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)).args, [npm.entry('cli.js')], name);
    }
  });

  test('a package folder that is a link is followed, and its entry kept inside where it leads', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const real = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const npm = npmFolder(CLAUDE_CODE);
    fs.mkdirSync(path.dirname(npm.folder), { recursive: true });
    fs.symlinkSync(real.folder, npm.folder, 'dir');
    assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)).args, [real.entry('cli.js')]);
  });

  test('inside Electron the Node start carries ELECTRON_RUN_AS_NODE, and under node server.js nothing is added', () => {
    const { launchPlan, CLAUDE_CODE, CODEX } = launcher();
    const claude = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const codex = npmFolder(CODEX, { pkg: { bin: { codex: 'bin/codex.js' } }, files: { 'bin/codex.js': '' } });
    for (const [npm, runtime] of [[claude, CLAUDE_CODE], [codex, CODEX]]) {
      assert.deepStrictEqual(inElectron(true, () => launchPlan(npm.bin, runtime, WIN)).env, { ELECTRON_RUN_AS_NODE: '1' }, runtime.label);
      assert.strictEqual(inElectron(false, () => launchPlan(npm.bin, runtime, WIN)).env, null, runtime.label);
    }
  });

  test('a .exe on Windows, and every binary on macOS and Linux, is started as found with nothing read or added', () => {
    const { launchPlan, CLAUDE_CODE, CODEX } = launcher();
    const exe = 'C:\\Users\\someone\\AppData\\Local\\Programs\\claude\\claude.exe';
    const cmd = 'C:\\Users\\someone\\AppData\\Roaming\\npm\\claude.cmd';
    for (const electron of [false, true]) {
      inElectron(electron, () => {
        assert.deepStrictEqual(launchPlan(exe, CLAUDE_CODE, WIN), { program: exe, args: [], env: null });
        assert.deepStrictEqual(launchPlan('claude', CLAUDE_CODE, WIN), { program: 'claude', args: [], env: null }, 'a lookup that found nothing');
        for (const platform of ['darwin', 'linux']) {
          assert.deepStrictEqual(launchPlan(cmd, CLAUDE_CODE, { platform, execPath: NODE }), { program: cmd, args: [], env: null }, platform);
          assert.deepStrictEqual(launchPlan('/usr/local/bin/codex', CODEX, { platform, execPath: NODE }), { program: '/usr/local/bin/codex', args: [], env: null }, platform);
        }
      });
    }
  });
});

// One test per cause, each named after it. A refusal is never a plan to start
// the launcher, so nothing can fall back to a shell.
describe('a package that cannot be read is refused, and nothing is started', () => {
  test('the package folder is missing', async () => {
    const { CLAUDE_CODE, CODEX } = launcher();
    for (const runtime of [CLAUDE_CODE, CODEX]) {
      const npm = npmFolder(runtime);
      await notStarted(npm, runtime, runtime.label);
    }
  });

  test('its package.json is missing', async () => {
    const { CLAUDE_CODE, CODEX } = launcher();
    for (const runtime of [CLAUDE_CODE, CODEX]) {
      const npm = npmFolder(runtime, { files: { [ENTRY[runtime.command]]: '' } });
      await notStarted(npm, runtime, `${runtime.label}: no package.json`);
    }
  });

  test('its package.json does not parse', async () => {
    const { CLAUDE_CODE, CODEX } = launcher();
    for (const runtime of [CLAUDE_CODE, CODEX]) {
      const entry = ENTRY[runtime.command];
      for (const text of [`{ "bin": { "${runtime.command}": "${entry}" }, `, '', 'not json']) {
        const npm = npmFolder(runtime, { pkg: text, files: { [entry]: '' } });
        await notStarted(npm, runtime, `${runtime.label}: ${JSON.stringify(text)}`);
      }
    }
  });

  test('it has no bin entry for the runtime\'s command', async () => {
    const { CLAUDE_CODE, CODEX } = launcher();
    const cases = [
      [CLAUDE_CODE, { name: '@anthropic-ai/claude-code', version: '2.1.318' }, 'no bin at all'],
      [CLAUDE_CODE, claudePackage({ 'claude-code': 'cli.js' }), 'a bin for another command'],
      [CLAUDE_CODE, claudePackage({ claude: '' }), 'an empty entry'],
      [CLAUDE_CODE, claudePackage({ claude: 7 }), 'an entry that is not a path'],
      [CLAUDE_CODE, claudePackage(['cli.js']), 'a list'],
      [CLAUDE_CODE, null, 'a package.json that is null'],
      [CODEX, { name: '@openai/codex', bin: { claude: 'cli.js' } }, 'Claude Code\'s entry in the Codex package'],
      [CODEX, { name: '@openai/codex', version: '1.0.0' }, 'no bin at all in the Codex package'],
      [CODEX, packageFor(CODEX, ''), 'an empty Codex entry'],
      [CODEX, { name: '@openai/codex', bin: ['bin/codex.js'] }, 'a list in the Codex package'],
    ];
    for (const [runtime, pkg, why] of cases) {
      const npm = npmFolder(runtime, { pkg, files: { 'cli.js': '', 'bin/codex.js': '' } });
      await notStarted(npm, runtime, why);
    }
  });

  test('the entry is not a file inside the folder', async () => {
    const { CLAUDE_CODE, CODEX } = launcher();
    const outside = makeTempDir('npm-launcher-outside-');
    fs.writeFileSync(path.join(outside, 'evil.js'), '');
    const cases = [
      ['../../evil.js', (npm) => fs.writeFileSync(path.join(npm.dir, 'node_modules', 'evil.js'), ''), 'a relative path out of the folder'],
      [path.join(outside, 'evil.js'), () => {}, 'an absolute path elsewhere'],
      ['run.js', (npm) => fs.symlinkSync(path.join(outside, 'evil.js'), path.join(npm.folder, 'run.js')), 'a link inside that leads out'],
      ['run.js', () => {}, 'an entry that is not there'],
      ['bin', (npm) => fs.mkdirSync(path.join(npm.folder, 'bin')), 'a folder'],
      ['.', () => {}, 'the package folder itself'],
    ];
    for (const runtime of [CLAUDE_CODE, CODEX]) {
      for (const [entry, lay, why] of cases) {
        const npm = npmFolder(runtime, { pkg: packageFor(runtime, entry) });
        lay(npm);
        await notStarted(npm, runtime, `${runtime.label}: ${why}`);
      }
    }
  });

  test('a package fixed after a refusal starts on the next try, with nothing remembered', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: 'not json', files: { 'cli.js': '' } });
    assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, 'before the fix');
    fs.writeFileSync(path.join(npm.folder, 'package.json'), JSON.stringify(claudePackage()));
    assert.deepStrictEqual(inElectron(false, () => launchPlan(npm.bin, CLAUDE_CODE, WIN)), { program: NODE, args: [npm.entry('cli.js')], env: null }, 'after it');
    fs.rmSync(path.join(npm.folder, 'cli.js'));
    assertRefused(launchPlan(npm.bin, CLAUDE_CODE, WIN), npm, CLAUDE_CODE, 'and refused again once it breaks');
  });

  test('an unexpected failure while reading the package refuses, and never starts the launcher', () => {
    const { launchPlan, CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    for (const name of ['statSync', 'realpathSync', 'readFileSync']) {
      const real = fs[name];
      fs[name] = () => { throw new TypeError(`${name} broke unexpectedly`); };
      let plan;
      try { plan = launchPlan(npm.bin, CLAUDE_CODE, WIN); } finally { fs[name] = real; }
      assertRefused(plan, npm, CLAUDE_CODE, name);
      assert.match(String(plan.refusal.cause && plan.refusal.cause.message), new RegExp(`${name} broke`), `${name}: the cause is kept for the log`);
    }
  });
});

describe('a chat started through spawnClaude', () => {
  test('with only an npm claude.cmd found on Windows, a chat starts this Node with the entry point first, and no shell', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const given = { cwd: npm.dir, env: { ...process.env, MARKER: 'given' }, stdio: ['pipe', 'pipe', 'pipe'] };
    const chat = await startChat(npm.bin, { options: given });
    assert.deepStrictEqual(chat.errors, []);
    assert.strictEqual(chat.calls.length, 1, 'one start');
    const [{ file, args, options }] = chat.calls;
    assert.strictEqual(file, process.execPath, 'the Node Rundock runs on');
    assert.deepStrictEqual(args, [npm.entry('cli.js'), ...CHAT_ARGS], 'the entry point first, then the arguments as given');
    assert.deepStrictEqual(options, { ...given, detached: process.platform !== 'win32' }, 'the options the caller gave');
    assert.strictEqual('shell' in options, false, 'no shell');
    assert.strictEqual(options.env, given.env, 'the very environment the caller built');
    assert.deepStrictEqual(chat.tracked.map((r) => [r.pid, r.cmd]), [[70000, 'cli.js']], 'recorded by the entry point it runs');
    assert.deepStrictEqual(chat.left, [], 'and forgotten when it closed');
  });

  test('a prompt holding &, |, %, ^ and an unbalanced quote reaches spawn byte for byte, with no shell', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const prompt = 'Tidy the notes & echo x > y.txt | more %PATH% ^ and "a quote left open';
    const args = ['--print', prompt, '--append-system-prompt', prompt, ...CHAT_ARGS];
    const chat = await startChat(npm.bin, { args });
    assert.strictEqual(chat.calls.length, 1);
    const [{ args: handed, options }] = chat.calls;
    assert.deepStrictEqual(handed, [npm.entry('cli.js'), ...args]);
    for (const at of [2, 4]) assert.ok(Buffer.from(handed[at], 'utf8').equals(Buffer.from(prompt, 'utf8')), `argument ${at} is the prompt, byte for byte`);
    assert.strictEqual('shell' in options, false, 'shell is not set');
  });

  test('inside the Electron app the Node start carries ELECTRON_RUN_AS_NODE, and under node server.js nothing is added', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const given = { env: { ...process.env, MARKER: 'given' }, stdio: 'ignore' };
    const app = await startChat(npm.bin, { options: given, electron: true });
    assert.deepStrictEqual(app.calls[0].options.env, { ...given.env, ELECTRON_RUN_AS_NODE: '1' }, 'the caller\'s environment, and the one variable');
    assert.strictEqual('ELECTRON_RUN_AS_NODE' in given.env, false, 'the caller\'s own object is left as it was');
    const inherited = await startChat(npm.bin, { options: { stdio: 'ignore' }, electron: true });
    assert.deepStrictEqual(inherited.calls[0].options.env, { ...inherited.calls[0].inherited, ELECTRON_RUN_AS_NODE: '1' }, 'with no environment given, the inherited one and the variable');
    const server = await startChat(npm.bin, { options: given, electron: false });
    assert.strictEqual(server.calls[0].options.env, given.env, 'under node server.js, the very environment given');
    const bare = await startChat(npm.bin, { options: { stdio: 'ignore' }, electron: false });
    assert.strictEqual('env' in bare.calls[0].options, false, 'and none added where none was given');
  });

  test('a .exe on Windows, and any copy on macOS or Linux, is started as before: the same program, arguments and options, field by field', async () => {
    const cases = [['win32', runnable('claude.exe')], ['darwin', runnable('claude')], ['linux', runnable('claude')], ['linux', runnable('claude.cmd')]];
    for (const [platform, bin] of cases) {
      for (const electron of [false, true]) {
        const why = `${path.basename(bin)} on ${platform}${electron ? ' inside the Electron app' : ''}`;
        const given = { cwd: path.dirname(bin), env: { ...process.env, MARKER: 'given' }, stdio: ['pipe', 'pipe', 'ignore'] };
        const chat = await startChat(bin, { platform, options: given, electron });
        assert.deepStrictEqual(chat.errors, [], why);
        assert.strictEqual(chat.calls.length, 1, why);
        const [{ file, args, options }] = chat.calls;
        assert.strictEqual(file, bin, `${why}: the program`);
        assert.deepStrictEqual(args, CHAT_ARGS, `${why}: the arguments`);
        assert.deepStrictEqual(Object.keys(options), ['cwd', 'env', 'stdio', 'detached'], `${why}: the option names`);
        assert.strictEqual(options.cwd, given.cwd, `${why}: cwd`);
        assert.strictEqual(options.env, given.env, `${why}: env, the very object`);
        assert.strictEqual(options.stdio, given.stdio, `${why}: stdio, the very array`);
        assert.strictEqual(options.detached, process.platform !== 'win32', `${why}: detached`);
        assert.deepStrictEqual(chat.tracked.map((r) => r.cmd), [path.basename(bin)], `${why}: recorded by its own name`);
      }
    }
  });

  test('a package that cannot be read is said in the conversation, word for word, and nothing is started', async () => {
    const { CLAUDE_CODE } = launcher();
    const srv = require('../../server.js')._internal;
    const npm = npmFolder(CLAUDE_CODE);
    const said = [];
    const client = { readyState: 1, send: (raw) => said.push(JSON.parse(raw)) };
    srv.connectedClients.add(client);
    const convo = `npm-launcher-${Date.now()}`;
    let chat;
    try {
      chat = await startChat(npm.bin, { onError: (err) => srv.handleChatSpawnError(err, convo) });
    } finally { srv.connectedClients.delete(client); }
    assert.deepStrictEqual(chat.calls, [], 'nothing started');
    const info = said.filter((m) => m._conversationId === convo && m.subtype === 'info');
    assert.deepStrictEqual(info.map((m) => m.content), [refusalFor('Claude Code', '@anthropic-ai/claude-code', npm.bin)], 'the refusal, and only it');
    assert.ok(said.some((m) => m._conversationId === convo && m.subtype === 'done'), 'and the conversation stops waiting');
  });

  test('fixed after a refusal, the package starts on the next chat, with no restart', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: 'not json', files: { 'cli.js': '' } });
    const rt = freshClaude();
    const refused = await startChat(npm.bin, { rt });
    assert.deepStrictEqual([refused.calls.length, refused.errors.map((e) => e.code)], [0, ['NPM_PACKAGE_UNREADABLE']]);
    fs.writeFileSync(path.join(npm.folder, 'package.json'), JSON.stringify(claudePackage()));
    const started = await startChat(npm.bin, { rt });
    assert.deepStrictEqual(started.errors, []);
    assert.deepStrictEqual(started.calls.map((c) => [c.file, c.args[0]]), [[process.execPath, npm.entry('cli.js')]]);
  });

  test('an unexpected failure while reading the package refuses the chat, and the launcher is never started', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const real = fs.statSync;
    fs.statSync = function (p, ...rest) {
      if (String(p).endsWith('cli.js')) throw new TypeError('statSync broke unexpectedly');
      return real.call(this, p, ...rest);
    };
    let chat;
    try { chat = await startChat(npm.bin); } finally { fs.statSync = real; }
    assert.deepStrictEqual(chat.calls, [], 'nothing started, the launcher least of all');
    assert.deepStrictEqual(chat.errors.map((e) => [e.code, e.path]), [['NPM_PACKAGE_UNREADABLE', npm.bin]]);
  });
});

describe('the connection check', () => {
  test('with only an npm claude.cmd found on Windows, it starts this Node with the entry point first, as a chat does, and no shell', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const { calls, answer } = await checkFrom(npm.bin);
    assert.deepStrictEqual(answer, { connected: true, known: true });
    assert.strictEqual(calls.length, 1, 'one start');
    const [{ file, args, options }] = calls;
    assert.strictEqual(file, process.execPath, 'the Node Rundock runs on');
    assert.deepStrictEqual(args, [npm.entry('cli.js'), ...CHECK_ARGS], 'the entry point first, then the check\'s own words');
    assert.deepStrictEqual(options, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }, 'from the home folder, as before');
    assert.strictEqual('shell' in options, false, 'no shell');
  });

  test('inside the Electron app the Node start carries ELECTRON_RUN_AS_NODE, and under node server.js nothing is added', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: claudePackage(), files: { 'cli.js': '' } });
    const app = await checkFrom(npm.bin, { electron: true });
    assert.deepStrictEqual(app.calls[0].options.env, { ...app.calls[0].inherited, ELECTRON_RUN_AS_NODE: '1' }, 'the app\'s own environment, and the one variable');
    const server = await checkFrom(npm.bin, { electron: false });
    assert.strictEqual('env' in server.calls[0].options, false, 'the app\'s own environment, nothing added');
  });

  test('a .exe on Windows, and any copy on macOS or Linux, is checked as before, inside the Electron app too', async () => {
    for (const [platform, bin] of [['win32', '/opt/example/claude.exe'], ['darwin', '/opt/example/claude'], ['linux', '/opt/example/claude'], ['linux', '/opt/example/claude.cmd']]) {
      for (const electron of [false, true]) {
        const why = `${path.basename(bin)} on ${platform}${electron ? ' inside the Electron app' : ''}`;
        const { calls, answer } = await checkFrom(bin, { platform, electron });
        assert.deepStrictEqual(answer, { connected: true, known: true }, why);
        assert.deepStrictEqual(calls.map((c) => [c.file, c.args, c.options]), [[bin, CHECK_ARGS, { cwd: os.homedir(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }]], why);
      }
    }
  });

  test('fixed after a refusal, the package is checked on the next try, with nothing remembered', async () => {
    const { CLAUDE_CODE } = launcher();
    const npm = npmFolder(CLAUDE_CODE, { pkg: { name: '@anthropic-ai/claude-code' }, files: { 'cli.js': '' } });
    const refused = await checkFrom(npm.bin);
    assert.deepStrictEqual([refused.calls.length, refused.answer], [0, { connected: false, known: false }]);
    fs.writeFileSync(path.join(npm.folder, 'package.json'), JSON.stringify(claudePackage()));
    const checked = await checkFrom(npm.bin);
    assert.deepStrictEqual(checked.calls.map((c) => [c.file, c.args[0]]), [[process.execPath, npm.entry('cli.js')]]);
    assert.deepStrictEqual(checked.answer, { connected: true, known: true });
  });
});

// One Codex turn through the host's own path (startCodexTurn), on a private
// copy of the host, with the lookup finding `bin` and the app server planned
// for Windows. Settles once the conversation is told the turn is done, with
// everything said to it.
const GLUE_KEY = require.resolve('../../lib/runtime/codex-glue.js');
function freshGlue() {
  const cached = require.cache[GLUE_KEY];
  delete require.cache[GLUE_KEY];
  const mod = require(GLUE_KEY);
  delete require.cache[GLUE_KEY];
  if (cached) require.cache[GLUE_KEY] = cached;
  return mod;
}

async function codexTurn(bin, { glue = freshGlue(), codex = recordedCodex() } = {}) {
  const shared = require('../../codex-appserver.js');
  const realCreate = shared.createCodexAppServer;
  const previousWs = config.getWorkspace();
  const previousPath = process.env.PATH;
  const said = [];
  const convo = `npm-launcher-codex-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  let done;
  const ended = new Promise((resolve) => { done = resolve; });
  const chats = new Map();
  const spawnErrors = new Map();
  const prev = glue.wireCodexGlueDeps({
    chatProcesses: () => chats,
    safeSend: (raw) => { const m = JSON.parse(raw); said.push(m); if (m._conversationId === convo && m.subtype === 'done') done(); },
    recentSpawnErrors: () => spawnErrors,
    getActualPort: () => 0,
    getPermissionTimeoutMs: () => 1000,
    registerChildPid: () => null,
    unregisterChildPid: () => {},
    endConvoTransition: () => {},
    appendTranscript: () => {},
    killProcessTree: () => {},
  });
  const from = codex.calls.length;
  try {
    config.setWorkspace(makeTempDir('npm-launcher-ws-'));
    shared.createCodexAppServer = (opts) => codex.lib.createCodexAppServer({ ...opts, platform: 'win32' });
    process.env.PATH = [finderFor(bin), '/usr/bin', '/bin'].join(path.delimiter);
    glue.startCodexTurn(convo, { content: 'Tidy the notes & echo x > y.txt' }, { id: 'writer' });
    await new Promise((resolve) => setImmediate(resolve));
    for (const c of codex.calls.slice(from)) c.child.emit('close', 0, null);
    await Promise.race([ended, new Promise((resolve, reject) => setTimeout(() => reject(new Error('the turn never ended')), 5000))]);
    return { said: said.filter((m) => m._conversationId === convo), calls: codex.calls.slice(from) };
  } finally {
    process.env.PATH = previousPath;
    shared.createCodexAppServer = realCreate;
    glue.wireCodexGlueDeps(prev);
    config.setWorkspace(previousWs);
  }
}

describe('the Codex app server', () => {
  test('with only an npm codex.cmd found on Windows, it starts this Node with the entry point, then app-server, and no shell', async () => {
    const { CODEX } = launcher();
    const npm = npmFolder(CODEX, { pkg: packageFor(CODEX), files: { 'bin/codex.js': '' } });
    const { calls, cwd, env } = await startCodex(npm.bin);
    assert.strictEqual(calls.length, 1, 'one start');
    const [{ file, args, options }] = calls;
    assert.strictEqual(file, process.execPath, 'the Node Rundock runs on');
    assert.deepStrictEqual(args, [npm.entry('bin/codex.js'), 'app-server'], 'the entry point, then app-server');
    assert.deepStrictEqual(options, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] }, 'the options it is always started with');
    assert.strictEqual('shell' in options, false, 'no shell');
    assert.strictEqual(options.env, env, 'the very environment the host built');
  });

  test('inside the Electron app the Node start carries ELECTRON_RUN_AS_NODE, and under node server.js nothing is added', async () => {
    const { CODEX } = launcher();
    const npm = npmFolder(CODEX, { pkg: packageFor(CODEX), files: { 'bin/codex.js': '' } });
    const app = await startCodex(npm.bin, { electron: true });
    assert.deepStrictEqual(app.calls[0].options.env, { ...app.env, ELECTRON_RUN_AS_NODE: '1' }, 'the host\'s environment, and the one variable');
    assert.strictEqual('ELECTRON_RUN_AS_NODE' in app.env, false, 'the host\'s own object is left as it was');
    const server = await startCodex(npm.bin, { electron: false });
    assert.strictEqual(server.calls[0].options.env, server.env, 'under node server.js, the very environment given');
  });

  test('a .exe on Windows, and any copy on macOS or Linux, is started as before: the same program, arguments and options, field by field', async () => {
    const cases = [['win32', '/opt/example/codex.exe'], ['darwin', '/opt/example/codex'], ['linux', '/opt/example/codex'], ['linux', '/opt/example/codex.cmd']];
    for (const [platform, bin] of cases) {
      for (const electron of [false, true]) {
        const why = `${path.basename(bin)} on ${platform}${electron ? ' inside the Electron app' : ''}`;
        const { calls, cwd, env } = await startCodex(bin, { platform, electron });
        assert.strictEqual(calls.length, 1, why);
        const [{ file, args, options }] = calls;
        assert.strictEqual(file, bin, `${why}: the program`);
        assert.deepStrictEqual(args, ['app-server'], `${why}: the arguments`);
        assert.deepStrictEqual(Object.keys(options), ['cwd', 'env', 'stdio'], `${why}: the option names`);
        assert.strictEqual(options.cwd, cwd, `${why}: cwd`);
        assert.strictEqual(options.env, env, `${why}: env, the very object`);
        assert.deepStrictEqual(options.stdio, ['pipe', 'pipe', 'pipe'], `${why}: stdio`);
      }
    }
  });

  test('an entry ending in .exe is started directly, with nothing added, inside the Electron app too', async () => {
    const { CODEX } = launcher();
    const npm = npmFolder(CODEX, { pkg: packageFor(CODEX, 'bin/codex.exe'), files: { 'bin/codex.exe': '' } });
    for (const electron of [false, true]) {
      const { calls, env } = await startCodex(npm.bin, { electron });
      assert.deepStrictEqual(calls.map((c) => [c.file, c.args, c.options.env === env]), [[npm.entry('bin/codex.exe'), ['app-server'], true]], `electron ${electron}`);
    }
  });

  test('a package that cannot be read is said in the conversation, word for word, as a Codex that cannot start, and nothing is started', async () => {
    const { CODEX } = launcher();
    const npm = npmFolder(CODEX);
    const turn = await codexTurn(npm.bin);
    assert.deepStrictEqual(turn.calls, [], 'nothing started');
    const info = turn.said.filter((m) => m.subtype === 'info');
    assert.deepStrictEqual(info.map((m) => m.content), [refusalFor('Codex', '@openai/codex', npm.bin)], 'the refusal, and only it');
    assert.deepStrictEqual(turn.said.filter((m) => m.subtype === 'done').map((m) => m.code), [-1], 'and the conversation stops waiting');
    assert.deepStrictEqual(turn.said.filter((m) => /codex_/.test(m.subtype)), [], 'with no runtime error card besides');
  });

  test('fixed after a refusal, the package starts on the next turn and the next start, with no restart', async () => {
    const { CODEX } = launcher();
    const npm = npmFolder(CODEX, { pkg: 'not json', files: { 'bin/codex.js': '' } });
    const codex = recordedCodex();
    const server = codex.lib.createCodexAppServer({ binPath: npm.bin, cwd: makeTempDir('npm-launcher-codex-'), platform: 'win32', requestTimeoutMs: 5000 });
    const refused = await startCodex(npm.bin, { codex, server });
    assert.deepStrictEqual([refused.calls.length, refused.failure.code], [0, 'NPM_PACKAGE_UNREADABLE']);
    const glue = freshGlue();
    const turnRefused = await codexTurn(npm.bin, { glue, codex });
    assert.deepStrictEqual(turnRefused.calls, [], 'a turn refused as well');
    fs.writeFileSync(path.join(npm.folder, 'package.json'), JSON.stringify(packageFor(CODEX)));
    const started = await startCodex(npm.bin, { codex, server });
    assert.deepStrictEqual(started.calls.map((c) => [c.file, c.args]), [[process.execPath, [npm.entry('bin/codex.js'), 'app-server']]], 'the same client starts it');
    const turn = await codexTurn(npm.bin, { glue, codex });
    assert.deepStrictEqual(turn.calls.map((c) => [c.file, c.args]), [[process.execPath, [npm.entry('bin/codex.js'), 'app-server']]], 'and so does the next turn');
    assert.ok(!turn.said.some((m) => m.subtype === 'info' && /could not read/.test(m.content)), 'with no refusal said');
  });
});
