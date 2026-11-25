'use strict';
// The desktop's Claude Code setup check (electron/setup-check.js), driven with
// fake children through its `deps`.
//
// The setup screen polls this while the person installs Claude Code, so it
// must never hold the main process, must start only the copy it found, and
// must say "found but didn't start" rather than "not installed" when that
// first start is slow.
const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { makeTempDir } = require('../helpers/workspace.js');

const MODULE = path.join(__dirname, '..', '..', 'electron', 'setup-check.js');

// Asserted before every use, so with the module missing each test fails on
// this assertion rather than on a thrown require.
function load() {
  let found = null;
  try { found = require.resolve(MODULE); } catch { /* asserted next */ }
  assert.ok(found, 'electron/setup-check.js is there to load');
  return require(MODULE);
}

const MAC_BIN = '/home/example/.local/bin/claude';
const WIN_EXE = 'C:\\Users\\example\\.local\\bin\\claude.exe';
const APP = '/Applications/Example.app/Contents/MacOS/Example';

const isLookup = (c) => c.program === 'which' || c.program === 'where.exe';
const isPowerShell = (c) => c.program === 'powershell.exe';
const isVersion = (c) => c.args.includes('--version');

// A child that answers as `answer` says: { stdout, stderr, status, error },
// at once, or later through release() when `hold` is set.
function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kills = 0;
  child.kill = () => { child.kills++; return true; };
  return child;
}
function settle(child, { stdout = '', stderr = '', status = 0, error = null } = {}) {
  if (error) { child.emit('error', error); return; }
  if (stdout) child.stdout.emit('data', Buffer.from(stdout));
  if (stderr) child.stderr.emit('data', Buffer.from(stderr));
  child.emit('close', status, null);
}

// Every child the check starts, through a stand-in for spawn, and every timer
// it sets, through stand-ins that never fire on their own.
function fakes(t, answer, extra = {}) {
  const mod = load();
  assert.ok(mod.deps && typeof mod.deps === 'object', 'the module has deps for a test to replace');
  const calls = [];
  const timers = [];
  const saved = { ...mod.deps };
  Object.assign(mod.deps, {
    spawn(program, args, options) {
      const child = fakeChild();
      const call = { program, args, options, child };
      calls.push(call);
      const reply = answer(call) || {};
      if (reply.hold) call.release = (r) => settle(child, r);
      else setImmediate(() => settle(child, reply));
      return child;
    },
    setTimeout(fn, ms) { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; },
    clearTimeout(timer) { if (timer) timer.cleared = true; },
    execPath: () => APP,
    inElectron: () => true,
    extendPath: () => {},
  }, extra);
  t.after(() => { for (const key of Object.keys(mod.deps)) delete mod.deps[key]; Object.assign(mod.deps, saved); });
  return { mod, calls, timers };
}

// The timer set for a child is the one set as it starts: each start sets one.
const timerOf = (f, call) => f.timers[f.calls.indexOf(call)];

async function until(what, cond) {
  for (let i = 0; i < 500 && !cond(); i++) await new Promise((r) => setImmediate(r));
  assert.ok(cond(), `waited for ${what}`);
}

// Claude Code installed at `bin` on macOS, starting and answering at once.
const installed = (bin = MAC_BIN) => (c) => {
  if (isLookup(c)) return { stdout: `${bin}\n` };
  if (isVersion(c)) return { stdout: '2.1.0 (Claude Code)\n' };
  return {};
};

function checker(mod, platform = 'darwin', more = {}) {
  return mod.createSetupCheck({ platform, env: { PATH: '/usr/bin' }, ...more });
}

describe('the module stands alone', () => {
  test('it loads in plain Node, outside Electron', () => {
    const mod = load();
    assert.strictEqual(typeof mod.createSetupCheck, 'function');
    assert.strictEqual(typeof mod.deps.spawn, 'function');
    assert.strictEqual(mod.deps.inElectron(), false, 'plain Node is not Electron');
  });
});

