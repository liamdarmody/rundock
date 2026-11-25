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
  // `answer` answers every child but the held one, which is released with
  // `reply` once a timer set after it started has fired.
  async function heldAt(t, held, { platform = 'darwin', answer = installed(), signIn = false, reply = {} } = {}) {
    const f = fakes(t, (c) => (held(c) ? { hold: true } : answer(c)));
    const order = [];
    const check = platform === 'win32' ? onWin(f.mod) : checker(f.mod, platform);
    const done = check.check({ signIn }).then(() => order.push('check ended'));
    await until('the held child to start', () => f.calls.some(held));
    setTimeout(() => order.push('timer fired'), 0);
    await new Promise((r) => setTimeout(r, 20));
    assert.deepStrictEqual(order, ['timer fired'], 'a timer set after the check started fired while its child ran');
    f.calls.find(held).release(reply);
    await done;
    assert.deepStrictEqual(order, ['timer fired', 'check ended']);
  }

  test('a lookup still running holds nothing', (t) => heldAt(t, isLookup, { reply: { stdout: `${MAC_BIN}\n` } }));
  test('a User PATH write still running holds nothing', (t) => heldAt(t, (c) => isPathWrite(c),
    { platform: 'win32', answer: onWindows(), reply: { stdout: 'written' } }));
  test('a version run still running holds nothing', (t) => heldAt(t, isVersion, { reply: { stdout: '2.1.0\n' } }));
  test('a sign-in check still running holds nothing', (t) => heldAt(t, (c) => isSignIn(c), { signIn: true }));
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

  test('a PATH extender passed in runs before each lookup, in place of the default', async (t) => {
    const order = [];
    const env = { PATH: '/usr/bin' };
    const f = fakes(t, (c) => { order.push(`start ${c.program}`); return installed()(c); },
      { extendPath: () => { order.push('default'); } });
    const check = f.mod.createSetupCheck({ platform: 'darwin', env, extendPath: () => { order.push('extend'); env.PATH += ':/opt/example/bin'; } });
    await check.check({ signIn: false });
    await check.check({ signIn: false });
    assert.deepStrictEqual(order, ['extend', 'start which', `start ${MAC_BIN}`, 'extend', 'start which', `start ${MAC_BIN}`]);
    assert.strictEqual(f.calls[0].options.env.PATH, '/usr/bin:/opt/example/bin', 'the lookup searches the PATH it extended');
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

// The sign-in check runs as on main, on the copy that was found, and still
// through the routing that may read the login shell's CLAUDE_CONFIG_DIR.
const { createSignInReason } = require('../../electron/sign-in-reason.js');
const SIGN_IN_ARGS = ['--print', 'test', '--output-format', 'text'];
const isSignIn = (c) => c.args.includes('--print');
const runsOnce = { checkAuthenticated: (run) => run() };
const signedIn = (more = {}) => (c) => (isSignIn(c) ? more.signIn || {} : installed()(c));

describe('the sign-in check, as on main', () => {
  test('it starts the found copy with --print test --output-format text, given 15 seconds, and exit 0 is ready', async (t) => {
    const f = fakes(t, signedIn());
    assert.deepStrictEqual(await checker(f.mod, 'darwin', { shellConfigDir: runsOnce }).check(), { status: 'ready' });
    assert.deepStrictEqual(f.calls.map((c) => [c.program, c.args]), [['which', ['claude']], [MAC_BIN, ['--version']], [MAC_BIN, SIGN_IN_ARGS]]);
    assert.strictEqual(timerOf(f, f.calls.find(isSignIn)).ms, 15000);
  });

  test('on Windows a found claude.cmd is signed in through Node, as the app run as Node', async (t) => {
    const npm = makeTempDir('setup-check-npm-');
    const pkg = path.join(npm, 'node_modules', '@anthropic-ai', 'claude-code');
    fs.mkdirSync(pkg, { recursive: true });
    fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ bin: { claude: 'cli.js' } }));
    fs.writeFileSync(path.join(pkg, 'cli.js'), '');
    const cmd = path.join(npm, 'claude.cmd');
    fs.writeFileSync(cmd, '');
    const f = fakes(t, (c) => (isSignIn(c) ? {} : onWindows({ bin: cmd, read: stored('ExpandString', path.win32.dirname(cmd)) })(c)));
    assert.deepStrictEqual(await f.mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV }, shellConfigDir: runsOnce }).check(), { status: 'ready' });
    const signIn = f.calls.find(isSignIn);
    assert.strictEqual(signIn.program, APP);
    assert.deepStrictEqual(signIn.args, [fs.realpathSync(path.join(pkg, 'cli.js')), ...SIGN_IN_ARGS]);
    assert.strictEqual(signIn.options.env.ELECTRON_RUN_AS_NODE, '1');
  });

  test('it runs through checkAuthenticated, and a run again sees the value that routing took', async (t) => {
    let signIns = 0;
    const f = fakes(t, (c) => (isSignIn(c) ? (++signIns === 1 ? { status: 1 } : {}) : installed()(c)));
    const env = { PATH: '/usr/bin' };
    const routing = {
      async checkAuthenticated(run) {
        if (await run()) return true;
        env.CLAUDE_CONFIG_DIR = '/home/example/.claude-work';
        return run();
      },
    };
    assert.deepStrictEqual(await f.mod.createSetupCheck({ platform: 'darwin', env, shellConfigDir: routing }).check(), { status: 'ready' });
    const runs = f.calls.filter(isSignIn);
    assert.strictEqual(runs.length, 2);
    assert.strictEqual(runs[0].options.env.CLAUDE_CONFIG_DIR, undefined);
    assert.strictEqual(runs[1].options.env.CLAUDE_CONFIG_DIR, '/home/example/.claude-work', 'each run is given the environment as it is when it starts');
  });

  test('a check that does not start the copy runs no sign-in', async (t) => {
    const f = fakes(t, (c) => (isVersion(c) ? { status: 1 } : signedIn()(c)));
    assert.deepStrictEqual(await checker(f.mod, 'darwin', { shellConfigDir: runsOnce }).check(), { status: 'found-not-started' });
    assert.ok(!f.calls.some(isSignIn));
  });

  test('a check asked not to sign in stops at started', async (t) => {
    const f = fakes(t, signedIn());
    assert.deepStrictEqual(await checker(f.mod, 'darwin', { shellConfigDir: runsOnce }).check({ signIn: false }), { status: 'started' });
    assert.ok(!f.calls.some(isSignIn));
  });

  test('three overlapping sign-in requests share one sign-in check', async (t) => {
    const f = fakes(t, (c) => (isSignIn(c) ? { hold: true } : installed()(c)));
    const check = checker(f.mod, 'darwin', { shellConfigDir: runsOnce });
    const results = [check.check(), check.check(), check.check()];
    await until('the sign-in check', () => f.calls.some(isSignIn));
    // Counted before any is released, so a second sign-in check fails here
    // rather than leaving its request waiting for ever.
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(f.calls.filter(isSignIn).length, 1);
    f.calls.find(isSignIn).release({});
    for (const result of await Promise.all(results)) assert.deepStrictEqual(result, { status: 'ready' });
  });

  test('a copy found and started is kept for Sign in even when it is not signed in', async (t) => {
    const f = fakes(t, signedIn({ signIn: { status: 1 } }));
    const check = checker(f.mod, 'darwin', { shellConfigDir: runsOnce });
    assert.strictEqual((await check.check()).status, 'not-authenticated');
    assert.deepStrictEqual(check.found(), { bin: MAC_BIN, version: '2.1.0 (Claude Code)\n' });
  });
});

