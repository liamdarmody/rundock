// Tests for reading CLAUDE_CONFIG_DIR from the login shell
// (electron/shell-config-dir.js).
//
// The packaged app opened from the Finder starts without the login shell's
// environment. When a sign-in check fails, the app may run the person's login
// shell once to read CLAUDE_CONFIG_DIR, and takes it only when it names the
// default folder. The properties these tests defend: the shell is run only
// where it can help, only one value ever crosses, and that value is taken only
// when it resolves to <home>/.claude.
//
// No test runs the person's real shell or profile, or reads their home folder:
// each builds a temporary home with its own .claude.

const { test, describe, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { makeTempDir } = require('../helpers/workspace.js');
const { fakeShell, tokenOf } = require('../helpers/fake-login-shell.js');
const scd = require('../../electron/shell-config-dir.js');

const { mayRun, gate } = scd;

// A temporary home with its own .claude, and somewhere else to point at.
function tempHome() {
  const home = makeTempDir('shell-config-home-');
  const claudeDir = path.join(home, '.claude');
  fs.mkdirSync(claudeDir);
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere);
  return { home, claudeDir, elsewhere };
}

const SYMLINK_SKIP = process.platform === 'win32'
  ? 'making a directory link on Windows needs a privilege the CI runner does not have'
  : false;

describe('where the read may run', () => {
  test('the packaged app on macOS may run it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'darwin', env: {} }), true);
  });

  test('a missing environment is treated as no smoke test', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'darwin' }), true);
  });

  test('a dev run never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: false, platform: 'darwin', env: {} }), false);
  });

  test('Linux never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'linux', env: {} }), false);
  });

  test('Windows never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'win32', env: {} }), false);
  });

  test('a smoke test never runs it', () => {
    assert.strictEqual(mayRun({ isPackaged: true, platform: 'darwin', env: { RUNDOCK_SMOKE_TEST: '1' } }), false);
  });
});

describe('the gate takes only the default folder', () => {
  test('the default folder is taken, as written', () => {
    const { home, claudeDir } = tempHome();
    assert.strictEqual(gate(claudeDir, { home, platform: process.platform }), claudeDir);
  });

  test('the default folder written with a trailing separator is taken, as written', () => {
    const { home, claudeDir } = tempHome();
    const written = claudeDir + path.sep;
    assert.strictEqual(gate(written, { home, platform: process.platform }), written);
  });

  test('a relative path is dropped', () => {
    const { home } = tempHome();
    assert.strictEqual(gate('.claude', { home, platform: process.platform }), null);
    assert.strictEqual(gate(path.join('..', path.basename(home), '.claude'), { home, platform: process.platform }), null);
  });

  test('a folder that does not exist is dropped', () => {
    const { home } = tempHome();
    assert.strictEqual(gate(path.join(home, 'missing'), { home, platform: process.platform }), null);
  });

  test('a file is dropped, even one at the default path', () => {
    const home = makeTempDir('shell-config-home-');
    const file = path.join(home, '.claude');
    fs.writeFileSync(file, 'not a folder');
    assert.strictEqual(gate(file, { home, platform: process.platform }), null);
  });

  test('another folder is dropped', () => {
    const { home, elsewhere } = tempHome();
    assert.strictEqual(gate(elsewhere, { home, platform: process.platform }), null);
  });

  test('a link to another folder is dropped', { skip: SYMLINK_SKIP }, () => {
    const { home, elsewhere } = tempHome();
    const link = path.join(home, 'looks-like-claude');
    fs.symlinkSync(elsewhere, link, 'dir');
    assert.strictEqual(gate(link, { home, platform: process.platform }), null);
  });

  test('a link that resolves to the default folder is taken, as written', { skip: SYMLINK_SKIP }, () => {
    const { home, claudeDir } = tempHome();
    const link = path.join(home, 'claude-link');
    fs.symlinkSync(claudeDir, link, 'dir');
    assert.strictEqual(gate(link, { home, platform: process.platform }), link);
  });

  test('nothing is taken when the home has no .claude', () => {
    const home = makeTempDir('shell-config-home-');
    const other = path.join(home, 'other');
    fs.mkdirSync(other);
    assert.strictEqual(gate(other, { home, platform: process.platform }), null);
    assert.strictEqual(gate(path.join(home, '.claude'), { home, platform: process.platform }), null);
  });

  test('anything but a string is dropped', () => {
    const { home } = tempHome();
    for (const value of [null, undefined, 42, ['x'], { CLAUDE_CONFIG_DIR: path.join(home, '.claude') }, '']) {
      assert.strictEqual(gate(value, { home, platform: process.platform }), null);
    }
  });

  describe('case', () => {
    const real = scd.deps.fs;
    // A disk that keeps the case it is given, as macOS's usually does while
    // ignoring it: the two spellings name one existing folder.
    const caseKeeping = {
      statSync: () => ({ isDirectory: () => true }),
      realpathSync: (p) => p,
    };
    const home = path.join(path.sep, 'home-x');

    test('on macOS the comparison ignores case', () => {
      scd.deps.fs = caseKeeping;
      try {
        const written = path.join(home, '.Claude');
        assert.strictEqual(gate(written, { home, platform: 'darwin' }), written);
      } finally {
        scd.deps.fs = real;
      }
    });

    test('elsewhere the comparison keeps case', () => {
      scd.deps.fs = caseKeeping;
      try {
        assert.strictEqual(gate(path.join(home, '.Claude'), { home, platform: 'linux' }), null);
      } finally {
        scd.deps.fs = real;
      }
    });
  });
});