describe('the check never holds the main process', () => {
  async function heldAt(t, held, platform = 'darwin') {
    const f = fakes(t, (c) => (held(c) ? { hold: true } : installed()(c)));
    const order = [];
    const done = checker(f.mod, platform).check({ signIn: false }).then(() => order.push('check ended'));
    await until('the held child to start', () => f.calls.some(held));
    setTimeout(() => order.push('timer fired'), 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(order, ['timer fired'], 'a timer set after the check started fired while its child ran');
    f.calls.find(held).release({ stdout: isLookup(f.calls.find(held)) ? `${MAC_BIN}\n` : '2.1.0\n' });
    await done;
    assert.deepStrictEqual(order, ['timer fired', 'check ended']);
  }

  test('a lookup still running holds nothing', (t) => heldAt(t, isLookup));
  test('a version run still running holds nothing', (t) => heldAt(t, isVersion));
});

describe('no shell, and only the copy that was found', () => {
  test('every child is a program and an argument list, with no shell', async (t) => {
    const f = fakes(t, installed());
    await checker(f.mod).check({ signIn: false });
    assert.ok(f.calls.length >= 2, 'the lookup and the version run were both started');
    for (const c of f.calls) {
      assert.strictEqual(typeof c.program, 'string');
      assert.ok(Array.isArray(c.args), `${c.program} is given an argument list`);
      assert.ok(!('shell' in c.options), `${c.program} is started with no shell option`);
    }
    assert.deepStrictEqual(f.calls.map((c) => [c.program, c.args]), [['which', ['claude']], [MAC_BIN, ['--version']]]);
  });

  test('on Windows a found claude.exe is started as found', async (t) => {
    const f = fakes(t, (c) => {
      if (isLookup(c)) return { stdout: `C:\\Users\\example\\AppData\\Roaming\\npm\\claude\r\n${WIN_EXE}\r\n` };
      if (isPowerShell(c)) return { stdout: 'Missing:\n' };
      return { stdout: '2.1.0\n' };
    });
    await checker(f.mod, 'win32').check({ signIn: false });
    const version = f.calls.find(isVersion);
    assert.deepStrictEqual([version.program, version.args], [WIN_EXE, ['--version']]);
    assert.strictEqual(version.options.env.ELECTRON_RUN_AS_NODE, undefined, 'a program other than the app gets no Node switch');
    assert.strictEqual(f.calls[0].program, 'where.exe');
  });

  test('on Windows a found claude.cmd is started through Node, as the app run as Node', async (t) => {
    const npm = makeTempDir('setup-check-npm-');
    const pkg = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
    fs.writeFileSync(path.join(pkg, 'cli.js'), '');
    const cmd = path.join(npm, 'claude.cmd');
    fs.writeFileSync(cmd, '');
    const f = fakes(t, (c) => {
      if (isLookup(c)) return { stdout: `${cmd}\r\n` };
      if (isPowerShell(c)) return { stdout: 'Missing:\n' };
      return { stdout: '2.1.0\n' };
    });
    await checker(f.mod, 'win32').check({ signIn: false });
    const version = f.calls.find(isVersion);
    assert.strictEqual(version.program, APP, 'the launcher itself is never started');
    assert.deepStrictEqual(version.args, [fs.realpathSync(path.join(pkg, 'cli.js')), '--version']);
    assert.strictEqual(version.options.env.ELECTRON_RUN_AS_NODE, '1', 'inside Electron the app runs as Node, never as a second window');
  });

  test('every child is given the app\'s own environment, with nothing of Rundock\'s added', async (t) => {
    const f = fakes(t, installed());
    const env = { PATH: '/usr/bin', HOME: '/home/example' };
    await f.mod.createSetupCheck({ platform: 'darwin', env }).check({ signIn: false });
    for (const c of f.calls) {
      assert.deepStrictEqual(c.options.env, env, `${c.program} is given a copy of the environment it was handed, unchanged`);
      assert.notStrictEqual(c.options.env, env, 'a copy, so a child cannot change the app\'s own');
      assert.ok(!Object.keys(c.options.env).some((k) => k.startsWith('RUNDOCK')), `${c.program} is given no mark of Rundock's`);
    }
  });

  test('outside Electron the same start is given no Node switch', async (t) => {
    const f = fakes(t, installed(), { inElectron: () => false, execPath: () => MAC_BIN });
    await checker(f.mod).check({ signIn: false });
    assert.strictEqual(f.calls.find(isVersion).options.env.ELECTRON_RUN_AS_NODE, undefined);
  });

  test('a launch plan refused gives found but not started, and starts nothing', async (t) => {
    const f = fakes(t, installed(), { launchPlan: () => ({ refusal: new Error('unreadable package') }) });
    const check = checker(f.mod);
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'found-not-started' });
    assert.deepStrictEqual(f.calls.map((c) => c.program), ['which'], 'nothing but the lookup was started');
    assert.deepStrictEqual(check.found(), { bin: null, version: null });
  });

  test("the process's PATH is given Claude Code's install folders before the lookup", async (t) => {
    const seen = [];
    const f = fakes(t, installed(), { extendPath: (env, opts) => { seen.push(opts.platform); env.PATH += ':/usr/local/bin'; } });
    const env = { PATH: '/usr/bin' };
    await f.mod.createSetupCheck({ platform: 'darwin', env }).check({ signIn: false });
    assert.deepStrictEqual(seen, ['darwin']);
    assert.strictEqual(env.PATH, '/usr/bin:/usr/local/bin', 'the environment main.js passed is extended, as ensurePath extended it');
    assert.strictEqual(f.calls[0].options.env.PATH, '/usr/bin:/usr/local/bin', 'and the lookup searches it');
  });
});

