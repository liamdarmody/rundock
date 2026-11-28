'use strict';
// The prove workflow runs each test as its test user, with TMPDIR set to the
// temporary directory testUser() gives it. A test that gives itself a made-up
// home makes it under TMPDIR, and the preload every test run loads
// (test/helpers/account-home-refused.js) fails the run when the answer-file
// guard is pointed at a startup file inside the home of the account running
// it. A temporary directory inside the test user's home would fail every
// honest test file that way; the one beside the home must not.
//
// Each half runs a fixture test file in a child node with what the workflow's
// `run the test` step gives the test user: the temporary directory from the
// real testUser() text, the variables from the real asTestUser() text, and
// the flags from the real testArgs() text, all cut out of prove.yml.
const { describe, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { loadPiece } = require('../helpers/prove-workflow.js');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURE = { file: 'test/fixtures/prove/made-up-home-watched.js', name: 'a turn in a made-up home under the temporary directory' };
const WARNING = "[Answer files] under test, not watching the account's own startup file: ";
// os.tmpdir() reads TMPDIR on Linux and macOS but TEMP on Windows, where no
// TMPDIR can place a made-up home, and the workflow runs only on Linux.
const SKIP = process.platform === 'win32' ? 'os.tmpdir() does not read TMPDIR on Windows, and the prove workflow runs only on Linux' : false;

// THE STAND-IN, for one thing only: where the account's home comes from. The
// child runs as the account running this test, whose real home no test may
// write in, so the preload is shown a made-up account home instead, by
// os.userInfo() answering with it in the child's own process. The preload
// reads the account's home from os.userInfo() and from nothing else, so its
// verdict on this home is the verdict it gives on a real account's home, such
// as the test user's on the runner, where HOME is that same home.
const standIn = (home) => [
  "'use strict';",
  "const os = require('node:os');",
  'const userInfo = os.userInfo;',
  `os.userInfo = (...args) => ({ ...userInfo(...args), homedir: ${JSON.stringify(home)} });`,
  '',
].join('\n');

/**
 * The workflow's run of the fixture for a test user whose home is `home`, the
 * user database answering with that home: the child's environment and
 * argument list, read from the one spawn the real asTestUser() makes.
 */
function workflowRun(home) {
  const spawned = [];
  const req = (name) => (name !== 'node:child_process' ? require(name) : {
    spawnSync: (cmd, args, opts) => {
      if (cmd === '/usr/bin/getent') return { status: 0, stdout: Buffer.from(`prove-test:x:1001:1001::${home}:/usr/sbin/nologin\n`) };
      spawned.push({ cmd, args, opts });
      return { status: 0, stdout: Buffer.from(''), stderr: Buffer.from('') };
    },
  });
  const { testUser, asTestUser } = loadPiece('test user', ['testUser', 'asTestUser'], req);
  const { testArgs } = loadPiece('run', ['testArgs'], req);
  const user = testUser();
  asTestUser(user, [user.node, ...testArgs(FIXTURE)], ROOT);
  assert.strictEqual(spawned.length, 1);
  const { args } = spawned[0];
  const at = args.indexOf('-i') + 1;
  const env = Object.fromEntries(args.slice(at, at + 5).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)]));
  assert.deepStrictEqual(Object.keys(env).sort(), ['CI', 'HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.strictEqual(env.HOME, home);
  return { user, env, argv: args.slice(at + 5) };
}

/**
 * Makes a made-up account home in a folder of this test's own, then runs the
 * fixture as the workflow would for that home, with TMPDIR at `tmpOf(home,
 * workflowTmp)`, made 0700 as prepare makes it. The child gets only the
 * workflow's five variables, so nothing of this run's own leaks in.
 */
function runFixture(tmpOf) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'prove-tmp-')));
  try {
    const home = path.join(root, 'prove-test');
    fs.mkdirSync(home, { mode: 0o700 });
    const { user, env, argv } = workflowRun(home);
    const tmp = tmpOf(home, user.tmp);
    // Never make a directory outside this test's own folder, whatever the
    // workflow text gives.
    assert.ok(tmp.startsWith(root + path.sep), `${tmp} is inside ${root}`);
    fs.mkdirSync(tmp, { mode: 0o700 });
    const preload = path.join(root, 'account-home-stand-in.js');
    fs.writeFileSync(preload, standIn(home));
    const r = spawnSync(argv[0], ['--require', preload, ...argv.slice(1)], {
      cwd: ROOT, env: { ...env, TMPDIR: tmp }, encoding: 'utf8', timeout: 120 * 1000,
    });
    return { home, tmp, status: r.status, out: `${r.stdout}${r.stderr}`, error: r.error };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('a made-up home under the test user\'s temporary directory', () => {
  test("TMPDIR at testUser()'s temporary directory: the test file exits 0", { skip: SKIP }, () => {
    const r = runFixture((home, tmp) => tmp);
    assert.strictEqual(r.error, undefined);
    assert.ok(!r.out.includes(WARNING), r.out);
    assert.ok(r.out.includes(`ok 1 - ${FIXTURE.name}`), r.out);
    assert.strictEqual(r.status, 0, r.out);
  });

  test('TMPDIR at <home>/scratch: the test file exits 1', { skip: SKIP }, () => {
    const r = runFixture((home) => path.join(home, 'scratch'));
    assert.strictEqual(r.error, undefined);
    assert.ok(r.out.includes(`${WARNING}${path.join(r.home, 'scratch')}`), r.out);
    assert.ok(r.out.includes(`ok 1 - ${FIXTURE.name}`), r.out);
    assert.strictEqual(r.status, 1, r.out);
  });
});
