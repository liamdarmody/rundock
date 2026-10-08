'use strict';
// The long steps that cannot work inside the agent sandbox refuse in their
// first seconds there, naming the cause and the bare command, instead of
// failing late as a browser that cannot start or a credential that reads as
// invalid. The capability preflight answers the same question for a lane
// before it depends on a browser or a push.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { preflight, checkBrowser, checkPush } = require('../../scripts/capability-preflight.js');

const ROOT = path.join(__dirname, '..', '..');

describe('a long step refuses at once inside the sandbox', () => {
  for (const [label, args, name, bare] of [
    ['the release gate', ['scripts/release-gate.js'], 'The release gate', 'npm run release:gate'],
    ['the stream capture', ['scripts/stream-truth/run.mjs', '--capture'], 'The stream capture', 'npm run stream:truth -- --capture'],
    ['the transcript capture', ['scripts/transcript-truth/run.mjs', '--capture'], 'The transcript capture', 'npm run transcript:truth -- --capture'],
  ]) {
    test(label, () => {
      const started = Date.now();
      const r = spawnSync(process.execPath, args, {
        cwd: ROOT, encoding: 'utf8', timeout: 20000, env: { ...process.env, SANDBOX_RUNTIME: '1' },
      });
      assert.strictEqual(r.status, 2, r.stderr);
      assert.ok(Date.now() - started < 10000, 'it refused before doing any work');
      assert.match(r.stderr, new RegExp(`^${name} refused to start: it is running inside the agent sandbox`));
      assert.ok(r.stderr.includes(`\n  ${bare}\n`), 'the bare command is named');
    });
  }
});

describe('the capability preflight', () => {
  const never = () => { throw new Error('nothing may be tried inside the sandbox'); };

  test('inside the sandbox it tries nothing and names the sandbox as the cause', async () => {
    const r = await preflight({ env: { SANDBOX_RUNTIME: '1' }, browser: never, push: never });
    assert.strictEqual(r.code, 2);
    const text = r.lines.join('\n');
    assert.match(text, /SANDBOXED/);
    assert.match(text, /one bare command/);
    assert.doesNotMatch(text, /can't start|token invalid/i);
  });

  test('outside it, each check reports ok or its cause and fix', async () => {
    const r = await preflight({
      env: {},
      browser: async () => ({ ok: true, detail: 'fine' }),
      push: () => ({ ok: false, cause: 'git could not authenticate to origin.', fix: 'gh auth setup-git' }),
    });
    assert.strictEqual(r.code, 1);
    assert.deepStrictEqual(r.lines, [
      '[capability] browser: ok. fine',
      '[capability] push: FAIL. git could not authenticate to origin.',
      '[capability]   fix: gh auth setup-git',
    ]);
  });

  test('a browser that is not installed is named, with the install command', async () => {
    const r = await checkBrowser({ launch: async () => { throw new Error("browserType.launch: Executable doesn't exist at /x/chrome"); } });
    assert.deepStrictEqual([r.ok, r.fix], [false, 'npx playwright install chromium']);
    assert.match(r.cause, /no Chromium installed/);
  });

  test('a browser that starts and renders passes, and is closed', async () => {
    let closed = false;
    const page = { setContent: async () => {}, textContent: async () => 'ok' };
    const r = await checkBrowser({ launch: async () => ({ newPage: async () => page, close: async () => { closed = true; } }) });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(closed, true);
  });

  const runner = (answers) => (cmd, args) => {
    const key = `${cmd} ${args[0]}`;
    return answers[key] || { status: 0, stdout: '', stderr: '' };
  };

  test('a push that cannot authenticate says so, never "token invalid"', () => {
    const r = checkPush({ run: runner({
      'git symbolic-ref': { status: 0, stdout: 'chore/x\n', stderr: '' },
      'git push': { status: 128, stdout: '', stderr: 'fatal: could not read Username for https://github.com: terminal prompts disabled' },
    }) });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.cause, 'git could not authenticate to origin.');
    assert.match(r.fix, /gh auth setup-git/);
  });

  test('the push is a dry run of this branch', () => {
    const seen = [];
    const r = checkPush({ run: (cmd, args) => {
      seen.push([cmd, ...args].join(' '));
      return cmd === 'git' && args[0] === 'symbolic-ref' ? { status: 0, stdout: 'chore/x\n' } : { status: 0, stdout: '' };
    } });
    assert.strictEqual(r.ok, true);
    assert.ok(seen.includes('git push --dry-run --porcelain origin HEAD:refs/heads/chore/x'), seen.join('\n'));
  });

  test('gh signed out fails the push check with its own fix', () => {
    const r = checkPush({ run: runner({
      'git symbolic-ref': { status: 0, stdout: 'chore/x\n' },
      'gh auth': { status: 1, stdout: '', stderr: 'not logged in' },
    }) });
    assert.deepStrictEqual([r.ok, r.fix], [false, 'gh auth login (at a terminal)']);
  });

  test('a detached HEAD has nothing to push', () => {
    const r = checkPush({ run: runner({ 'git symbolic-ref': { status: 1, stdout: '' } }) });
    assert.match(r.cause, /not on a branch/);
  });
});