describe('found but not started is never not installed', () => {
  const versionFails = [
    ['a version run that times out', (f) => timerOf(f, f.calls.find(isVersion)).fn(), { hold: true }],
    ['a version run that exits non-zero', null, { status: 1, stderr: 'boom\n' }],
    ['a version run that fails to start', null, { error: Object.assign(new Error('spawn failed'), { code: 'EACCES' }) }],
  ];
  for (const [name, act, reply] of versionFails) {
    test(`${name} gives found but not started`, async (t) => {
      const f = fakes(t, (c) => (isVersion(c) ? reply : installed()(c)));
      const check = checker(f.mod);
      const result = check.check({ signIn: false });
      if (act) { await until('the version run', () => f.calls.some(isVersion)); act(f); }
      assert.deepStrictEqual(await result, { status: 'found-not-started' });
      assert.deepStrictEqual(check.found(), { bin: null, version: null }, 'nothing found is kept for Sign in');
    });
  }

  test('the version run is given at least 30 seconds', async (t) => {
    const f = fakes(t, installed());
    await checker(f.mod).check({ signIn: false });
    assert.ok(timerOf(f, f.calls.find(isVersion)).ms >= 30000);
  });

  test('a child still running at its timeout is told to stop', async (t) => {
    const f = fakes(t, (c) => (isVersion(c) ? { hold: true } : installed()(c)));
    const result = checker(f.mod).check({ signIn: false });
    await until('the version run', () => f.calls.some(isVersion));
    const version = f.calls.find(isVersion);
    assert.strictEqual(version.child.kills, 0);
    timerOf(f, version).fn();
    await result;
    assert.strictEqual(version.child.kills, 1, 'the timed-out child was killed');
  });

  test('a version run that prints past the output cap is stopped and reads as not started', async (t) => {
    const f = fakes(t, (c) => (isVersion(c) ? { stdout: 'x'.repeat(f.mod.OUTPUT_CAP_BYTES + 1) } : installed()(c)));
    assert.deepStrictEqual(await checker(f.mod).check({ signIn: false }), { status: 'found-not-started' });
    assert.strictEqual(f.calls.find(isVersion).child.kills, 1);
  });

  test('a version run that starts keeps the copy and its version for Sign in', async (t) => {
    const f = fakes(t, installed());
    const check = checker(f.mod);
    assert.deepStrictEqual(check.found(), { bin: null, version: null }, 'nothing before a check');
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'started' });
    assert.deepStrictEqual(check.found(), { bin: MAC_BIN, version: '2.1.0 (Claude Code)\n' });
  });
});