describe('a failed sign-in check gives the reason main gives', () => {
  async function reasonOf(t, reply, act) {
    const f = fakes(t, signedIn({ signIn: reply }));
    const holder = createSignInReason();
    const result = checker(f.mod, 'darwin', { shellConfigDir: runsOnce, signInReason: holder }).check();
    if (act) { await until('the sign-in check', () => f.calls.some(isSignIn)); act(f); }
    const answer = await result;
    assert.strictEqual(answer.status, 'not-authenticated');
    assert.deepStrictEqual(answer.reason, holder.last(), "the reason is the one main's holder keeps");
    return answer.reason;
  }

  test('a sign-in check still running at 15 seconds gives timeout, and is stopped', async (t) => {
    let signIn = null;
    const reason = await reasonOf(t, { hold: true }, (f) => { signIn = f.calls.find(isSignIn); timerOf(f, signIn).fn(); });
    assert.deepStrictEqual(reason, { kind: 'timeout' });
    assert.strictEqual(signIn.child.kills, 1);
  });

  test('a sign-in check that cannot start gives not-started', async (t) => {
    assert.deepStrictEqual(await reasonOf(t, { error: Object.assign(new Error('spawn failed'), { code: 'ENOENT' }) }), { kind: 'not-started' });
  });

  test('a sign-in check that exits non-zero gives the first line it printed', async (t) => {
    const reason = await reasonOf(t, { status: 1, stderr: '\nInvalid API key \u00b7 Please run /login\nsecond line\n' });
    assert.deepStrictEqual(reason, { kind: 'said', text: 'Invalid API key \u00b7 Please run /login', signIn: true });
  });

  test('a check that passes after one that failed leaves no reason', async (t) => {
    let signIns = 0;
    const f = fakes(t, (c) => (isSignIn(c) ? (++signIns === 1 ? { status: 1, stderr: 'boom\n' } : {}) : installed()(c)));
    const holder = createSignInReason();
    const check = checker(f.mod, 'darwin', { shellConfigDir: runsOnce, signInReason: holder });
    assert.strictEqual((await check.check()).status, 'not-authenticated');
    assert.deepStrictEqual(await check.check(), { status: 'ready' });
    assert.strictEqual(holder.last(), null);
  });

  test('a routing that fails without running the check gives what the holder kept, as main read it', async (t) => {
    const f = fakes(t, installed());
    const holder = createSignInReason();
    const failsWithoutRunning = { checkAuthenticated: async () => false };
    const check = checker(f.mod, 'darwin', { shellConfigDir: failsWithoutRunning, signInReason: holder });
    assert.deepStrictEqual(await check.check(), { status: 'not-authenticated', reason: null }, 'nothing kept yet');
    holder.failed(Object.assign(new Error('failed'), { status: 1, stderr: Buffer.from('boom\n') }));
    assert.deepStrictEqual(await check.check(), { status: 'not-authenticated', reason: holder.last() });
    assert.ok(!f.calls.some(isSignIn));
  });
});

