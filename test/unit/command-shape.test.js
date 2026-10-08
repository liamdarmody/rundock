'use strict';
// A sandbox-excluded command wrapped in a shape its exclusion cannot match is
// refused before it runs, with the form that works; a bare one, and any
// command no exclusion names, runs as before. The shapes are the ones that
// have actually run sandboxed by mistake.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { classify, parse, runHook } = require('../../scripts/command-shape.js');
const { globToRegExp, exclusionsFrom, isSandboxed, refuseIfSandboxed } = require('../../scripts/lib/sandbox.js');

const PATTERNS = [
  'gh *',
  'git *',
  '*npx playwright *',
  'npm run precommit*',
  '*node scripts/precommit-gate.js*',
  'node /work/scratch/test-*/*.js',
  'npm run release:gate*',
];
const verdict = (cmd) => classify(cmd, PATTERNS);

describe('the shapes that ran sandboxed are refused', () => {
  test('a write chained in front of node', () => {
    const r = verdict('echo x > /work/scratch/test-a/in.txt && node /work/scratch/test-a/run.js');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.kind, 'wrapped');
    assert.strictEqual(r.segment, 'node /work/scratch/test-a/run.js');
  });

  test('gh piped into head', () => {
    const r = verdict('gh pr list --state open | head -5');
    assert.strictEqual(r.verdict, 'refuse');
    assert.ok(r.wrappers.includes('pipe'));
    assert.ok(r.fix.piped, 'a pipe is replaced by an output file');
    assert.match(r.message, /"stdout"/);
  });

  test('gh redirected to a file names that file as the output', () => {
    const r = verdict('gh pr view 12 --json body > /work/out/pr.json');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.fix.stdout, '/work/out/pr.json');
    assert.match(r.message, /"stdout":"\/work\/out\/pr\.json"/);
  });

  test('node with an argument where the exclusion names the script alone', () => {
    const r = verdict('node /work/scratch/test-a/run.js "a b"');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.kind, 'near-miss');
    assert.strictEqual(r.pattern, 'node /work/scratch/test-*/*.js');
    assert.match(r.message, /only without its\s+arguments/);
  });

  test('the pre-commit gate inside a chained git commit', () => {
    const r = verdict('npm run precommit && git commit -F /work/msg.txt');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.segment, 'npm run precommit');
  });

  test('cd into a worktree, then playwright: the two-call fix names the directory', () => {
    const r = verdict('cd /work/lane && npx playwright test e2e/a.spec.js');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.fix.cwd, '/work/lane');
    assert.deepStrictEqual(r.fix.argv, ['npx', 'playwright', 'test', 'e2e/a.spec.js']);
    assert.match(r.message, /1\. cd \/work\/lane\n {2}2\. npx playwright test e2e\/a\.spec\.js/);
    assert.match(r.message, /exempt-run\.js <args-file>\.json/);
    assert.match(r.message, /"cwd":"\/work\/lane"/);
  });

  test('a VAR=value prefix moves into the runner file', () => {
    const r = verdict('E2E_PORT=4100 npx playwright test');
    assert.strictEqual(r.verdict, 'refuse');
    assert.deepStrictEqual(r.fix.env, { E2E_PORT: '4100' });
    assert.doesNotMatch(r.message, /two calls/, 'no two-call form can carry an environment');
  });

  test('a substitution inside an exempt command', () => {
    const r = verdict('gh pr merge $(git rev-parse --abbrev-ref HEAD) --squash');
    assert.strictEqual(r.verdict, 'refuse');
    assert.ok(r.wrappers.includes('substitution'));
  });

  test('a push from another directory through a chain', () => {
    const r = verdict('cd /work/lane && git push origin feat/x');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.fix.cwd, '/work/lane');
  });

  test('the release gate run after anything', () => {
    assert.strictEqual(verdict('git status; npm run release:gate').verdict, 'refuse');
  });
});

describe('everything else runs as before', () => {
  for (const cmd of [
    'gh pr list --state open',
    'gh pr create --title "Two words" --body-file /work/body.md',
    'npx playwright test e2e/a.spec.js',
    'npm run precommit',
    'node /work/scratch/test-a/run.js',
    'npx playwright test 2>&1',
    'git commit -m "a message"',
  ]) {
    test(`bare: ${cmd}`, () => assert.strictEqual(verdict(cmd).verdict, 'pass'));
  }

  for (const cmd of [
    'ls -la | head',
    'cd /work && npm test',
    'node scripts/preflight.js > /work/out.txt',
  ]) {
    test(`not excluded at all: ${cmd}`, () => assert.strictEqual(verdict(cmd).verdict, 'pass'));
  }

  test('a wrapped git command that stays local loses nothing in the sandbox', () => {
    assert.strictEqual(verdict('git log --oneline | head -5').verdict, 'pass');
    assert.strictEqual(verdict('git add -A && git commit -F /work/msg.txt').verdict, 'pass');
  });

  test('a wrapped git command that talks to a remote is refused', () => {
    assert.strictEqual(verdict('git -C /work/lane push origin x | cat').verdict, 'refuse');
    assert.strictEqual(verdict('git fetch origin && git status').verdict, 'refuse');
  });

  test('operators inside quotes are not operators', () => {
    assert.strictEqual(verdict('gh pr comment 3 --body "a && b | c > d"').verdict, 'pass');
  });

  test('with no exclusions configured nothing is refused', () => {
    assert.strictEqual(classify('cd x && gh pr list | head', []).verdict, 'pass');
  });
});