describe('not installed, as before', () => {
  const lookupFails = [
    ['exits non-zero', null, { status: 1 }],
    ['prints nothing', null, { stdout: '\n' }],
    ['times out', (f) => timerOf(f, f.calls[0]).fn(), { hold: true }],
  ];
  for (const [name, act, reply] of lookupFails) {
    test(`a lookup that ${name} gives not installed, and nothing else is started`, async (t) => {
      const f = fakes(t, (c) => (isLookup(c) ? reply : installed()(c)));
      const check = checker(f.mod, 'win32');
      const result = check.check({ signIn: false });
      if (act) { await until('the lookup', () => f.calls.length === 1); act(f); }
      assert.deepStrictEqual(await result, { status: 'not-installed' });
      assert.deepStrictEqual(f.calls.map((c) => c.program), ['where.exe']);
      assert.deepStrictEqual(check.found(), { bin: null, version: null });
    });
  }
});

// Overlapping requests from the polling screen share the check already
// running, so a poll every few seconds never piles up children.
describe('one check at a time', () => {
  test('three overlapping requests share one check, and one set of starts', async (t) => {
    const f = fakes(t, (c) => (isLookup(c) ? { hold: true } : installed()(c)));
    const check = checker(f.mod);
    const results = [check.check({ signIn: false }), check.check({ signIn: false }), check.check({ signIn: false })];
    await until('the lookup', () => f.calls.length === 1);
    f.calls[0].release({ stdout: `${MAC_BIN}\n` });
    for (const result of await Promise.all(results)) assert.deepStrictEqual(result, { status: 'started' });
    assert.deepStrictEqual(f.calls.map((c) => c.program), ['which', MAC_BIN], 'one lookup and one version run for all three');
  });

  test('a request after the check ended starts a fresh one', async (t) => {
    const f = fakes(t, installed());
    const check = checker(f.mod);
    await check.check({ signIn: false });
    await check.check({ signIn: false });
    assert.deepStrictEqual(f.calls.map((c) => c.program), ['which', MAC_BIN, 'which', MAC_BIN]);
  });

  test('after found but not started, the next check can start it', async (t) => {
    let versions = 0;
    const f = fakes(t, (c) => (isVersion(c) && ++versions === 1 ? { status: 1 } : installed()(c)));
    const check = checker(f.mod);
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'found-not-started' });
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'started' });
    assert.strictEqual(check.found().bin, MAC_BIN);
  });
});

// On Windows the folder Claude Code was found in goes on the User PATH as soon
// as it is found, so a new PowerShell window recognises `claude` even while its
// first start is still slow.
const WIN_FOLDER = 'C:\\Users\\example\\.local\\bin';
const WIN_ENV = { PATH: 'C:\\Windows', USERPROFILE: 'C:\\Users\\example' };
const POWERSHELL_ARGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
const isPathRead = (c) => isPowerShell(c) && c.args.at(-1) === load().READ_SCRIPT;
const isPathWrite = (c) => isPowerShell(c) && c.args.at(-1) === load().WRITE_SCRIPT;
const stored = (kind, value = '') => ({ stdout: `${kind}:${Buffer.from(value, 'utf8').toString('base64')}` });

function onWindows({ bin = WIN_EXE, read = stored('ExpandString', 'C:\\Windows'), write = { stdout: 'written' }, version = { stdout: '2.1.0\n' } } = {}) {
  return (c) => {
    if (isLookup(c)) return { stdout: `${bin}\r\n` };
    if (isPathRead(c)) return typeof read === 'function' ? read() : read;
    if (isPathWrite(c)) return typeof write === 'function' ? write() : write;
    if (isVersion(c)) return version;
    return {};
  };
}
const onWin = (mod) => mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV } });
const step = (c) => (isLookup(c) ? 'lookup' : isPathRead(c) ? 'path read' : isPathWrite(c) ? 'path write' : isVersion(c) ? 'version' : c.program);