// The setup log: one line per step in the app's user-data folder, safe to hand
// over unread.
const LINE = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z (lookup|path-write|version|sign-in|request) ([a-z-]+) (\d+)ms$/;
const logOf = (dir) => fs.readFileSync(path.join(dir, 'setup-check.log'), 'utf8');
const logLines = (dir) => logOf(dir).split('\n').filter(Boolean);
const ticking = () => { let clock = Date.UTC(2026, 0, 2, 3, 4, 5); return () => (clock += 7); };

describe('the setup log', () => {
  test('each step is logged with an ISO time, the step, a fixed outcome and its milliseconds', async (t) => {
    const appData = makeTempDir('setup-check-log-');
    const f = fakes(t, (c) => (isSignIn(c) ? {} : onWindows()(c)), { now: ticking() });
    await f.mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV }, appData, shellConfigDir: runsOnce }).check();
    const lines = logLines(appData);
    for (const line of lines) assert.ok(LINE.test(line), `a log line in the fixed form: ${line}`);
    assert.deepStrictEqual(lines.map((l) => l.split(' ').slice(1, 3).join(' ')),
      ['lookup found', 'path-write written', 'version started', 'sign-in passed']);
    assert.deepStrictEqual(lines.map((l) => l.split(' ')[3]), ['7ms', '7ms', '7ms', '7ms'], 'each step its own elapsed time');
  });

  test('each outcome is a fixed word', async (t) => {
    const appData = makeTempDir('setup-check-log-');
    let round = 0;
    const f = fakes(t, (c) => {
      if (isLookup(c)) return round === 0 ? { status: 1 } : { stdout: `${WIN_EXE}\r\n` };
      if (isPathRead(c)) return stored('ExpandString', 'C:\\Windows');
      if (isPathWrite(c)) return { stdout: 'stale' };
      if (isVersion(c)) return round === 1 ? { status: 1 } : { stdout: '2.1.0\n' };
      // Only the sign-in check is held: a child this test does not expect
      // answers at once, so the test fails on its log rather than waiting.
      return isSignIn(c) ? { hold: true } : {};
    }, { now: ticking() });
    const check = f.mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV }, appData, shellConfigDir: runsOnce });
    await check.check(); round = 1;
    await check.check(); round = 2;
    const third = check.check();
    await until('the sign-in check', () => f.calls.some(isSignIn));
    timerOf(f, f.calls.find(isSignIn)).fn();
    await third;
    assert.deepStrictEqual(logLines(appData).map((l) => l.split(' ').slice(1, 3).join(' ')), [
      'lookup none',
      'lookup found', 'path-write stale', 'version failed',
      'lookup found', 'path-write stale', 'version started', 'sign-in timeout',
    ]);
  });

  test('a joined request is logged', async (t) => {
    const appData = makeTempDir('setup-check-log-');
    const f = fakes(t, (c) => (isLookup(c) ? { hold: true } : installed()(c)));
    const check = checker(f.mod, 'darwin', { appData });
    const results = [check.check({ signIn: false }), check.check({ signIn: false }), check.check({ signIn: false })];
    await until('the lookup', () => f.calls.length >= 1);
    // Every lookup held is released, so requests that did not join still end
    // and the log below says what they did.
    await new Promise((r) => setTimeout(r, 20));
    for (const c of f.calls.filter(isLookup)) c.release({ stdout: `${MAC_BIN}\n` });
    await Promise.all(results);
    assert.deepStrictEqual(logLines(appData).map((l) => l.split(' ').slice(1, 3).join(' ')),
      ['request joined', 'request joined', 'lookup found', 'version started']);
  });

  test('the log keeps its last 200 lines', async (t) => {
    const appData = makeTempDir('setup-check-log-');
    fs.writeFileSync(path.join(appData, 'setup-check.log'), Array.from({ length: 250 }, (_, i) => `old ${i}`).join('\n') + '\n');
    const f = fakes(t, installed());
    await checker(f.mod, 'darwin', { appData }).check({ signIn: false });
    const lines = logLines(appData);
    assert.strictEqual(lines.length, 200);
    assert.strictEqual(lines[0], 'old 52');
    assert.ok(LINE.test(lines[199]) && lines[199].includes(' version started '), 'the newest line is last');
  });

  test('no path, output or error text ever reaches the log', async (t) => {
    const appData = makeTempDir('setup-check-log-');
    const S = 'SENTINEL';
    const folder = `C:\\Users\\${S}\\.local\\bin`;
    let round = 0;
    const f = fakes(t, (c) => {
      if (isLookup(c)) return round === 0 ? { status: 1, stderr: `${S} not found\n` } : { stdout: `${folder}\\claude.exe\r\n` };
      if (isPathRead(c)) return round === 1 ? { status: 1, stderr: `${S} denied` } : stored('ExpandString', `C:\\${S}`);
      if (isPathWrite(c)) return { stdout: `${S}`, stderr: `${S}` };
      if (isVersion(c)) return round === 2 ? { error: Object.assign(new Error(`spawn ${folder} EACCES`), { code: 'EACCES', path: folder }) } : { stdout: `${S} 2.1.0\n` };
      return { status: 1, stderr: `${S}: Invalid API key at ${folder}\n`, stdout: `/home/${S}/x` };
    }, { now: ticking() });
    const check = f.mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV, HOME: `/home/${S}` }, appData, shellConfigDir: runsOnce });
    for (round = 0; round < 4; round++) await check.check();
    const log = logOf(appData);
    assert.ok(logLines(appData).length >= 10, 'sanity: the rounds were logged');
    assert.ok(!log.includes(S), 'the sentinel never reaches the log');
    assert.ok(!log.includes('/') && !log.includes('\\'), 'no path separator reaches the log');
  });

  test('a log that cannot be written changes nothing', async (t) => {
    const broken = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    const plain = fakes(t, installed());
    const expected = await checker(plain.mod, 'darwin', { shellConfigDir: runsOnce }).check();
    const starts = plain.calls.map((c) => [c.program, c.args]);
    const f = fakes(t, installed(), { fs: { readFileSync: broken, writeFileSync: broken, appendFileSync: broken } });
    const answer = await checker(f.mod, 'darwin', { shellConfigDir: runsOnce, appData: makeTempDir('setup-check-log-') }).check();
    assert.deepStrictEqual(answer, expected);
    assert.deepStrictEqual(f.calls.map((c) => [c.program, c.args]), starts, 'the same children, in the same order');
    assert.strictEqual(f.timers.length, f.calls.length, 'and no timer beyond one for each child: nothing waits on the log');
  });
});

