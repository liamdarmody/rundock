'use strict';
// The desktop's sign-in check and the wizard's runtime answer, as
// electron/main.js makes them, run against the stub claude.
//
// When the check fails, the answer to the wizard carries one cleaned line of
// what Claude Code said, or a fixed kind, and nothing else crosses: no
// credential, no raw output, nothing echoed to the app's own stderr, none of
// it logged or written. The check itself still answers only true or false, with
// the same command and time limit, so the routing that reads the login shell
// after a failure decides exactly as before.
//
// main.js cannot be loaded outside Electron, so the lines that make its setup
// check (electron/setup-check.js) and answer the wizard are taken from its
// source and run with the real modules. Its PATH extender is a stand-in that
// adds nothing, and the stub claude is first on PATH for every test, so no
// test runs the person's real Claude Code. Fake keys are built at run time.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const { makeTempDir } = require('../helpers/workspace.js');
const { fakeShell } = require('../helpers/fake-login-shell.js');
const scd = require('../../electron/shell-config-dir.js');
const sr = require('../../electron/sign-in-reason.js');
const sm = require('../../electron/setup-check.js');

const SKIP = process.platform === 'win32'
  ? 'the check is started through /bin/sh here, and the stub claude is a POSIX script'
  : false;

const MAIN_PATH = path.join(__dirname, '../../electron/main.js');
const MODULE_PATH = path.join(__dirname, '../../electron/sign-in-reason.js');
const SETUP_PATH = path.join(__dirname, '../../electron/setup-check.js');
const STUB_DIR = path.join(__dirname, '../helpers/stub-claude');
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const SETUP_REQUIRE = /^const \{ createSetupCheck \} = require\('\.\/setup-check\.js'\);\n/m;
const MAKES_THE_CHECK = /^const setupCheck = createSetupCheck\(\{\n[\s\S]*?\n\}\);\n/m;
const HANDLER = /^ *ipcMain\.handle\('wizard-check-runtimes', ([^\n]*)\);\n/m;

const fakeKey = (...parts) => ['sk', ...parts].join('-');
const ANT_KEY = fakeKey('ant', 'api03', 'EXAMPLE1234');
const OTHER_KEY = fakeKey('proj', 'EXAMPLE1234');
const SHORT_TOKEN = ['example', 'TOKEN', '1234'].join('');
const LONG_RUN = 'EXAMPLE_token-'.repeat(3);

function piece(pattern, what) {
  const found = pattern.exec(fs.readFileSync(MAIN_PATH, 'utf8'));
  assert.ok(found, what);
  return found;
}

// A dev run's routing: the check runs once and its answer stands.
const devRun = () => scd.createShellConfigDir({ isPackaged: false, platform: process.platform, env: process.env, appData: makeTempDir('sign-in-reason-data-') });

// The setup check and the wizard's answer, made by main.js's own lines with
// one reason holder, as main.js makes them. `check()` runs the wizard's
// answer once and gives what its one sign-in run answered the routing.
function desktop({ shellConfigDir = devRun() } = {}) {
  const signInReason = sr.createSignInReason();
  const decided = [];
  const routing = {
    checkAuthenticated: (run) => shellConfigDir.checkAuthenticated(async () => {
      const ok = await run();
      decided.push(ok);
      return ok;
    }),
  };
  const body = [
    piece(SETUP_REQUIRE, 'electron/main.js loads its setup check')[0],
    piece(MAKES_THE_CHECK, 'electron/main.js makes its setup check')[0],
    `return ${piece(HANDLER, "electron/main.js answers the wizard's runtime check")[1]};`,
  ].join('\n');
  const answer = new Function('require', 'process', 'app', 'shellConfigDir', 'signInReason', 'ensurePath', 'detectCodexForWizard', body)(
    createRequire(MAIN_PATH), { platform: process.platform, env: process.env }, { getPath: () => makeTempDir('sign-in-reason-log-') },
    routing, signInReason, () => {}, () => ({ status: 'not-installed' }));
  const check = async () => {
    const before = decided.length;
    await answer();
    assert.strictEqual(decided.length, before + 1, 'one sign-in run');
    return decided[before];
  };
  return { answer, check, signInReason };
}

const KEYS = ['PATH', 'CLAUDE_CONFIG_DIR', 'STUB_CLAUDE_SIGNED_OUT', 'STUB_CLAUDE_SIGNED_IN_WITH', 'STUB_CLAUDE_CHECK_FAILS',
  'STUB_CLAUDE_CHECK_HANGS', 'STUB_CLAUDE_CHECK_STDERR', 'STUB_CLAUDE_CHECK_STDOUT', 'STUB_CLAUDE_CHECK_EXIT',
  'STUB_CLAUDE_CHECK_STDERR_TIMES'];