describe('the User PATH is written as soon as Claude Code is found', () => {
  test('on Windows the PATH is read and written before the version run starts', async (t) => {
    const f = fakes(t, onWindows());
    assert.deepStrictEqual(await onWin(f.mod).check({ signIn: false }), { status: 'started' });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'path write', 'version']);
    const write = f.calls.find(isPathWrite);
    assert.deepStrictEqual(write.args, [...POWERSHELL_ARGS, f.mod.WRITE_SCRIPT]);
    assert.deepStrictEqual(f.calls.find(isPathRead).args, [...POWERSHELL_ARGS, f.mod.READ_SCRIPT]);
    const env = write.options.env;
    assert.deepStrictEqual(
      [env.SETUP_CHECK_PATH_KIND, env.SETUP_CHECK_PATH_OLD, env.SETUP_CHECK_PATH_NEW, env.SETUP_CHECK_PATH_WRITE_KIND],
      ['ExpandString', 'C:\\Windows', `C:\\Windows;${WIN_FOLDER}`, 'ExpandString']);
  });

  const versionFails = [
    ['times out', (f) => timerOf(f, f.calls.find(isVersion)).fn(), { hold: true }],
    ['exits non-zero', null, { status: 1 }],
  ];
  for (const [name, act, version] of versionFails) {
    test(`the PATH is written even when the version run ${name}`, async (t) => {
      const f = fakes(t, onWindows({ version }));
      const result = onWin(f.mod).check({ signIn: false });
      if (act) { await until('the version run', () => f.calls.some(isVersion)); act(f); }
      assert.deepStrictEqual(await result, { status: 'found-not-started' });
      assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'path write', 'version']);
    });
  }

  test('the PATH is written when the launch plan is refused', async (t) => {
    const f = fakes(t, onWindows(), { launchPlan: () => ({ refusal: new Error('unreadable package') }) });
    assert.deepStrictEqual(await onWin(f.mod).check({ signIn: false }), { status: 'found-not-started' });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'path write']);
  });

  for (const platform of ['darwin', 'linux']) {
    test(`on ${platform} no User PATH is read or written`, async (t) => {
      const f = fakes(t, installed());
      await checker(f.mod, platform).check({ signIn: false });
      assert.ok(!f.calls.some(isPowerShell), 'no PowerShell is started');
    });
  }

  test('a lookup that finds nothing writes nothing', async (t) => {
    const f = fakes(t, (c) => (isLookup(c) ? { status: 1 } : onWindows()(c)));
    assert.deepStrictEqual(await onWin(f.mod).check({ signIn: false }), { status: 'not-installed' });
    assert.deepStrictEqual(f.calls.map(step), ['lookup']);
  });

  test('a folder already on the User PATH is not written, and not read again in the same run', async (t) => {
    const f = fakes(t, onWindows({ read: stored('ExpandString', 'C:\\Windows;%USERPROFILE%\\.local\\bin') }));
    const check = onWin(f.mod);
    await check.check({ signIn: false });
    await check.check({ signIn: false });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'version', 'lookup', 'version']);
  });

  test('a folder written is not written again in the same run', async (t) => {
    const f = fakes(t, onWindows());
    const check = onWin(f.mod);
    await check.check({ signIn: false });
    await check.check({ signIn: false });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'path write', 'version', 'lookup', 'version']);
  });

  const writeFails = [
    ['exits non-zero', null, { status: 1 }],
    ['times out', (f) => timerOf(f, f.calls.find(isPathWrite)).fn(), { hold: true }],
    ['finds the value changed since it was read', null, { stdout: 'stale' }],
    ['says nothing', null, { stdout: '' }],
  ];
  for (const [name, act, reply] of writeFails) {
    test(`a write that ${name} is tried again at the next check, and the version run still starts`, async (t) => {
      let writes = 0;
      const f = fakes(t, onWindows({ write: () => (++writes === 1 ? reply : { stdout: 'written' }) }));
      const check = onWin(f.mod);
      const first = check.check({ signIn: false });
      if (act) { await until('the write', () => f.calls.some(isPathWrite)); act(f); }
      assert.deepStrictEqual(await first, { status: 'started' });
      await check.check({ signIn: false });
      await check.check({ signIn: false });
      assert.deepStrictEqual(f.calls.map(step), [
        'lookup', 'path read', 'path write', 'version',
        'lookup', 'path read', 'path write', 'version',
        'lookup', 'version']);
    });
  }

  test('a read that fails writes nothing, and is tried again at the next check', async (t) => {
    let reads = 0;
    const f = fakes(t, onWindows({ read: () => (++reads === 1 ? { status: 1 } : stored('ExpandString', 'C:\\Windows')) }));
    const check = onWin(f.mod);
    await check.check({ signIn: false });
    await check.check({ signIn: false });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'version', 'lookup', 'path read', 'path write', 'version']);
  });

  test('a value stored as REG_SZ is written back as REG_SZ', async (t) => {
    const f = fakes(t, onWindows({ read: stored('String', 'C:\\Windows') }));
    await onWin(f.mod).check({ signIn: false });
    const write = f.calls.find(isPathWrite);
    assert.ok(write, 'a write was started');
    const env = write.options.env;
    assert.deepStrictEqual([env.SETUP_CHECK_PATH_KIND, env.SETUP_CHECK_PATH_WRITE_KIND], ['String', 'String']);
  });

  test('a missing value is created as REG_EXPAND_SZ holding the folder alone', async (t) => {
    const f = fakes(t, onWindows({ read: stored('Missing') }));
    await onWin(f.mod).check({ signIn: false });
    const write = f.calls.find(isPathWrite);
    assert.ok(write, 'a write was started');
    const env = write.options.env;
    assert.deepStrictEqual(
      [env.SETUP_CHECK_PATH_KIND, env.SETUP_CHECK_PATH_OLD, env.SETUP_CHECK_PATH_NEW, env.SETUP_CHECK_PATH_WRITE_KIND],
      ['Missing', '', WIN_FOLDER, 'ExpandString']);
  });

  for (const kind of ['MultiString', 'Binary', 'DWord']) {
    test(`a value of kind ${kind} is left alone`, async (t) => {
      const f = fakes(t, onWindows({ read: stored(kind, 'C:\\Windows') }));
      await onWin(f.mod).check({ signIn: false });
      assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'version']);
    });
  }

  test('a read that answers in any other form writes nothing', async (t) => {
    const f = fakes(t, onWindows({ read: { stdout: 'ExpandString C:\\Windows' } }));
    await onWin(f.mod).check({ signIn: false });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'version']);
  });

  test('a folder reaches PowerShell only as data, whatever it holds', async (t) => {
    const folders = [
      "C:\\Users\\o'brien\\.local\\bin",
      'C:\\Users\\a"b\\.local\\bin',
      'C:\\Tools;x\\bin',
      'C:\\R&D\\bin',
      'C:\\Users\\`x\\bin',
      'C:\\$(whoami)\\bin',
      'C:\\%USERPROFILE%\\bin',
    ];
    for (const folder of folders) {
      const f = fakes(t, onWindows({ bin: `${folder}\\claude.exe` }));
      await onWin(f.mod).check({ signIn: false });
      const write = f.calls.find(isPathWrite);
      assert.ok(write, `a write was started for ${folder}`);
      assert.deepStrictEqual(write.args, [...POWERSHELL_ARGS, f.mod.WRITE_SCRIPT], `the script is the same fixed text for ${folder}`);
      assert.strictEqual(write.options.env.SETUP_CHECK_PATH_NEW, `C:\\Windows;${folder}`, 'and the folder reaches it unchanged, as data');
    }
  });
});
