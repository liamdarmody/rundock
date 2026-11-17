'use strict';
// The desktop's sign-in check and the wizard's runtime answer, as
// electron/main.js has them, run against the stub claude.
//
// When the check fails, the answer to the wizard carries one cleaned line of
// what Claude Code said, or a fixed kind, and nothing else crosses: no
// credential, no raw output, nothing echoed to the app's own stderr, nothing
// logged or written. The check itself still answers only true or false, with
// the same command, environment and time limit, so the routing that reads the
// login shell after a failure decides exactly as before.
//
// main.js cannot be loaded outside Electron, so the check and the handler are
// taken from its source. The stub claude is first on PATH for every test, so
// no test runs the person's real Claude Code. Fake keys are built at run time.
const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { makeTempDir } = require('../helpers/workspace.js');
const { fakeShell } = require('../helpers/fake-login-shell.js');
const scd = require('../../electron/shell-config-dir.js');
const sr = require('../../electron/sign-in-reason.js');

const SKIP = process.platform === 'win32'
  ? 'the check is started through /bin/sh here, and the stub claude is a POSIX script'
  : false;

const MAIN_PATH = path.join(__dirname, '../../electron/main.js');
const MODULE_PATH = path.join(__dirname, '../../electron/sign-in-reason.js');
const STUB_DIR = path.join(__dirname, '../helpers/stub-claude');
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';
const CHECK = /^function isClaudeAuthenticated\(\) \{\n[\s\S]*?\n\}\n/m;
const HANDLER = /ipcMain\.handle\('wizard-check-runtimes', (async \(\) => \{\n[\s\S]*?\n {4}\})\);\n/;

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

// The check and the wizard's answer, sharing one reason holder as main.js does.
function desktop({ execSync = childProcess.execSync, shellConfigDir = devRun() } = {}) {
  const signInReason = sr.createSignInReason();
  const check = piece(CHECK, 'electron/main.js has its sign-in check');
  const isClaudeAuthenticated = new Function('execSync', 'signInReason', `${check[0]}\nreturn isClaudeAuthenticated;`)(execSync, signInReason);
  const handler = piece(HANDLER, "electron/main.js answers the wizard's runtime check");
  const answer = new Function('findClaude', 'ensureClaudeOnUserPath', 'path', 'shellConfigDir', 'isClaudeAuthenticated',
    'signInReason', 'detectCodexForWizard', `return ${handler[1]};`)(
    () => path.join(STUB_DIR, 'claude'), () => {}, path, shellConfigDir, isClaudeAuthenticated,
    signInReason, () => ({ status: 'not-installed' }));
  return { answer, isClaudeAuthenticated, signInReason };
}

const KEYS = ['PATH', 'CLAUDE_CONFIG_DIR', 'STUB_CLAUDE_SIGNED_OUT', 'STUB_CLAUDE_SIGNED_IN_WITH', 'STUB_CLAUDE_CHECK_FAILS',
  'STUB_CLAUDE_CHECK_HANGS', 'STUB_CLAUDE_CHECK_STDERR', 'STUB_CLAUDE_CHECK_STDOUT', 'STUB_CLAUDE_CHECK_EXIT'];

// The stub fails its check with this output.
function says(stderr, { stdout = '', exit = 1 } = {}) {
  process.env.STUB_CLAUDE_CHECK_STDERR = Buffer.from(stderr).toString('base64');
  process.env.STUB_CLAUDE_CHECK_STDOUT = Buffer.from(stdout).toString('base64');
  process.env.STUB_CLAUDE_CHECK_EXIT = String(exit);
}
function passes() {
  for (const key of KEYS.slice(2)) delete process.env[key];
}
const reasonFor = async (answer) => (await answer()).claude;

describe("the wizard's answer when the sign-in check fails", { skip: SKIP }, () => {
  let saved;
  const savedDeps = { ...sr.deps };
  const savedScd = { ...scd.deps };
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
      // does not wait the full 15 seconds.
      const { answer } = desktop({ execSync: (cmd, opts) => childProcess.execSync(cmd, { ...opts, timeout: 1000 }) });
      assert.deepStrictEqual(await reasonFor(answer), { status: 'not-authenticated', reason: { kind: 'timeout' } });
    });

    test('a check whose claude cannot be found answers that it could not be started', async () => {
      process.env.PATH = makeTempDir('sign-in-reason-empty-path-');
      const { answer } = desktop();
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
    const { answer, isClaudeAuthenticated } = desktop();
    assert.deepStrictEqual(await reasonFor(answer), { status: 'not-authenticated', reason: { kind: 'no-reason' } });
    assert.strictEqual(isClaudeAuthenticated(), false);
    passes();
    assert.strictEqual(isClaudeAuthenticated(), true);
    assert.deepStrictEqual(await reasonFor(answer), { status: 'ready' });
  });

  test('the check still answers only true or false, which the routing reads as before', () => {
    const { isClaudeAuthenticated } = desktop();
    assert.strictEqual(isClaudeAuthenticated(), true);
    says(`${OAUTH}\n`);
    assert.strictEqual(isClaudeAuthenticated(), false);
  });

  test('the check runs the same command, in the same environment, with the same 15-second limit and every stream piped', () => {
    const calls = [];
    const { isClaudeAuthenticated } = desktop({ execSync: (cmd, opts) => { calls.push([cmd, opts]); return childProcess.execSync(cmd, opts); } });
    isClaudeAuthenticated();
    assert.deepStrictEqual(calls, [['claude --print "test" --output-format text', { timeout: 15000, stdio: 'pipe' }]]);
  });

  test("the check's output never reaches the app's own stderr", () => {
    says(`${OAUTH}\n`, { stdout: 'stdout words\n' });
    const script = [
      `const src = require('node:fs').readFileSync(${JSON.stringify(MAIN_PATH)}, 'utf8');`,
      `const fn = ${CHECK}.exec(src);`,
      `const { createSignInReason } = require(${JSON.stringify(MODULE_PATH)});`,
      "const check = new Function('execSync', 'signInReason', `${fn[0]}\\nreturn isClaudeAuthenticated;`)(require('node:child_process').execSync, createSignInReason());",
      'process.stdout.write(String(check()));',
    ].join('\n');
    const run = childProcess.spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', env: { ...process.env, NODE_V8_COVERAGE: '' } });
    assert.strictEqual(run.stdout, 'false', run.stderr);
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