describe('parsing', () => {
  test('a descriptor number is not an argument and a duplication is not a redirect', () => {
    const { segments, wrappers } = parse('npx playwright test 2>&1');
    assert.deepStrictEqual(segments[0].words, ['npx', 'playwright', 'test']);
    assert.strictEqual(wrappers.size, 0);
  });

  test('a substitution is one word, however many parentheses it holds', () => {
    const { segments } = parse('gh x $(echo (a)) y');
    assert.deepStrictEqual(segments[0].words, ['gh', 'x', '$(echo (a))', 'y']);
  });

  test('globs match the whole command', () => {
    assert.ok(globToRegExp('gh *').test('gh pr list'));
    assert.ok(!globToRegExp('node a.js').test('node a.js x'));
    assert.ok(globToRegExp('*ship.sh*').test('sh ./ship.sh "a b"'));
    assert.ok(!globToRegExp('a.b').test('axb'), 'a dot is literal');
  });
});

describe('the hook', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-shape-'));
  const settings = path.join(dir, 'settings.json');
  fs.writeFileSync(settings, JSON.stringify({ sandbox: { excludedCommands: ['gh *'] } }));
  const payload = (command, tool = 'Bash') => JSON.stringify({ tool_name: tool, tool_input: { command }, cwd: dir });
  const env = { CLAUDE_PROJECT_DIR: path.join(dir, 'none') };

  test('refuses with exit 2 and the fix on stderr', () => {
    const r = runHook({ input: payload('gh pr list | head'), argv: ['--settings', settings], env });
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /Refused before it ran/);
  });

  test('lets a bare command, another tool and an unreadable payload through', () => {
    assert.strictEqual(runHook({ input: payload('gh pr list'), argv: ['--settings', settings], env }).code, 0);
    assert.strictEqual(runHook({ input: payload('gh pr list | head', 'Read'), argv: ['--settings', settings], env }).code, 0);
    assert.strictEqual(runHook({ input: '{not json', argv: ['--settings', settings], env }).code, 0);
  });

  test('reads the project settings from CLAUDE_PROJECT_DIR', () => {
    const project = path.join(dir, 'project');
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { excludedCommands: ['*npx playwright *'] } }));
    const r = runHook({ input: payload('cd /x && npx playwright test'), env: { CLAUDE_PROJECT_DIR: project } });
    assert.strictEqual(r.code, 2);
  });

  test('runs as a process: stdin in, exit code out', () => {
    const r = spawnSync(process.execPath, [path.join(__dirname, '..', '..', 'scripts', 'command-shape.js'), '--settings', settings],
      { input: payload('cd /x && gh pr list'), encoding: 'utf8', env: { ...process.env, ...env } });
    assert.strictEqual(r.status, 2);
    assert.match(r.stderr, /two calls/);
  });

  test('an exclusions file that is missing or malformed contributes nothing', () => {
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{');
    assert.deepStrictEqual(exclusionsFrom([bad, path.join(dir, 'missing.json'), settings]), ['gh *']);
  });
});

describe('the sandbox marker', () => {
  test('only SANDBOX_RUNTIME=1 means sandboxed', () => {
    assert.strictEqual(isSandboxed({ SANDBOX_RUNTIME: '1' }), true);
    assert.strictEqual(isSandboxed({}), false);
    assert.strictEqual(isSandboxed({ SANDBOX_RUNTIME: '0' }), false);
  });

  test('a sandboxed step refuses at once, naming the cause and the bare command', () => {
    let code = null;
    let said = '';
    const refused = refuseIfSandboxed('The thing', 'npm run thing',
      { env: { SANDBOX_RUNTIME: '1' }, exit: (c) => { code = c; }, write: (s) => { said += s; } });
    assert.strictEqual(refused, true);
    assert.strictEqual(code, 2);
    assert.match(said, /The thing refused to start: it is running inside the agent sandbox/);
    assert.match(said, /\n {2}npm run thing\n/);
    assert.doesNotMatch(said, /can't start|token invalid/i);
  });

  test('outside the sandbox it does nothing', () => {
    let called = false;
    assert.strictEqual(refuseIfSandboxed('x', 'y', { env: {}, exit: () => { called = true; }, write: () => { called = true; } }), false);
    assert.strictEqual(called, false);
  });
});