// ── The read ──

const REAL_SHELL_SKIP = process.platform === 'win32'
  ? 'the read runs a POSIX login shell, which Windows does not have, and it never runs there'
  : false;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Replaces some of the module's effects for the length of fn, then puts them back.
async function withDeps(patch, fn) {
  const saved = {};
  for (const k of Object.keys(patch)) { saved[k] = scd.deps[k]; scd.deps[k] = patch[k]; }
  try { return await fn(); } finally { Object.assign(scd.deps, saved); }
}

// The module's own spawn, counted.
function countedSpawn() {
  const real = scd.deps.spawn;
  const calls = [];
  return { calls, spawn: (...args) => { calls.push(args); return real(...args); } };
}

function alive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function stillAlive(pids, ms = 3000) {
  const until = Date.now() + ms;
  while (pids.some(alive) && Date.now() < until) await delay(25);
  return pids.filter(alive);
}

describe('the read', { skip: REAL_SHELL_SKIP }, () => {
  const { readShellConfigDir } = scd;

  test('the read takes only CLAUDE_CONFIG_DIR, whatever else the profile sets or prints', async () => {
    const { claudeDir, elsewhere } = tempHome();
    const forged = '0123456789abcdef0123456789abcdef';
    const { shell } = fakeShell([
      'echo "Welcome back, example-user"',
      `export CLAUDE_CONFIG_DIR='${claudeDir}'`,
      'export ANTHROPIC_API_KEY=example-key-not-real',
      'export PATH="/example/bin:$PATH"',
      'export EXAMPLE_SETTING=on',
      `printf '<%s>"%s"</%s>\\n' ${forged} '${elsewhere}' ${forged}`,
      `printf '{"CLAUDE_CONFIG_DIR":"%s"}\\n' '${elsewhere}'`,
    ].join('\n'));
    const result = await withDeps({ shell: () => shell }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: true, value: claudeDir });
  });

  test('a profile with no CLAUDE_CONFIG_DIR completes with no value', async () => {
    const { shell } = fakeShell('echo "Welcome back"\n');
    const result = await withDeps({ shell: () => shell }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: true, value: null });
  });

  test('the shell is started as an interactive login shell in its own process group, with no input', async () => {
    const { shell, args } = fakeShell('');
    const counted = countedSpawn();
    await withDeps({ shell: () => shell, spawn: counted.spawn }, () => readShellConfigDir());
    assert.strictEqual(counted.calls.length, 1);
    const [file, argv, opts] = counted.calls[0];
    assert.strictEqual(file, shell);
    assert.deepStrictEqual(argv.slice(0, 3), ['-i', '-l', '-c']);
    assert.strictEqual(opts.detached, true);
    assert.strictEqual(opts.stdio[0], 'ignore');
    assert.deepStrictEqual(args().slice(0, 3), ['-i', '-l', '-c']);
  });

  test('the command runs the app binary as Node, the setting written into the command itself', async () => {
    const { shell, args } = fakeShell('unset ELECTRON_RUN_AS_NODE\n');
    await withDeps({ shell: () => shell }, () => readShellConfigDir());
    const command = args()[3];
    assert.ok(command.startsWith(`ELECTRON_RUN_AS_NODE=1 '${process.execPath}' -e '`), command);
  });

  test('a binary path with spaces and quotes is quoted for the shell', { skip: SYMLINK_SKIP }, async () => {
    const { claudeDir } = tempHome();
    const odd = path.join(makeTempDir('shell-config-bin-'), 'App Folder', "it's node");
    fs.mkdirSync(path.dirname(odd));
    fs.symlinkSync(process.execPath, odd);
    const { shell } = fakeShell(`export CLAUDE_CONFIG_DIR='${claudeDir}'\n`);
    const result = await withDeps({ shell: () => shell, execPath: () => odd }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: true, value: claudeDir });
  });

  test('each read makes its own markers', async () => {
    const one = fakeShell('');
    const two = fakeShell('');
    await withDeps({ shell: () => one.shell }, () => readShellConfigDir());
    await withDeps({ shell: () => two.shell }, () => readShellConfigDir());
    const [a, b] = [tokenOf(one.args()[3]), tokenOf(two.args()[3])];
    assert.match(a, /^[0-9a-f]{32}$/);
    assert.match(b, /^[0-9a-f]{32}$/);
    assert.notStrictEqual(a, b);
  });

  test("a block between an earlier read's markers is ignored", async () => {
    const { claudeDir } = tempHome();
    const first = fakeShell('');
    await withDeps({ shell: () => first.shell }, () => readShellConfigDir());
    const old = tokenOf(first.args()[3]);
    const { shell } = fakeShell(`printf '<%s>"%s"</%s>\\n' ${old} '${claudeDir}' ${old}\n`);
    const result = await withDeps({ shell: () => shell }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: true, value: null });
  });

  test('a hanging profile yields no value within the time limit, and its whole process group is killed', async () => {
    const { claudeDir } = tempHome();
    const dir = makeTempDir('shell-config-pids-');
    const pidFile = path.join(dir, 'pids');
    const { shell } = fakeShell([
      `export CLAUDE_CONFIG_DIR='${claudeDir}'`,
      `echo $$ >> '${pidFile}'`,
      'sleep 30 &',
      `echo $! >> '${pidFile}'`,
      'sleep 30 &',
      `echo $! >> '${pidFile}'`,
      'wait',
    ].join('\n'));
    // Long enough for a slow machine to start the shell and its two background
    // processes before the limit, so there is a group to kill.
    const limit = 1500;
    let pids = [];
    try {
      const started = Date.now();
      const result = await withDeps({ shell: () => shell, timeoutMs: limit }, () => readShellConfigDir());
      const took = Date.now() - started;
      assert.deepStrictEqual(result, { completed: false });
      assert.ok(took < limit + 2000, `carried on in ${took} ms`);
      pids = fs.readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
      assert.strictEqual(pids.length, 3, 'the shell and both of its background processes were recorded');
      assert.deepStrictEqual(await stillAlive(pids), [], 'no process is left behind');
    } finally {
      for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
    }
  });

  test('a profile that keeps asking for input yields no value within the time limit', async () => {
    const { claudeDir } = tempHome();
    const { shell } = fakeShell([
      `export CLAUDE_CONFIG_DIR='${claudeDir}'`,
      'while true; do printf "Password: "; read reply; sleep 0.05; done',
    ].join('\n'));
    const started = Date.now();
    const result = await withDeps({ shell: () => shell, timeoutMs: 300 }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: false });
    assert.ok(Date.now() - started < 300 + 2000);
  });

  test('a profile that asks once reads end of input and the read completes', async () => {
    const { claudeDir } = tempHome();
    const { shell } = fakeShell([
      'printf "Continue? "',
      'read reply',
      `export CLAUDE_CONFIG_DIR='${claudeDir}'`,
    ].join('\n'));
    const result = await withDeps({ shell: () => shell, timeoutMs: 3000 }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: true, value: claudeDir });
  });

  test('a profile that hands over to another program, as tmux or a nested shell does, yields no value', async () => {
    const { claudeDir } = tempHome();
    const { shell } = fakeShell(`export CLAUDE_CONFIG_DIR='${claudeDir}'\nexec /bin/sh -i\n`);
    const result = await withDeps({ shell: () => shell, timeoutMs: 3000 }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: false });
  });

  test('a shell that exits non-zero yields no value, even after printing a block', async () => {
    const { claudeDir } = tempHome();
    const { shell } = fakeShell(`export CLAUDE_CONFIG_DIR='${claudeDir}'\n`, { after: 'exit 3' });
    const result = await withDeps({ shell: () => shell }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: false });
  });

  test('a shell that is not there yields no value', async () => {
    const missing = path.join(makeTempDir('shell-config-shell-'), 'no-such-shell');
    const result = await withDeps({ shell: () => missing }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: false });
  });

  test('output past 1 MB stops the read and takes nothing', async () => {
    const { claudeDir } = tempHome();
    const { shell } = fakeShell(`yes | head -c 2097152\nexport CLAUDE_CONFIG_DIR='${claudeDir}'\n`);
    const started = Date.now();
    const result = await withDeps({ shell: () => shell, timeoutMs: 10000 }, () => readShellConfigDir());
    assert.deepStrictEqual(result, { completed: false });
    assert.ok(Date.now() - started < 5000, 'stopped by the size limit, not the time limit');
  });
});