// The five sequences, each run end to end through the module. The fourth also
// runs through the setup screen, in wizard-found-not-started.test.js.
const stage = (c) => (isSignIn(c) ? 'sign-in' : step(c));
const ALREADY_ON_PATH = stored('ExpandString', 'C:\\Windows;%USERPROFILE%\\.local\\bin');

describe('the five sequences', () => {
  test('1, the inverse, on Windows: installed, quick to start and signed in reads ready, and a folder already on the User PATH is not written', async (t) => {
    const f = fakes(t, (c) => (isSignIn(c) ? {} : onWindows({ read: ALREADY_ON_PATH })(c)));
    assert.deepStrictEqual(await f.mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV }, shellConfigDir: runsOnce }).check(), { status: 'ready' });
    assert.deepStrictEqual(f.calls.map(stage), ['lookup', 'path read', 'version', 'sign-in']);
  });

  test('1, the inverse, on macOS: ready as on main, with nothing read or written', async (t) => {
    const f = fakes(t, signedIn());
    assert.deepStrictEqual(await checker(f.mod, 'darwin', { shellConfigDir: runsOnce }).check(), { status: 'ready' });
    assert.deepStrictEqual(f.calls.map(stage), ['lookup', 'version', 'sign-in']);
  });

  test('2, the undo: with the screen closed mid-check, each child is stopped at its own timeout, and the one write is guarded', async (t) => {
    const f = fakes(t, (c) => (isPathWrite(c) || isVersion(c) ? { hold: true } : onWindows()(c)));
    const unread = onWin(f.mod).check({ signIn: false });
    await until('the write', () => f.calls.some(isPathWrite));
    const write = f.calls.find(isPathWrite);
    timerOf(f, write).fn();
    assert.strictEqual(write.child.kills, 1, 'the write is stopped at its timeout');
    await until('the version run', () => f.calls.some(isVersion));
    const version = f.calls.find(isVersion);
    timerOf(f, version).fn();
    assert.strictEqual(version.child.kills, 1, 'and the version run at its own');
    assert.deepStrictEqual(await unread, { status: 'found-not-started' });
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'path write', 'version'], 'nothing more starts');
    assert.strictEqual(write.options.env.SETUP_CHECK_PATH_OLD, 'C:\\Windows', 'the write carries the value it read');
    const script = f.mod.WRITE_SCRIPT;
    assert.ok(script.indexOf("Write('stale')") < script.indexOf('$k.SetValue('), 'and writes nothing when the value changed under it');
  });

  test('3, the retry: Check again joins a running check, a fresh check after found-not-started starts it, and a failed write is tried again', async (t) => {
    let versions = 0;
    let writes = 0;
    const win = onWindows({ write: () => (++writes === 1 ? { status: 1 } : { stdout: 'written' }) });
    const f = fakes(t, (c) => (isVersion(c) && ++versions === 1 ? { hold: true } : win(c)));
    const check = onWin(f.mod);
    const first = check.check({ signIn: false });
    await until('the version run', () => f.calls.some(isVersion));
    const again = check.check({ signIn: false });
    timerOf(f, f.calls.find(isVersion)).fn();
    assert.deepStrictEqual(await Promise.all([first, again]), [{ status: 'found-not-started' }, { status: 'found-not-started' }]);
    assert.deepStrictEqual(f.calls.map(step), ['lookup', 'path read', 'path write', 'version'], 'Check again started nothing of its own');
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'started' });
    assert.deepStrictEqual(f.calls.map(step), [
      'lookup', 'path read', 'path write', 'version',
      'lookup', 'path read', 'path write', 'version']);
  });

  test('5, the control failing: nothing found writes nothing, a refused launch plan reads as found, a stale read writes nothing, and a broken log changes nothing', async (t) => {
    let round = 0;
    const win = onWindows({ write: () => (round === 1 ? { stdout: 'stale' } : { stdout: 'written' }) });
    const f = fakes(t, (c) => (isLookup(c) && round === 0 ? { status: 1 } : win(c)));
    const plan = f.mod.deps.launchPlan;
    const check = f.mod.createSetupCheck({ platform: 'win32', env: { ...WIN_ENV }, appData: makeTempDir('setup-check-log-') });
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'not-installed' });
    assert.deepStrictEqual(f.calls.map(step), ['lookup']);
    round = 1;
    f.mod.deps.launchPlan = () => ({ refusal: new Error('unreadable package') });
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'found-not-started' });
    assert.deepStrictEqual(f.calls.map(step).slice(1), ['lookup', 'path read', 'path write'], 'the stale write wrote nothing, so it runs again next time');
    round = 2;
    f.mod.deps.launchPlan = plan;
    const broken = () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); };
    f.mod.deps.fs = { readFileSync: broken, writeFileSync: broken, appendFileSync: broken };
    assert.deepStrictEqual(await check.check({ signIn: false }), { status: 'started' });
    assert.deepStrictEqual(f.calls.map(step).slice(4), ['lookup', 'path read', 'path write', 'version']);
  });
});