// The stub answers its check with this output and exit code (a failure unless
// told otherwise), writing the stderr `times` times in a row.
function says(stderr, { stdout = '', exit = 1, times = 1 } = {}) {
  process.env.STUB_CLAUDE_CHECK_STDERR = Buffer.from(stderr).toString('base64');
  process.env.STUB_CLAUDE_CHECK_STDOUT = Buffer.from(stdout).toString('base64');
  process.env.STUB_CLAUDE_CHECK_EXIT = String(exit);
  process.env.STUB_CLAUDE_CHECK_STDERR_TIMES = String(times);
}

// The check as it stood before the reason was kept, word for word. With no
// stdio option execSync still pipes every stream and holds stderr under the
// same maxBuffer, then writes it to this process's stderr, which is silenced
// here for the call and handed back.
function checkBeforeTheReason() {
  const write = process.stderr.write;
  let echoed = '';
  process.stderr.write = (chunk) => { echoed += String(chunk); return true; };
  try {
    childProcess.execSync('claude --print "test" --output-format text', { timeout: 15000 });
    return { passed: true, echoed };
  } catch {
    return { passed: false, echoed };
  } finally {
    process.stderr.write = write;
  }
}

// execSync's default maxBuffer, the same in both forms of the check, and a
// stderr half as large again: one long line, written over and over.
const MAX_BUFFER = 1024 * 1024;
const LONG_LINE = 'Request failed, retrying the session. '.repeat(10).trim();
const LARGE_TIMES = Math.ceil((1.5 * MAX_BUFFER) / (LONG_LINE.length + 1));
const WARNING = 'Warning: a status line command named in the settings was not found, so none is shown';
function passes() {
  for (const key of KEYS.slice(2)) delete process.env[key];
}
const reasonFor = async (answer) => (await answer()).claude;

