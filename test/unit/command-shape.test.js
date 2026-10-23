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
    assert.ok(r.fix.piped);
  });

  test('gh redirected to a file names that file as the output', () => {
    const r = verdict('gh pr view 12 --json body > /work/out/pr.json');
    assert.strictEqual(r.verdict, 'refuse');
    assert.strictEqual(r.fix.stdout, '/work/out/pr.json');
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
  });

  test('a VAR=value prefix', () => {
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

describe('the refusal names forms that work', () => {
  const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'exempt-run.js');
  const refusals = [
    'gh pr list --state open | head -5',
    'gh pr view 12 --json body > /work/out/pr.json',
    'cd /work/lane && npx playwright test e2e/a.spec.js',
    'E2E_PORT=4100 npx playwright test',
    'node /work/scratch/test-a/run.js "a b"',
  ];

  test('a command that needs nothing from its wrapper: run it bare, and read the output from the result', () => {
    for (const cmd of ['gh pr list --state open | head -5', 'gh pr view 12 --json body > /work/out/pr.json']) {
      const { message } = verdict(cmd);
      assert.match(message, /Run it bare, as one call with nothing before or after it:\n {2}gh pr (list --state open|view 12 --json body)\n/);
      assert.match(message, /Its output comes back as the result of the call: read it there, not through a pipe or a file\./);
    }
  });

  test('a command after a cd: two calls, the cd and then the command, piped or not', () => {
    const r = verdict('cd /work/lane && gh pr list | head -5');
    assert.match(r.message, /Run it as two calls, the cd alone and then the command alone:\n {2}1\. cd \/work\/lane\n {2}2\. gh pr list\n/);
    const git = verdict('cd /work/other && git -C /work/lane push origin x | cat');
    assert.match(git.message, /Run it bare[^\n]*\n {2}git -C \/work\/lane push origin x\n/, 'git -C already carries its directory');
    assert.doesNotMatch(git.message, /two calls/);
  });

  test('a VAR=value: a small script in the test tree or the scratch folder that sets it for its child process', () => {
    const message = verdict('cd /work/lane && E2E_PORT=4100 npx playwright test').message.replace(/\s+/g, ' ');
    assert.match(message, /A bare command cannot carry E2E_PORT=4100\./);
    assert.match(message, /small script in the repository's test tree or its gitignored scratch folder \(\.rundock\/scratch\/\)/);
    assert.match(message, /starts the command as a child process in \/work\/lane with that set, and run the script bare\./);
  });

  test('an exclusion that names the script alone: put the values inside it and run it with no arguments', () => {
    const { message } = verdict('node /work/scratch/test-a/run.js "a b"');
    assert.match(message, /Put the values inside the script and run it bare, as the exclusion names it:\n {2}node \/work\/scratch\/test-a\/run\.js$/m);
  });

  describe('a suggested command is printed as written, quotes and all', () => {
    for (const [label, cmd, written] of [
      ['single quotes', "gh pr comment 3 --body 'it works' | cat", "gh pr comment 3 --body 'it works'"],
      ['double quotes', 'gh pr comment 3 --body "npx playwright test" | cat', 'gh pr comment 3 --body "npx playwright test"'],
      ['escaped quotes', 'gh pr comment 3 --body "say \\"hi\\"" --title it\\\'s | cat', 'gh pr comment 3 --body "say \\"hi\\"" --title it\\\'s'],
      ['after a here-document', "python3 - <<'EOF'\nprint('x')\nEOF\ngh pr comment 3 --body 'done: \"ok\"' | cat", "gh pr comment 3 --body 'done: \"ok\"'"],
    ]) {
      test(label, () => {
        const r = verdict(cmd);
        assert.strictEqual(r.segment, written);
        assert.ok(r.message.includes(`\n  ${written}\n`), r.message);
      });
    }

    test('a cd, a VAR=value and a near miss, with no spaces round the operators', () => {
      assert.match(verdict('cd "/work/my lane"&&gh pr list||true').message, /\n {2}1\. cd "\/work\/my lane"\n {2}2\. gh pr list$/);
      const env = verdict("E2E_TITLE='a b' npx playwright test");
      assert.match(env.message, /cannot carry E2E_TITLE='a b'\./);
      assert.strictEqual(env.segment, 'npx playwright test', 'the VAR=value is not part of the command shown');
      assert.match(verdict("node '/work/scratch/test-a/run.js' \"a b\"").message, /\n {2}node '\/work\/scratch\/test-a\/run\.js'$/);
    });
  });

  test('the runner is offered only when its own command is excluded', () => {
    for (const cmd of refusals) assert.doesNotMatch(verdict(cmd).message, /exempt-run/, cmd);
    const withRunner = [...PATTERNS, `node ${RUNNER} *`];
    const cd = classify('cd /work/lane && npx playwright test e2e/a.spec.js', withRunner).message;
    assert.match(cd, new RegExp(`Or, as the runner's own command is excluded too[^\\n]*\\n {2}node ${RUNNER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} <args-file>\\.json\\n`));
    assert.match(cd, /"cwd":"\/work\/lane"/);
    assert.match(classify('gh pr view 12 --json body > /work/out/pr.json', withRunner).message, /"stdout":"\/work\/out\/pr\.json"/);
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

  describe('text that is data, not a command, is never matched', () => {
    const script = [
      "python3 - <<'EOF'",
      'import subprocess',
      '# the browser comes from npx playwright install chromium',
      'print("if this fails, run npx playwright install first")',
      'EOF',
    ].join('\n');

    test('the body of a quoted here-document fed to an interpreter', () => {
      assert.strictEqual(verdict(script).verdict, 'pass');
    });

    test('the body of a here-document that never reaches its delimiter', () => {
      assert.strictEqual(verdict(script.slice(0, script.lastIndexOf('\nEOF'))).verdict, 'pass');
    });

    test('a real exempt command after or before the here-document is still refused', () => {
      const after = verdict(`${script}\nnpx playwright test | tail -3`);
      assert.strictEqual(after.verdict, 'refuse');
      assert.strictEqual(after.segment, 'npx playwright test');
      const before = verdict(`gh pr list > /work/out.txt; ${script}`);
      assert.strictEqual(before.verdict, 'refuse');
      assert.strictEqual(before.segment, 'gh pr list');
    });

    test('a quoted string argument, which still leaves the command it is passed to matched', () => {
      assert.strictEqual(verdict('python3 -c "import os; os.system(\'npx playwright install\')" > /work/out.txt').verdict, 'pass');
      assert.strictEqual(verdict("echo 'next: npx playwright test' && npm test").verdict, 'pass');
      const r = verdict('gh pr comment 3 --body "npx playwright test" | cat');
      assert.strictEqual(r.verdict, 'refuse');
      assert.strictEqual(r.pattern, 'gh *');
      assert.strictEqual(r.segment, 'gh pr comment 3 --body "npx playwright test"');
      assert.strictEqual(verdict('E2E_TITLE="a b" npx playwright test').verdict, 'refuse', 'a quoted VAR=value is not the command');
      assert.strictEqual(verdict('cd "/work/my lane" && npx playwright test').fix.cwd, '/work/my lane', 'a quoted word leaves the next one unquoted');
    });

    test('quoted text that runs something, or follows a VAR=value or a quoted word, is judged on its own', () => {
      assert.strictEqual(verdict('echo "$(npx playwright test)" | cat').verdict, 'refuse', 'a substitution in quotes runs a command');
      assert.strictEqual(verdict('echo $(true) "npx playwright test" | cat').verdict, 'pass', 'a substitution marks only its own word');
      assert.strictEqual(verdict('A=1 echo "npx playwright test" | cat').verdict, 'pass', 'the VAR=value takes its own mark with it');
      assert.strictEqual(verdict('echo "x" npx\\ playwright\\ test | cat').verdict, 'refuse', 'a word after a quoted one is not quoted');
    });
  });

  describe('text a shell runs is a command, and is matched like one', () => {
    for (const shell of ['sh', 'bash', 'zsh', 'dash', 'ksh']) {
      test(`${shell} -c`, () => {
        const r = verdict(`${shell} -c "npx playwright test" | cat`);
        assert.strictEqual(r.verdict, 'refuse');
        assert.strictEqual(r.segment, 'npx playwright test');
        assert.ok(r.wrappers.includes('shell'));
      });
    }

    test('a shell named by its path, with -c in a cluster of options', () => {
      assert.strictEqual(verdict("/bin/bash -lc 'gh pr list' > /work/out.txt").segment, 'gh pr list');
    });

    test('eval', () => {
      assert.strictEqual(verdict('eval "gh pr list" | cat').segment, 'gh pr list');
    });

    test('a here-document fed to a shell, and what it runs that loses nothing in the sandbox', () => {
      const r = verdict("bash <<'EOF'\ncd /work/lane\nnpx playwright test\nEOF");
      assert.strictEqual(r.verdict, 'refuse');
      assert.strictEqual(r.segment, 'npx playwright test');
      assert.strictEqual(r.fix.cwd, '/work/lane');
      assert.strictEqual(verdict("bash <<'EOF'\nls -la\nEOF").verdict, 'pass');
      assert.strictEqual(verdict('bash -c "git status" | cat').verdict, 'pass');
    });

    test('a bare shell whose command string an exclusion names, when the whole command matches none', () => {
      assert.strictEqual(verdict('bash -c "gh pr list"').verdict, 'refuse');
      assert.strictEqual(verdict('bash -c "npx playwright test"').verdict, 'pass', 'the whole command matches "*npx playwright *"');
    });

    test('a cd before the shell is the directory its command runs in', () => {
      assert.strictEqual(verdict('cd /work/lane && sh -c "npx playwright test"').fix.cwd, '/work/lane');
    });

    test('a quoted program path, and a quoted command word, are matched as written', () => {
      const r = verdict('node "/work/scratch/test-a/run.js" | head');
      assert.strictEqual(r.verdict, 'refuse');
      assert.strictEqual(r.pattern, 'node /work/scratch/test-*/*.js');
      assert.strictEqual(classify('"/work/my tools/run" x | cat', ['/work/my tools/run *']).verdict, 'refuse');
    });
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

  test('a wrapped command runs as written when its sandbox is deliberately off, and is refused when it is on', () => {
    const shaped = (input) => JSON.stringify({ tool_name: 'Bash', tool_input: input, cwd: dir });
    const run = (input) => runHook({ input: shaped(input), argv: ['--settings', settings], env }).code;
    assert.strictEqual(run({ command: 'cd /x && gh pr list | head', dangerouslyDisableSandbox: true }), 0);
    assert.strictEqual(run({ command: 'cd /x && gh pr list | head', dangerouslyDisableSandbox: false }), 2);
    assert.strictEqual(run({ command: 'cd /x && gh pr list | head' }), 2);
    assert.strictEqual(run({ command: 'cd /x && gh pr list | head', dangerouslyDisableSandbox: 'true' }), 2,
      'only the boolean the tool sends turns the sandbox off');
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

  const RUNNER = path.join(__dirname, '..', '..', 'scripts', 'exempt-run.js');
  const said = (options) => {
    let out = '';
    refuseIfSandboxed('The thing', 'npm run thing', { env: { SANDBOX_RUNTIME: '1' }, exit: () => {}, write: (s) => { out += s; }, ...options });
    return out;
  };

  test('it names the runner only when its own command is excluded, and otherwise the cd and script forms', () => {
    const plain = said({ patterns: [] });
    assert.doesNotMatch(plain, /exempt-run/);
    assert.match(plain.replace(/\s+/g, ' '), /Run a cd as a call of its own first, and read the output from the result of the call\./);
    assert.match(plain.replace(/\s+/g, ' '), /a small script in the repository's test tree or its gitignored scratch folder \(\.rundock\/scratch\/\)/);
    assert.match(said({ patterns: [`node ${RUNNER} *`] }), /Or, as scripts\/exempt-run\.js is itself excluded/);
  });

  test('without exclusions given, it reads the ones configured for the project', () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'command-shape-project-'));
    fs.mkdirSync(path.join(project, '.claude'));
    fs.writeFileSync(path.join(project, '.claude', 'settings.local.json'),
      JSON.stringify({ sandbox: { excludedCommands: [`node ${RUNNER} *`] } }));
    assert.match(said({ env: { SANDBOX_RUNTIME: '1', CLAUDE_PROJECT_DIR: project } }), /scripts\/exempt-run\.js is itself excluded/);
  });
});