describe('the read limits and the shell it runs', () => {
  test('the read is limited to five seconds and one megabyte', () => {
    assert.strictEqual(scd.deps.timeoutMs, 5000);
    assert.strictEqual(scd.OUTPUT_CAP_BYTES, 1024 * 1024);
  });

  test("the shell is SHELL, then the account's shell, then zsh", () => {
    const os = require('node:os');
    const savedShell = process.env.SHELL;
    const savedUserInfo = os.userInfo;
    try {
      process.env.SHELL = '/example/shell';
      assert.strictEqual(scd.deps.shell(), '/example/shell');
      delete process.env.SHELL;
      os.userInfo = () => ({ shell: '/example/account-shell' });
      assert.strictEqual(scd.deps.shell(), '/example/account-shell');
      os.userInfo = () => { throw new Error('no account entry'); };
      assert.strictEqual(scd.deps.shell(), '/bin/zsh');
    } finally {
      os.userInfo = savedUserInfo;
      if (savedShell === undefined) delete process.env.SHELL; else process.env.SHELL = savedShell;
    }
  });
});

// ── Once per launch: the marker and the retry ──

const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const MARKER = '.claude-config-dir-from-shell';
const PACKAGED_MAC = { isPackaged: true, platform: 'darwin' };

// A stand-in for the login shell, for the tests about when the read runs and
// what follows from it: answers at once, with no process behind it, and on
// every platform. Each behaviour gets the child and this read's token.
function standIn(behaviour) {
  const calls = [];
  const spawn = (file, args, opts) => {
    calls.push({ file, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    setImmediate(() => behaviour(child, tokenOf(args[3])));
    return child;
  };
  return { calls, spawn };
}
const prints = (value, { before = '' } = {}) => (child, token) => {
  child.stdout.once('end', () => child.emit('close', 0, null));
  child.stdout.end(`${before}\n<${token}>${JSON.stringify(value)}</${token}>\n`);
};
const hangs = () => {};

// One launch: a controller over a temporary home and app-data folder, with the
// stand-in shell, a short time limit and the log kept.
function launch({ shell = prints(null), env = {}, marker = false, home, appData, ...where } = {}) {
  const h = home || tempHome();
  const dataDir = appData || makeTempDir('shell-config-data-');
  if (marker) fs.writeFileSync(path.join(dataDir, MARKER), typeof marker === 'string' ? marker : new Date().toISOString());
  const fake = standIn(shell);
  const logged = [];
  scd.deps.spawn = fake.spawn;
  scd.deps.home = () => h.home;
  scd.deps.timeoutMs = 50;
  scd.deps.log = (line) => logged.push(line);
  const controller = scd.createShellConfigDir({ ...PACKAGED_MAC, ...where, env, appData: dataDir });
  return {
    controller, env, logged, ...h, appData: dataDir,
    reads: () => fake.calls.length,
    marker: () => fs.existsSync(path.join(dataDir, MARKER)),
    markerText: () => fs.readFileSync(path.join(dataDir, MARKER), 'utf8'),
  };
}

// Answers in turn, the last one repeated, counting how often it was asked.
function answers(...list) {
  const run = () => { run.count += 1; return list[Math.min(run.count, list.length) - 1]; };
  run.count = 0;
  return run;
}
const SIGNED_OUT = { connected: false, known: true };
const CONNECTED = { connected: true, known: true };
const UNKNOWN = { connected: false, known: false };

describe('once per launch', () => {
  const saved = { ...scd.deps };
  afterEach(() => { Object.assign(scd.deps, saved); });

  describe('the shell is never run while sign-in works', () => {
    test('a launch check that passes never runs the shell', async () => {
      const l = launch();
      assert.strictEqual(await l.controller.checkAuthenticated(() => true), true);
      assert.strictEqual(l.reads(), 0);
    });

    test('a launch with setup verified and no marker never runs the shell', async () => {
      const l = launch();
      assert.strictEqual(await l.controller.atLaunch(), false);
      assert.strictEqual(l.reads(), 0);
    });

    test('a wizard check that passes never runs the shell', async () => {
      const l = launch();
      for (let i = 0; i < 3; i++) assert.strictEqual(await l.controller.checkAuthenticated(() => true), true);
      assert.strictEqual(l.reads(), 0);
    });

    test('a connection check that answers connected never runs the shell', async () => {
      const l = launch();
      assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(CONNECTED)), CONNECTED);
      assert.strictEqual(l.reads(), 0);
    });

    test('a connection check that cannot tell never runs the shell', async () => {
      const l = launch();
      assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(UNKNOWN)), UNKNOWN);
      assert.strictEqual(l.reads(), 0);
    });
  });

  describe('the first failed check reads, once', () => {
    test('a failed launch check runs the shell once, and later failures and wizard polls never again', async () => {
      const l = launch();
      for (let i = 0; i < 5; i++) assert.strictEqual(await l.controller.checkAuthenticated(() => false), false);
      assert.strictEqual(l.reads(), 1);
    });

    test('a failed connection check runs the shell once, and later failures never again', async () => {
      const l = launch();
      for (let i = 0; i < 3; i++) assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(SIGNED_OUT)), SIGNED_OUT);
      assert.strictEqual(l.reads(), 1);
    });

    test('a failed check after a launch with the marker does not read again', async () => {
      const l = launch({ marker: true });
      await l.controller.atLaunch();
      await l.controller.checkAuthenticated(() => false);
      assert.strictEqual(l.reads(), 1);
    });

    test('a failed sign-in check followed by a failed connection check reads only once', async () => {
      const l = launch();
      await l.controller.checkAuthenticated(() => false);
      await l.controller.checkConnection(() => Promise.resolve(SIGNED_OUT));
      assert.strictEqual(l.reads(), 1);
    });
  });

  describe('the retry', () => {
    test('when a value is taken the failed sign-in check runs once more, and its answer is returned', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.claudeDir), home: h });
      const run = answers(false, true);
      assert.strictEqual(await l.controller.checkAuthenticated(run), true);
      assert.strictEqual(run.count, 2);
      assert.strictEqual(l.env.CLAUDE_CONFIG_DIR, h.claudeDir);
    });

    test('when a value is taken the failed connection check runs once more, and its answer is returned', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.claudeDir), home: h });
      const run = answers(SIGNED_OUT, CONNECTED);
      assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(run())), CONNECTED);
      assert.strictEqual(run.count, 2);
    });

    test('when nothing is taken the failed answer is returned as it was, and the check is not run again', async () => {
      const l = launch();
      const run = answers(SIGNED_OUT);
      assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(run())), SIGNED_OUT);
      assert.strictEqual(run.count, 1);
    });

    test('a value already in the environment is kept, and the shell is not run', async () => {
      const h = tempHome();
      const env = { CLAUDE_CONFIG_DIR: h.elsewhere };
      const l = launch({ shell: prints(h.claudeDir), home: h, env });
      const run = answers(false, true);
      assert.strictEqual(await l.controller.checkAuthenticated(run), false);
      assert.strictEqual(env.CLAUDE_CONFIG_DIR, h.elsewhere);
      assert.strictEqual(run.count, 1);
      assert.strictEqual(l.reads(), 0);
    });

    test('a value the gate drops changes nothing and leaves no marker', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.elsewhere), home: h });
      const run = answers(false, true);
      assert.strictEqual(await l.controller.checkAuthenticated(run), false);
      assert.deepStrictEqual(l.env, {});
      assert.strictEqual(run.count, 1);
      assert.strictEqual(l.marker(), false);
    });
  });

  describe('the marker', () => {
    test('a taken value followed by a passing check leaves the marker, holding only a timestamp', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.claudeDir), home: h });
      await l.controller.checkAuthenticated(answers(false, true));
      assert.strictEqual(l.marker(), true);
      assert.ok(!Number.isNaN(Date.parse(l.markerText())), l.markerText());
      assert.ok(!l.markerText().includes(h.claudeDir));
    });

    test('a taken value whose retry still fails leaves no marker until a later check passes', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.claudeDir), home: h });
      await l.controller.checkAuthenticated(answers(false, false));
      assert.strictEqual(l.marker(), false);
      await l.controller.checkAuthenticated(() => true);
      assert.strictEqual(l.marker(), true);
      assert.strictEqual(l.reads(), 1);
    });

    test('a launch with the marker reads before any check, and takes the value', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.claudeDir), home: h, marker: true });
      assert.strictEqual(await l.controller.atLaunch(), true);
      assert.strictEqual(l.reads(), 1);
      assert.strictEqual(l.env.CLAUDE_CONFIG_DIR, h.claudeDir);
      assert.strictEqual(l.marker(), true);
    });

    test('a completed read that takes nothing removes the marker', async () => {
      const l = launch({ shell: prints(null), marker: true });
      assert.strictEqual(await l.controller.atLaunch(), false);
      assert.strictEqual(l.marker(), false);
    });

    test('a completed read with a value the gate drops removes the marker', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(h.elsewhere), home: h, marker: true });
      await l.controller.atLaunch();
      assert.strictEqual(l.marker(), false);
      assert.deepStrictEqual(l.env, {});
    });

    test('a read that runs out of time keeps the marker', async () => {
      const l = launch({ shell: hangs, marker: true });
      assert.strictEqual(await l.controller.atLaunch(), false);
      assert.strictEqual(l.marker(), true);
    });

    test('a failed read after a failed check neither writes nor removes the marker', async () => {
      const l = launch({ shell: hangs });
      await l.controller.checkAuthenticated(() => false);
      assert.strictEqual(l.marker(), false);
    });

    test('a hand-written marker only brings the read forward: what it holds is never used', async () => {
      const h = tempHome();
      const l = launch({ shell: prints(null), home: h, marker: h.claudeDir });
      assert.strictEqual(await l.controller.atLaunch(), false);
      assert.deepStrictEqual(l.env, {});
      assert.strictEqual(l.marker(), false);
    });
  });

  describe('where it never runs, with a marker or without', () => {
    const cases = [
      ['a dev run', { isPackaged: false }],
      ['Linux', { platform: 'linux' }],
      ['Windows', { platform: 'win32' }],
      ['a smoke test', { env: { RUNDOCK_SMOKE_TEST: '1' } }],
    ];
    for (const [name, where] of cases) {
      test(`${name} never runs the shell, with a marker or without`, async () => {
        for (const marker of [true, false]) {
          const h = tempHome();
          const l = launch({ shell: prints(h.claudeDir), home: h, marker, ...where });
          assert.strictEqual(await l.controller.atLaunch(), false);
          assert.strictEqual(await l.controller.checkAuthenticated(() => false), false);
          assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(SIGNED_OUT)), SIGNED_OUT);
          assert.strictEqual(l.reads(), 0, `marker: ${marker}`);
          assert.strictEqual(l.marker(), marker, 'the marker is left as it was');
        }
      });
    }
  });

  describe('in sequence', () => {
    test('with no variable in the profile: one read, nothing taken, no marker, and the wizard answers as before', async () => {
      const l = launch({ shell: prints(null) });
      assert.strictEqual(await l.controller.checkAuthenticated(() => false), false);
      for (let i = 0; i < 3; i++) assert.strictEqual(await l.controller.checkAuthenticated(() => false), false);
      assert.strictEqual(l.reads(), 1);
      assert.deepStrictEqual(l.env, {});
      assert.strictEqual(l.marker(), false);
      assert.strictEqual(await l.controller.checkAuthenticated(() => true), true);
      assert.strictEqual(l.marker(), false, 'a pass with nothing taken leaves no marker');
    });

    test('a marker launch that finds nothing starts without the variable and removes the marker, and the next launch does not run the shell', async () => {
      const h = tempHome();
      const first = launch({ shell: prints(null), home: h, marker: true });
      assert.strictEqual(await first.controller.atLaunch(), false);
      assert.deepStrictEqual(first.env, {});
      assert.strictEqual(first.marker(), false);
      const next = launch({ shell: prints(h.claudeDir), home: h, appData: first.appData });
      assert.strictEqual(await next.controller.atLaunch(), false);
      assert.strictEqual(next.reads(), 0);
    });

    test('a read that runs out of time is not repeated that launch, and the next launch reads at its first failed check', async () => {
      const h = tempHome();
      const first = launch({ shell: hangs, home: h });
      await first.controller.checkAuthenticated(() => false);
      await first.controller.checkAuthenticated(() => false);
      assert.strictEqual(first.reads(), 1);
      assert.strictEqual(first.marker(), false);
      const next = launch({ shell: prints(h.claudeDir), home: h, appData: first.appData });
      assert.strictEqual(await next.controller.atLaunch(), false, 'no marker, so nothing at launch');
      assert.strictEqual(next.reads(), 0);
      assert.strictEqual(await next.controller.checkAuthenticated(answers(false, true)), true);
      assert.strictEqual(next.reads(), 1);
    });

    test('with the marker, a read that runs out of time keeps it, and the next launch reads at launch', async () => {
      const h = tempHome();
      const first = launch({ shell: hangs, home: h, marker: true });
      assert.strictEqual(await first.controller.atLaunch(), false);
      await first.controller.checkAuthenticated(() => false);
      assert.strictEqual(first.reads(), 1);
      assert.strictEqual(first.marker(), true);
      const next = launch({ shell: prints(h.claudeDir), home: h, appData: first.appData });
      assert.strictEqual(await next.controller.atLaunch(), true);
      assert.strictEqual(next.env.CLAUDE_CONFIG_DIR, h.claudeDir);
    });

    test('after the wizard passes with the value, the next launch starts with it and runs no failing check', async () => {
      const h = tempHome();
      const first = launch({ shell: prints(h.claudeDir), home: h });
      assert.strictEqual(await first.controller.checkAuthenticated(answers(false, true)), true);
      assert.strictEqual(first.env.CLAUDE_CONFIG_DIR, h.claudeDir);
      assert.strictEqual(first.marker(), true);
      const next = launch({ shell: prints(h.claudeDir), home: h, appData: first.appData });
      assert.strictEqual(await next.controller.atLaunch(), true);
      assert.strictEqual(next.env.CLAUDE_CONFIG_DIR, h.claudeDir);
      assert.strictEqual(next.reads(), 1);
    });

    test('a reader that throws takes nothing, leaves the marker as it was, and launch and the check carry on', async () => {
      for (const marker of [true, false]) {
        const l = launch({ marker });
        scd.deps.spawn = () => { throw new Error('spawn failed'); };
        assert.strictEqual(await l.controller.atLaunch(), false);
        assert.strictEqual(await l.controller.checkAuthenticated(() => false), false);
        assert.deepStrictEqual(await l.controller.checkConnection(() => Promise.resolve(SIGNED_OUT)), SIGNED_OUT);
        assert.deepStrictEqual(l.env, {});
        assert.strictEqual(l.marker(), marker, `marker: ${marker}`);
      }
    });
  });

  describe('what it logs', () => {
    test('the log says the read ran and whether a value was taken, never the value or what the profile printed', async () => {
      const h = tempHome();
      const banner = 'Welcome back, example-user';
      const took = launch({ shell: prints(h.claudeDir, { before: banner }), home: h });
      await took.controller.checkAuthenticated(answers(false, true));
      const none = launch({ shell: prints(null, { before: banner }), home: h });
      await none.controller.checkAuthenticated(() => false);
      const slow = launch({ shell: hangs, home: h });
      await slow.controller.checkAuthenticated(() => false);
      const lines = [...took.logged, ...none.logged, ...slow.logged];
      assert.strictEqual(took.logged.length, 1);
      assert.strictEqual(none.logged.length, 1);
      assert.strictEqual(slow.logged.length, 1);
      assert.match(took.logged[0], /a value was taken/);
      assert.match(none.logged[0], /nothing was taken/);
      assert.match(slow.logged[0], /did not finish/);
      for (const line of lines) {
        assert.ok(!line.includes(h.home), line);
        assert.ok(!line.includes('example-user'), line);
      }
    });

    test('a launch that never runs the shell logs nothing', async () => {
      const l = launch();
      await l.controller.atLaunch();
      await l.controller.checkAuthenticated(() => true);
      assert.deepStrictEqual(l.logged, []);
    });
  });
});