describe("the wizard's answer when the sign-in check fails", { skip: SKIP }, () => {
  let saved;
  const savedDeps = { ...sr.deps };
  const savedScd = { ...scd.deps };
  const savedSm = { ...sm.deps };
  beforeEach(() => {
    saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));
    passes();
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.PATH = `${STUB_DIR}${path.delimiter}${saved.PATH}`;
  });
  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    Object.assign(sr.deps, savedDeps);
    Object.assign(scd.deps, savedScd);
    Object.assign(sm.deps, savedSm);
  });

  test("a failed check's own words reach the wizard's answer", async () => {
    says(`${OAUTH}\n    at refresh (auth.js:10)\n`);
    const { answer } = desktop();
    assert.deepStrictEqual(await reasonFor(answer),
      { status: 'not-authenticated', reason: { kind: 'said', text: OAUTH, signIn: true } });
  });

  describe('no credential crosses, one shape each', () => {
    const cases = [
      ['an sk-ant- key', `Invalid key ${ANT_KEY} given`, 'Invalid key [hidden] given'],
      ['any other sk- key', `Invalid key ${OTHER_KEY}.`, 'Invalid key [hidden].'],
      ['a Bearer token', `Authorization: Bearer ${SHORT_TOKEN} refused`, 'Authorization: Bearer [hidden] refused'],
      ['an x-api-key value', `x-api-key: ${SHORT_TOKEN} refused`, 'x-api-key: [hidden] refused'],
      ['an ANTHROPIC_API_KEY value', `ANTHROPIC_API_KEY=${SHORT_TOKEN} is invalid`, 'ANTHROPIC_API_KEY=[hidden] is invalid'],
      ['a CLAUDE_CODE_OAUTH_TOKEN value', `CLAUDE_CODE_OAUTH_TOKEN=${SHORT_TOKEN} expired`, 'CLAUDE_CODE_OAUTH_TOKEN=[hidden] expired'],
      ['a run of 32 or more key characters', `session ${LONG_RUN} refused`, 'session [hidden] refused'],
    ];
    for (const [shape, said, shown] of cases) {
      test(`${shape} is replaced before the answer leaves the main process`, async () => {
        says(`${said}\n`);
        const { answer } = desktop();
        assert.strictEqual((await reasonFor(answer)).reason.text, shown);
      });
    }

    test('a token straddling the 300th character leaves no part of itself in the answer', async () => {
      says(`${'a '.repeat(145)}${'EXAMPLEtoken'.repeat(3)} end\n`);
      const { answer } = desktop();
      const { text } = (await reasonFor(answer)).reason;
      assert.strictEqual([...text].length, 300);
      assert.ok(!text.includes('EXAMPLE') && !text.includes('token'), JSON.stringify(text.slice(-20)));
    });
  });

  describe('the fixed answers, which quote nothing', () => {
    test('a check that runs past its time limit answers that Claude Code did not answer in time', async () => {
      process.env.STUB_CLAUDE_CHECK_HANGS = '1';
      // The limit itself is pinned below; this run is cut short so the test
      // does not wait the full 15 seconds. The setup check's own timer ends it.
      sm.deps.timeouts = { ...savedSm.timeouts, signIn: 1000 };
      const { answer } = desktop();
      assert.deepStrictEqual(await reasonFor(answer), { status: 'not-authenticated', reason: { kind: 'timeout' } });
    });

    test('a check whose claude cannot be started answers that it could not be started', async () => {
      // Found and started for its version, then gone before the sign-in run.
      const dir = makeTempDir('sign-in-reason-gone-');
      fs.symlinkSync(path.join(STUB_DIR, 'claude'), path.join(dir, 'claude'));
      process.env.PATH = `${dir}${path.delimiter}${process.env.PATH}`;
      const dev = devRun();
      const gone = { checkAuthenticated: (run) => { fs.rmSync(path.join(dir, 'claude')); return dev.checkAuthenticated(run); } };
      const { answer } = desktop({ shellConfigDir: gone });
      assert.deepStrictEqual(await reasonFor(answer), { status: 'not-authenticated', reason: { kind: 'not-started' } });
    });

    test('a failed check with no output answers that Claude Code gave no reason', async () => {
      says('');
      const { answer } = desktop();
      assert.deepStrictEqual(await reasonFor(answer), { status: 'not-authenticated', reason: { kind: 'no-reason' } });
    });
  });

  test('a check that says its reason only on stdout gives that line', async () => {
    says('', { stdout: '\nFailed to authenticate\n' });
    const { answer } = desktop();
    assert.strictEqual((await reasonFor(answer)).reason.text, 'Failed to authenticate');
  });

  test('a passing check answers ready with no reason', async () => {
    const { answer, signInReason } = desktop();
    assert.deepStrictEqual(await reasonFor(answer), { status: 'ready' });
    assert.strictEqual(signInReason.last(), null);
  });

  test("a check that fails and then passes leaves no earlier check's reason", async () => {
    const { answer, signInReason } = desktop();
    says(`${OAUTH}\n`);
    assert.strictEqual((await reasonFor(answer)).reason.text, OAUTH);
    passes();
    assert.deepStrictEqual(await reasonFor(answer), { status: 'ready' });
    assert.strictEqual(signInReason.last(), null);
  });

  test('the first failure reads the login shell once, the value is taken, and the second run passes with no reason', async () => {
    const home = makeTempDir('sign-in-reason-home-');
    const claudeDir = path.join(home, '.claude');
    fs.mkdirSync(claudeDir);
    const { shell } = fakeShell(`export CLAUDE_CONFIG_DIR='${claudeDir}'\n`);
    let reads = 0;
    const spawn = scd.deps.spawn;
    Object.assign(scd.deps, { shell: () => shell, home: () => home, log: () => {}, spawn: (...args) => { reads++; return spawn(...args); } });
    process.env.STUB_CLAUDE_SIGNED_IN_WITH = claudeDir;
    const shellConfigDir = scd.createShellConfigDir({ isPackaged: true, platform: 'darwin', env: process.env, appData: makeTempDir('sign-in-reason-data-') });
    const { answer, signInReason } = desktop({ shellConfigDir });
    assert.deepStrictEqual(await reasonFor(answer), { status: 'ready' });
    assert.strictEqual(reads, 1);
    assert.strictEqual(process.env.CLAUDE_CONFIG_DIR, claudeDir);
    assert.strictEqual(signInReason.last(), null);
  });

  test('when the cleaner throws, the answer is the fixed no-reason one and pass or fail is unchanged', async () => {
    sr.deps.clean = () => { throw new Error('cleaner broke'); };
    says(`Failed to authenticate ${OTHER_KEY}\n`, { stdout: 'raw stdout\n' });
    const { answer, check } = desktop();
    assert.deepStrictEqual(await reasonFor(answer), { status: 'not-authenticated', reason: { kind: 'no-reason' } });
    assert.strictEqual(await check(), false);
    passes();
    assert.strictEqual(await check(), true);
    assert.deepStrictEqual(await reasonFor(answer), { status: 'ready' });
  });

  test('the check still answers only true or false, which the routing reads as before', async () => {
    const { check } = desktop();
    assert.strictEqual(await check(), true);
    says(`${OAUTH}\n`);
    assert.strictEqual(await check(), false);
  });

  test('the check runs the same command on the copy found, in a copy of this environment, with the same 15-second limit and its output piped', async () => {
    const started = [];
    const timers = [];
    sm.deps.spawn = (program, args, options) => { started.push({ program, args, options }); return savedSm.spawn(program, args, options); };
    sm.deps.setTimeout = (fn, ms) => { timers.push(ms); return savedSm.setTimeout(fn, ms); };
    await desktop().answer();
    const stub = path.join(STUB_DIR, 'claude');
    assert.deepStrictEqual(started.map((s) => [s.program, ...s.args].join(' ')),
      ['which claude', `${stub} --version`, `${stub} --print test --output-format text`]);
    assert.deepStrictEqual(started[2].options.env, { ...process.env });
    assert.deepStrictEqual(started[2].options.stdio, ['ignore', 'pipe', 'pipe']);
    assert.strictEqual(timers[2], 15000);
  });

  describe('pass and fail are decided as before, through the real execSync', () => {
    test("a passing check's large stderr is decided as before", async () => {
      says(`${LONG_LINE}\n`, { stdout: 'ok\n', exit: 0, times: LARGE_TIMES });
      const { check, signInReason } = desktop();
      const before = checkBeforeTheReason();
      assert.ok(before.echoed.length >= MAX_BUFFER, `sanity: the stub wrote more than maxBuffer, ${before.echoed.length} bytes came back`);
      assert.strictEqual(await check(), before.passed);
      // Failed in both: stderr is held under execSync's maxBuffer, and the
      // setup check holds each stream under the same cap, so a check that
      // writes more than that is ended and fails, however it would have exited.
      assert.strictEqual(before.passed, false);
      assert.deepStrictEqual(signInReason.last(), { kind: 'said', text: `${LONG_LINE.slice(0, sr.MAX_CHARS - 1)}\u2026`, signIn: false });
    });

    test("a failing check's large stderr is decided as before, and its reason is one bounded line", async () => {
      says(`${LONG_LINE}\n`, { exit: 1, times: LARGE_TIMES });
      const { answer, check } = desktop();
      const before = checkBeforeTheReason();
      assert.strictEqual(await check(), before.passed);
      assert.strictEqual(before.passed, false);
      const res = await reasonFor(answer);
      assert.deepStrictEqual(res,
        { status: 'not-authenticated', reason: { kind: 'said', text: `${LONG_LINE.slice(0, sr.MAX_CHARS - 1)}\u2026`, signIn: false } });
      assert.ok(JSON.stringify(res).length < 2 * sr.MAX_CHARS, 'nothing more of the output crosses');
    });

    test("a passing check's little stderr is decided as before, with no reason", async () => {
      says(`${WARNING}\n`, { stdout: 'ok\n', exit: 0 });
      const { answer, check, signInReason } = desktop();
      const before = checkBeforeTheReason();
      assert.ok(before.echoed.includes(WARNING), 'sanity: the check before the reason ran against the stub and echoed its stderr');
      assert.strictEqual(await check(), before.passed);
      assert.strictEqual(before.passed, true);
      assert.strictEqual(signInReason.last(), null);
      assert.deepStrictEqual(await reasonFor(answer), { status: 'ready' });
    });
  });

  test("the check's output never reaches the app's own stderr", () => {
    says(`${OAUTH}\n`, { stdout: 'stdout words\n' });
    const script = [
      `const { createSetupCheck } = require(${JSON.stringify(SETUP_PATH)});`,
      "createSetupCheck({ platform: process.platform, env: process.env, extendPath: () => {} }).check().then((r) => process.stdout.write(r.status));",
    ].join('\n');
    const run = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: '' } });
    assert.strictEqual(run.stdout, 'not-authenticated', run.stderr);
    assert.ok(!run.stderr.includes('authenticate') && !run.stderr.includes('stdout words'), `nothing echoed: ${JSON.stringify(run.stderr)}`);
  });

  test('neither the output nor the line is logged, written or kept', async () => {
    const mark = 'zebralantern';
    says(`Failed to authenticate ${mark}\n`, { stdout: `${mark} on stdout\n` });
    const seen = [];
    const watch = (owner, name) => {
      const original = owner[name];
      owner[name] = function watched(...args) {
        if (args.some((arg) => String(arg).includes(mark))) seen.push(name);
        return original.apply(this, args);
      };
      return () => { owner[name] = original; };
    };
    const undo = [
      ...['log', 'info', 'warn', 'error', 'debug'].map((name) => watch(console, name)),
      watch(process.stdout, 'write'), watch(process.stderr, 'write'),
      ...['writeFileSync', 'appendFileSync', 'writeSync', 'writeFile', 'appendFile', 'createWriteStream'].map((name) => watch(fs, name)),
      watch(fs.promises, 'writeFile'), watch(fs.promises, 'appendFile'),
    ];
    let res;
    try {
      res = await reasonFor(desktop().answer);
    } finally {
      undo.forEach((restore) => restore());
    }
    assert.deepStrictEqual(seen, []);
    assert.strictEqual(res.reason.text, `Failed to authenticate ${mark}`, 'the line did reach the answer');
    const moduleSource = fs.readFileSync(MODULE_PATH, 'utf8');
    assert.ok(!/\brequire\(|\bconsole\.\w|\bprocess\.\w/.test(moduleSource), 'the reason module loads, logs and reaches nothing');
  });
});