describe('only CLAUDE_CONFIG_DIR crosses into the app', { skip: REAL_SHELL_SKIP }, () => {
  const saved = { ...scd.deps };
  afterEach(() => { Object.assign(scd.deps, saved); });

  test('a profile that sets other variables and prints a forged block changes only CLAUDE_CONFIG_DIR', async () => {
    const h = tempHome();
    const forged = 'fedcba9876543210fedcba9876543210';
    const { shell } = fakeShell([
      'echo "Welcome back, example-user"',
      `export CLAUDE_CONFIG_DIR='${h.claudeDir}'`,
      'export ANTHROPIC_API_KEY=example-key-not-real',
      'export PATH="/example/bin:$PATH"',
      'export EXAMPLE_SETTING=on',
      `printf '<%s>{"CLAUDE_CONFIG_DIR":"%s","EXAMPLE_SETTING":"forged"}</%s>\\n' ${forged} '${h.elsewhere}' ${forged}`,
    ].join('\n'));
    scd.deps.shell = () => shell;
    scd.deps.home = () => h.home;
    scd.deps.log = () => {};
    const env = { PATH: '/usr/bin:/bin', HOME: h.home, EXAMPLE_SETTING: 'off' };
    const before = { ...env };
    const controller = scd.createShellConfigDir({ ...PACKAGED_MAC, env, appData: makeTempDir('shell-config-data-') });
    assert.strictEqual(await controller.checkAuthenticated(answers(false, true)), true);
    assert.deepStrictEqual(env, { ...before, CLAUDE_CONFIG_DIR: h.claudeDir });
  });
});
