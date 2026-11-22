'use strict';
// What .github/workflows/prove.yml says, read as text.
//
// The workflow is started by hand with seven string inputs, reads the
// repository and nothing more, and runs each blocker test and each breakage on
// a fresh runner. These tests hold the parts of it no run of its code would
// show: the trigger, the permissions, the runner, which expressions it
// expands and where, what each job runs before the test, and that the copies
// of a step shared by several jobs are the same text.
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { readProve, loadPiece } = require('../helpers/prove-workflow.js');
const { expandAliases, parseWorkflow, readWorkflow } = require('../helpers/workflow-text.js');
const { FLAGS: CAPTURE_FLAGS, NODE_VERSION: CAPTURE_NODE } = require('../fixtures/prove/capture.js');
const { REQUIRED_CI_CHECKS } = require('../../scripts/release-ci.js');

const ROOT = path.join(__dirname, '..', '..');
const { text, workflow } = readProve();
const lines = text.split('\n');
const jobs = Object.values(workflow.jobs);

const INPUTS = ['nonce', 'blocked', 'main', 'head', 'tests', 'rows', 'inputs_sha256'];
const TEST_USER_STEPS = ['prepare the test user', 'install', 'run the test', 'stop the test user', 'check the tree', 'judge the result'];
const STEPS = {
  red: ["check out the workflow's commit", 'set up Node', 'check inputs', 'merge main into the blocked head',
    'check the change', 'take the tests from the fix head', ...TEST_USER_STEPS],
  green: ["check out the workflow's commit", 'set up Node', 'check inputs', 'check out the fix head', ...TEST_USER_STEPS],
  break: ["check out the workflow's commit", 'set up Node', 'check inputs', 'check out the fix head', 'apply the row',
    ...TEST_USER_STEPS],
};
// The environment variables each step written in Node reads. The runner sets
// RUNNER_TEMP and the GITHUB_ file-command paths; every other name comes from
// the step's own env.
const FILE_COMMANDS = ['GITHUB_ENV', 'GITHUB_OUTPUT', 'GITHUB_PATH', 'GITHUB_STATE', 'GITHUB_STEP_SUMMARY'];
const ENTRY_NAMES = ['ENTRY', 'ROWS', 'RUNNER_TEMP', 'SIDE', 'TESTS'];
const READS = {
  'check inputs': ['BLOCKED_SHA', 'HEAD_SHA', 'INPUTS_SHA256', 'MAIN_SHA', 'NONCE', 'ROWS', 'TESTS'],
  'merge main into the blocked head': ['BLOCKED_SHA', 'MAIN_SHA'],
  'check the change': ['HEAD_SHA', 'ROWS'],
  'apply the row': ['ENTRY', 'ROWS'],
  'prepare the test user': ['RUNNER_TEMP'],
  install: FILE_COMMANDS,
  'run the test': [...ENTRY_NAMES, ...FILE_COMMANDS].sort(),
  'stop the test user': ENTRY_NAMES,
  'check the tree': ['RUNNER_TEMP'],
  'judge the result': ENTRY_NAMES,
};
const FROM_RUNNER = ['RUNNER_TEMP', ...FILE_COMMANDS];

/** The lines of a top-level block, from the line after its key to the next top-level line. */
function topBlock(key) {
  const from = lines.indexOf(`${key}:`);
  assert.ok(from !== -1, `prove.yml has a top-level ${key}:`);
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => l.trim() && !l.startsWith(' ') && !l.startsWith('#'));
  return (to === -1 ? rest : rest.slice(0, to)).filter((l) => l.trim() && !l.trimStart().startsWith('#'));
}

const keysAt = (block, depth) => block.map((l) => new RegExp(`^ {${depth}}([\\w-]+):`).exec(l)).filter(Boolean).map((m) => m[1]);

/** Each step of a job as its raw text, by name. */
function rawSteps(job) {
  const steps = new Map();
  let current = null;
  for (const line of job.text.split('\n')) {
    const m = /^ {6}- name: (.+)$/.exec(line);
    if (m) {
      assert.ok(!steps.has(m[1]), `job ${job.id} has one step named "${m[1]}"`);
      current = [line];
      steps.set(m[1], current);
    } else if (current) {
      current.push(line);
    }
  }
  return new Map([...steps].map(([name, body]) => [name, body.join('\n').trimEnd()]));
}

const isNode = (raw) => /^ {8}shell: node \{0\}$/m.test(raw);

describe('how the workflow starts and what it may touch', () => {
  test('its top-level keys are the name, run-name, trigger, permissions and jobs, and nothing else', () => {
    const top = lines.filter((l) => /^[\w-]+:/.test(l)).map((l) => l.split(':')[0]);
    assert.deepStrictEqual(top, ['name', 'run-name', 'on', 'permissions', 'jobs']);
  });

  test('it is started by hand only, with the seven inputs, each a required string', () => {
    const on = topBlock('on');
    assert.deepStrictEqual(keysAt(on, 2), ['workflow_dispatch']);
    assert.deepStrictEqual(keysAt(on, 4), ['inputs']);
    assert.deepStrictEqual(keysAt(on, 6), INPUTS);
    assert.deepStrictEqual([...new Set(keysAt(on, 8))].sort(), ['description', 'required', 'type']);
    const at8 = on.filter((l) => /^ {8}\S/.test(l));
    assert.strictEqual(at8.filter((l) => l === '        required: true').length, INPUTS.length);
    assert.strictEqual(at8.filter((l) => l === '        type: string').length, INPUTS.length);
  });

  test('the run-name is prove and the five values that tell the run apart', () => {
    assert.ok(lines.includes('run-name: prove ${{ inputs.nonce }} ${{ inputs.blocked }} ${{ inputs.main }} ${{ inputs.head }} ${{ inputs.inputs_sha256 }}'));
  });

  test('it may read the repository contents and nothing else', () => {
    assert.deepStrictEqual(topBlock('permissions'), ['  contents: read']);
    for (const job of jobs) assert.ok(!/^ {4}permissions:/m.test(job.text), `job ${job.id} sets no permissions of its own`);
  });

  test('it reads no secret or token, and runs no workflow but its own', () => {
    for (const banned of ['secrets.', 'github.token', 'GITHUB_TOKEN', 'pull_request_target', 'workflow_run', 'workflow_call']) {
      assert.ok(!text.includes(banned), `prove.yml does not mention ${banned}`);
    }
    const uses = jobs.flatMap((j) => j.steps.map((s) => s.uses).filter(Boolean));
    assert.deepStrictEqual([...new Set(uses)].sort(), ['actions/checkout@v5', 'actions/setup-node@v5']);
    assert.ok(!/^ {4}uses:/m.test(text), 'no job calls a reusable workflow');
  });

  test('its name is not CI, and no job is named like a check a release requires', () => {
    assert.ok(lines.includes('name: Prove'));
    const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const like = (name) => new RegExp(`^${name.split(/\$\{\{[^}]*\}\}/).map(escape).join('.+')}$`);
    for (const job of jobs) {
      for (const check of REQUIRED_CI_CHECKS) assert.ok(!like(job.name).test(check), `"${job.name}" is not named like "${check}"`);
    }
  });
});

describe('the jobs', () => {
  test('there are exactly a red, a green and a break job, named by their entry', () => {
    assert.deepStrictEqual(jobs.map((j) => j.id), ['red', 'green', 'break']);
    for (const job of jobs) assert.strictEqual(job.name, `${job.id} \${{ matrix.i }}`);
  });

  test('each runs on ubuntu-24.04 for at most 15 minutes, every entry to the end', () => {
    for (const job of jobs) {
      assert.deepStrictEqual(keysAt(job.text.split('\n'), 4), ['name', 'runs-on', 'timeout-minutes', 'strategy', 'steps'], job.id);
      assert.ok(/^ {4}runs-on: ubuntu-24\.04$/m.test(job.text), `${job.id} runs on ubuntu-24.04`);
      assert.strictEqual(job.timeoutMinutes, '15', job.id);
      assert.ok(/^ {6}fail-fast: false$/m.test(job.text), `${job.id} lets every entry finish`);
      const list = job.id === 'break' ? 'rows' : 'tests';
      assert.ok(job.text.includes(`        include: \${{ fromJSON(inputs.${list}) }}`), `${job.id} has an entry per one of ${list}`);
    }
  });

  test('each runs its steps, under their names, in order', () => {
    for (const job of jobs) assert.deepStrictEqual(job.steps.map((s) => s.name), STEPS[job.id], job.id);
  });

  test('a step shared by several jobs is the same text in each', () => {
    const copies = new Map();
    for (const job of jobs) {
      for (const [name, raw] of rawSteps(job)) copies.set(name, [...(copies.get(name) || []), { job: job.id, raw }]);
    }
    const shared = [...copies].filter(([, c]) => c.length > 1).map(([name]) => name).sort();
    assert.deepStrictEqual(shared, ["check out the workflow's commit", 'check inputs', 'check out the fix head',
      'check the tree', 'install', 'judge the result', 'prepare the test user', 'run the test', 'set up Node',
      'stop the test user'].sort());
    for (const name of shared) {
      const [first, ...rest] = copies.get(name);
      for (const c of rest) assert.strictEqual(c.raw, first.raw, `"${name}" in ${c.job} is the text it is in ${first.job}`);
    }
  });

  test('the workflow carries no YAML anchors or aliases', () => {
    assert.ok(!lines.some((l) => /^\s*[\w-]+:\s*[&*][\w-]+/.test(l) || /^\s*<<:/.test(l)));
  });

  test('no step or job is skipped on a condition or lets a failure pass', () => {
    lines.forEach((line, n) => {
      assert.ok(!/^\s*(-\s+)?(if|continue-on-error):/.test(line), `line ${n + 1} sets a condition or lets a failure pass: ${line}`);
    });
  });

  test('nothing in the workflow names /tmp, /var/tmp or /dev/shm', () => {
    for (const dir of ['/tmp', '/var/tmp', '/dev/shm']) assert.ok(!text.includes(dir), `prove.yml does not name ${dir}`);
  });

  test('the checkout is the workflow commit, with full history and no stored credentials', () => {
    for (const job of jobs) {
      const step = job.steps[0];
      assert.deepStrictEqual(step.with, { 'fetch-depth': '0', 'persist-credentials': 'false' }, job.id);
    }
  });

  test("Node is exactly 24.12.0, the version the captures were taken on, in CI's 24 line, with no package cache", () => {
    const ci = Object.values(readWorkflow('ci.yml').jobs).find((j) => j.name === 'Test (Node ${{ matrix.node }})');
    assert.ok(ci, "ci.yml's test job is found");
    const matrix = /^\s*node: \[([^\]]+)\]/m.exec(ci.text);
    const versions = matrix ? matrix[1].split(',').map((v) => v.trim().replace(/'/g, '')) : [];
    assert.ok(versions.includes('24'), `24 is in ${versions.join(', ')}`);
    assert.strictEqual(CAPTURE_NODE, 'v24.12.0');
    for (const job of jobs) {
      assert.deepStrictEqual(job.steps[1].with, { 'node-version': `'${CAPTURE_NODE.slice(1)}'`, 'package-manager-cache': 'false' }, job.id);
    }
    assert.ok(!/^\s*cache:/m.test(text), 'no cache is restored');
  });
});

describe('what reaches a run block, and what runs before the test', () => {
  // Every expression and the one place it may stand.
  const ENV = {
    NONCE: 'inputs.nonce', BLOCKED_SHA: 'inputs.blocked', MAIN_SHA: 'inputs.main', HEAD_SHA: 'inputs.head',
    TESTS: 'inputs.tests', ROWS: 'inputs.rows', INPUTS_SHA256: 'inputs.inputs_sha256',
    ENTRY: 'matrix.i', SIDE: 'github.job',
  };

  test('no run block holds an expression', () => {
    for (const job of jobs) {
      for (const step of job.steps) {
        if (step.run !== undefined) assert.ok(!step.run.includes('${{'), `${job.id}, "${step.name}"`);
      }
    }
  });

  test('an expression appears only in the run-name, a job name, a matrix, or a step env value', () => {
    lines.forEach((line, n) => {
      if (!line.includes('${{')) return;
      if (n === 1 || /^ {4}name: \w+ \$\{\{ matrix\.i \}\}$/.test(line)) return;
      if (/^ {8}include: \$\{\{ fromJSON\(inputs\.(tests|rows)\) \}\}$/.test(line)) return;
      const m = /^ {10}([A-Z0-9_]+): \$\{\{ ([\w.]+) \}\}$/.exec(line);
      assert.ok(m, `line ${n + 1} expands an expression where none may stand: ${line}`);
      assert.strictEqual(ENV[m[1]], m[2], `line ${n + 1}: ${m[1]} comes from ${ENV[m[1]]}`);
      const owner = lines.slice(0, n).reverse().find((l) => /^ {0,8}\S/.test(l));
      assert.strictEqual(owner, '        env:', `line ${n + 1} is in a step's env`);
    });
  });

  test('the only install is npm ci with package scripts off, run as the test user, and no shell step runs anything from the commits', () => {
    const allowed = ['git checkout -q --detach "$HEAD_SHA"', 'rm -rf test', 'git checkout "$HEAD_SHA" -- test'];
    for (const job of jobs) {
      for (const [name, raw] of rawSteps(job)) {
        const step = job.steps.find((s) => s.name === name);
        if (step.run === undefined || isNode(raw)) continue;
        assert.ok(!/^ {8}shell:/m.test(raw), `${job.id}, "${name}" runs in the default shell or in node`);
        for (const command of step.run.split('\n').filter((l) => l.trim())) {
          assert.ok(allowed.includes(command.trim()), `${job.id}, "${name}" runs ${command}`);
        }
      }
      // npm named as a program: a quoted argument, or a shell line.
      const npm = job.steps.filter((s) => s.run && /['"`]npm['"`]|^\s*npm\s/m.test(s.run));
      assert.deepStrictEqual(npm.map((s) => s.name), ['install'], `${job.id}: only install starts npm`);
      const install = npm[0].run;
      assert.strictEqual(install.split("asTestUser(user, ['npm', 'ci', '--ignore-scripts'], user.copy)").length, 2, `${job.id}: install starts npm ci --ignore-scripts once, as the test user`);
      assert.strictEqual(install.split("'npm'").length, 2, `${job.id}: install names npm nowhere else`);
    }
  });

  test('the code in a node step loads only modules built into Node', () => {
    const TAIL = ['prepare the test user', 'install', 'run the test', 'stop the test user', 'check the tree', 'judge the result'];
    const NODE_STEPS = {
      red: ['check inputs', 'merge main into the blocked head', 'check the change', ...TAIL],
      green: ['check inputs', ...TAIL],
      break: ['check inputs', 'apply the row', ...TAIL],
    };
    for (const job of jobs) {
      const names = [...rawSteps(job)].filter(([, raw]) => isNode(raw)).map(([name]) => name);
      assert.deepStrictEqual(names, NODE_STEPS[job.id], `the node steps of ${job.id} are the ones held here`);
      for (const [name, raw] of rawSteps(job)) {
        if (!isNode(raw)) continue;
        const loads = [...raw.matchAll(/require\(([^)]*)\)/g)].map((m) => m[1]);
        assert.ok(loads.length, `${job.id}, "${name}" loads something`);
        for (const what of loads) assert.match(what, /^'node:[a-z_/]+'$/, `${job.id}, "${name}" loads ${what}`);
      }
    }
  });

  test("the change is read with git's exact path list, renames not detected", () => {
    assert.ok(text.includes("const DIFF = 'git -c core.quotePath=false diff -z --name-only --no-renames';"));
  });

  // The test user's own environment is read by the one script that prints
  // its names; that text runs as the test user, never in the step.
  const KEYS_SCRIPT = "\"process.stdout.write(Object.keys(process.env).sort().join(' '))\"";

  test('each node step reads exactly the environment variables listed here, through env alone', () => {
    for (const job of jobs) {
      for (const [name, raw] of rawSteps(job)) {
        if (!isNode(raw)) continue;
        const run = job.steps.find((s) => s.name === name).run;
        assert.ok(READS[name], `${job.id}, "${name}" is listed here`);
        const code = run.split(KEYS_SCRIPT).join('');
        assert.deepStrictEqual(code.match(/process\.env\b.*$/gm), ['process.env;'], `${job.id}, "${name}" reads process.env once`);
        assert.strictEqual(code.split('const env = process.env;').length, 2, `${job.id}, "${name}" names it env`);
        assert.ok(!/\benv\s*\[/.test(code), `${job.id}, "${name}" reads env only by name`);
        assert.ok(!/\{[^}]*\}\s*=\s*env\b/.test(code), `${job.id}, "${name}" does not destructure env`);
        assert.ok(!/\b(Object\.(keys|values|entries|assign)|JSON\.stringify)\(\s*env\b/.test(code), `${job.id}, "${name}" does not walk env`);
        const read = [...new Set([...code.matchAll(/\benv\.([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]))].sort();
        assert.deepStrictEqual(read, [...READS[name]].sort(), `${job.id}, "${name}" reads ${read.join(' ')}`);
        const rawLines = raw.split('\n');
        const at = rawLines.indexOf('        env:');
        const rest = at === -1 ? [] : rawLines.slice(at + 1);
        const end = rest.findIndex((l) => !/^ {10}/.test(l));
        const given = keysAt(end === -1 ? rest : rest.slice(0, end), 10);
        assert.deepStrictEqual(given.sort(), read.filter((k) => !FROM_RUNNER.includes(k)), `${job.id}, "${name}" is given in env what it reads`);
      }
    }
  });
});

describe('how the test user is started', () => {
  // The test-user piece, its child_process faked so the arguments of each
  // spawn can be read without starting anything.
  const spawned = [];
  const fakeRequire = (name) => {
    if (name === 'node:child_process') return { spawnSync: (cmd, args, opts) => { spawned.push({ cmd, args, opts }); return { status: 0, stdout: Buffer.from('') }; } };
    return require(name);
  };
  const { asTestUser, LIMIT, SUDO, TEST_USER } = loadPiece('test user', ['asTestUser', 'LIMIT', 'SUDO', 'TEST_USER'], fakeRequire);

  test('through sudo by full path, with env -i and exactly five variables before the command', () => {
    spawned.length = 0;
    const user = { name: TEST_USER, home: '/fake/users/u', tmp: '/fake/users/u/scratch', bin: '/fake/node/bin' };
    asTestUser(user, ['cmd', 'arg'], '/fake/users/u/checkout');
    assert.strictEqual(SUDO, '/usr/bin/sudo');
    assert.strictEqual(TEST_USER, 'prove-test');
    assert.deepStrictEqual(spawned.map((s) => [s.cmd, s.args]), [[SUDO, ['-n', '-u', TEST_USER, '--', '/usr/bin/env', '-i',
      'PATH=/fake/node/bin:/usr/bin:/bin', 'HOME=/fake/users/u', 'TMPDIR=/fake/users/u/scratch', 'LANG=C.UTF-8', 'CI=true', 'cmd', 'arg']]]);
    assert.deepStrictEqual(spawned[0].opts, { argv0: 'sudo', cwd: '/fake/users/u/checkout', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: LIMIT });
    assert.strictEqual(LIMIT, 64 * 1024 * 1024);
  });

  test('every step that starts the test user does so only through that one function', () => {
    for (const job of jobs) {
      for (const step of job.steps) {
        if (!step.run) continue;
        // sudo -n -u is how a process starts as another user.
        const starts = step.run.split(/['"`]-n['"`]\s*,\s*['"`]-u['"`]/).length - 1;
        assert.strictEqual(starts, step.run.includes('function asTestUser(') ? 1 : 0, `${job.id}, "${step.name}" starts another user only in asTestUser`);
        if (starts) assert.ok(step.run.includes("spawnSync(SUDO, ['-n', '-u', user.name, '--', '/usr/bin/env', '-i',"), `${job.id}, "${step.name}"`);
      }
    }
  });
});

describe('how the test is run', () => {
  const { FLAGS, escape, testArgs, testFor } = loadPiece('run', ['FLAGS', 'escape', 'testArgs', 'testFor']);

  test('with the TAP reporter and the preloads npm test uses', () => {
    const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.test.split(' ');
    const preloads = script.flatMap((word, n) => (word === '--require' ? [`--require ${script[n + 1]}`] : []));
    assert.ok(preloads.length >= 1, 'sanity: npm test preloads something');
    assert.strictEqual(FLAGS, ['--test --test-reporter=tap', ...preloads].join(' '));
    assert.strictEqual(CAPTURE_FLAGS, FLAGS, 'the captures were taken with the same flags');
  });

  test('the full name, escaped and anchored, is the only name pattern, and the TAP goes to standard output', () => {
    const name = 'a (b) [c] {d} * + ? . ^ $ | \\ / end';
    const args = testArgs({ name, file: 'test/x.test.js' });
    assert.deepStrictEqual(args.slice(0, -3), FLAGS.split(' '));
    assert.deepStrictEqual(args.slice(-3, -1), ['--test-name-pattern', `^${escape(name)}$`]);
    assert.strictEqual(args[args.length - 1], 'test/x.test.js');
    const pattern = new RegExp(args[args.length - 2]);
    assert.ok(pattern.test(name), 'the name matches itself');
    for (const other of [`${name} more`, `more ${name}`, name.replace('(', '['), 'a b c d']) assert.ok(!pattern.test(other), other);
    assert.ok(testArgs({ name: '/x/i', file: 'f' })[args.length - 2].startsWith('^'), 'a name in slashes is never read as a regex literal');
    assert.ok(!text.includes('--test-reporter-destination'), 'no reporter writes to a file');
  });

  test('a red or green entry runs its own test, and a break entry the test its row names', () => {
    const tests = [{ i: 1, file: 'test/a.test.js', name: 'a' }, { i: 2, file: 'test/b.test.js', name: 'b' }];
    const rows = [{ i: 1, file: 'src/a.js', from: 'x', to: 'y', test: 2 }];
    assert.strictEqual(testFor('red', '2', tests, rows).name, 'b');
    assert.strictEqual(testFor('green', '1', tests, rows).name, 'a');
    assert.strictEqual(testFor('break', '1', tests, rows).name, 'b');
    assert.throws(() => testFor('break', '2', tests, rows));
    assert.throws(() => testFor('red', '3', tests, rows));
  });

  test('three runs, the TAP and exit status of each kept in the evidence directory under the runner temp directory', () => {
    const run = rawSteps(workflow.jobs.red).get('run the test');
    assert.ok(run.includes("path.join(env.RUNNER_TEMP, 'prove-evidence')"));
    assert.ok(run.includes('for (let n = 1; n <= 3; n++)') && run.includes('`run-${n}.tap`') && run.includes('`exit-${n}.json`'));
  });
});

describe('the workflow reader resolves a run or env alias, and refuses every other anchor or alias', () => {
  const text = (...l) => [...l, ''].join('\n');
  const refused = (workflow, message) => assert.throws(() => expandAliases(workflow, 'example'), { message });

  // A workflow with a shared step written once and aliased in a later job, and
  // the same workflow written out in full.
  const BUILD_ENV = ['          MODE: ${{ inputs.mode }}', '          ENTRY: ${{ matrix.i }}'];
  const BUILD_RUN = ['          const env = process.env;', '', '          if (env.MODE && env.ENTRY) {',
    "            console.log('example/alpha');", '          }'];
  const example = (anchored) => text(
    'name: example', 'on: workflow_dispatch', 'jobs:',
    '  alpha:', '    runs-on: ubuntu-24.04', '    steps:',
    '      - name: build', '        shell: node {0}',
    anchored ? '        env: &build-env' : '        env:', ...BUILD_ENV,
    anchored ? '        run: &build-run |' : '        run: |', ...BUILD_RUN,
    '',
    '      - name: check',
    anchored ? '        run: &check-run git diff --exit-code' : '        run: git diff --exit-code',
    '  beta:', '    runs-on: ubuntu-24.04', '    steps:',
    '      - name: build', '        shell: node {0}',
    ...(anchored ? ['        env: *build-env'] : ['        env:', ...BUILD_ENV]),
    ...(anchored ? ['        run: *build-run'] : ['        run: |', ...BUILD_RUN]),
    '',
    '      - name: only here', '        run: echo beta',
    '      - name: check',
    anchored ? '        run: *check-run' : '        run: git diff --exit-code',
  );

  test('an anchored workflow reads as the same jobs and steps as the same workflow written out in full', () => {
    assert.strictEqual(expandAliases(example(true), 'example'), example(false));
    const crlf = (s) => s.replace(/\n/g, '\r\n');
    assert.strictEqual(expandAliases(crlf(example(true)), 'example'), crlf(example(false)), 'a CRLF checkout expands the same');
    const read = parseWorkflow(example(true), 'example');
    assert.deepStrictEqual(read, parseWorkflow(example(false), 'example'));
    assert.deepStrictEqual(read.jobs.beta.steps.map((s) => s.name), ['build', 'only here', 'check']);
    assert.deepStrictEqual(read.jobs.beta.steps[0].env, { MODE: '${{ inputs.mode }}', ENTRY: '${{ matrix.i }}' });
    assert.strictEqual(read.jobs.beta.steps[0].run, BUILD_RUN.map((l) => l.slice(10)).join('\n'));
    assert.strictEqual(read.jobs.beta.steps[2].run, 'git diff --exit-code');
  });

  test('ci.yml, like every workflow with no anchor or alias, passes through byte for byte', () => {
    const dir = path.join(ROOT, '.github', 'workflows');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.yml') && f !== 'prove.yml');
    assert.ok(files.includes('ci.yml'), 'ci.yml is among them');
    for (const file of files) {
      const raw = fs.readFileSync(path.join(dir, file), 'utf8');
      assert.strictEqual(expandAliases(raw, file), raw, file);
    }
  });

  // A step aliased two spaces deeper than where it is anchored, and another
  // aliased two spaces shallower.
  test('a run block aliased deeper or shallower than its anchor moves to the alias, its own indentation kept', () => {
    const anchored = text(
      'jobs:', '  alpha:', '    steps:',
      '      - name: build', '        run: &build-run |', '          echo one', '', '            echo two',
      '  beta:', '    steps:',
      '        - name: build', '          run: *build-run',
      '        - name: check', '          run: &check-run |', '            git diff', '              --exit-code',
      '  gamma:', '    steps:',
      '      - name: check', '        run: *check-run',
    );
    const written = text(
      'jobs:', '  alpha:', '    steps:',
      '      - name: build', '        run: |', '          echo one', '', '            echo two',
      '  beta:', '    steps:',
      '        - name: build', '          run: |', '            echo one', '', '              echo two',
      '        - name: check', '          run: |', '            git diff', '              --exit-code',
      '  gamma:', '    steps:',
      '      - name: check', '        run: |', '          git diff', '            --exit-code',
    );
    assert.strictEqual(expandAliases(anchored, 'example'), written);
    const { jobs } = parseWorkflow(anchored, 'example');
    assert.strictEqual(jobs.beta.steps[0].run, 'echo one\n\n  echo two');
    assert.strictEqual(jobs.gamma.steps[0].run, 'git diff\n  --exit-code');
  });

  test('an env mapping aliased deeper or shallower than its anchor moves to the alias', () => {
    const anchored = text(
      'jobs:', '  alpha:', '    steps:',
      '      - name: build', '        env: &build-env', '          MODE: fast', '          ENTRY: ${{ matrix.i }}', '        run: echo one',
      '  beta:', '    steps:',
      '        - name: build', '          env: *build-env', '          run: echo one',
      '        - name: check', '          env: &check-env', "            STRICT: 'yes'", '          run: git diff',
      '  gamma:', '    steps:',
      '      - name: check', '        env: *check-env', '        run: git diff',
    );
    const written = text(
      'jobs:', '  alpha:', '    steps:',
      '      - name: build', '        env:', '          MODE: fast', '          ENTRY: ${{ matrix.i }}', '        run: echo one',
      '  beta:', '    steps:',
      '        - name: build', '          env:', '            MODE: fast', '            ENTRY: ${{ matrix.i }}', '          run: echo one',
      '        - name: check', '          env:', "            STRICT: 'yes'", '          run: git diff',
      '  gamma:', '    steps:',
      '      - name: check', '        env:', "          STRICT: 'yes'", '        run: git diff',
    );
    assert.strictEqual(expandAliases(anchored, 'example'), written);
    const { jobs } = parseWorkflow(anchored, 'example');
    assert.deepStrictEqual(jobs.beta.steps[0].env, { MODE: 'fast', ENTRY: '${{ matrix.i }}' });
    assert.deepStrictEqual(jobs.gamma.steps[0].env, { STRICT: "'yes'" });
  });

  // Two jobs of one step each, from each step's lines: alpha's start at line 4.
  const twoJobs = (alpha, beta) => text('jobs:', '  alpha:', '    steps:', ...alpha, '  beta:', '    steps:', ...beta);
  const ANCHOR = ['      - name: build', '        run: &build-run |', '          echo one'];
  const ENV_ANCHOR = ['      - name: build', '        env: &build-env', '          MODE: fast', '        run: echo one'];

  test('an alias with no anchor before it is refused', () => {
    refused(twoJobs(['      - name: build', '        run: *build-run'], ANCHOR),
      'example: line 5: an alias with no anchor before it (run: *build-run)');
    refused(twoJobs(ANCHOR, ['      - name: build', '        run: *test-run']),
      'example: line 10: an alias with no anchor before it (run: *test-run)');
  });

  test('an anchor defined twice is refused', () => {
    refused(twoJobs(ANCHOR, ANCHOR), 'example: line 10: an anchor defined twice, first at line 5 (run: &build-run |)');
  });

  test('an anchor never used is refused', () => {
    refused(twoJobs(ANCHOR, ['      - name: build', '        run: echo one']),
      'example: line 5: an anchor never used (run: &build-run |)');
  });

  test('a merge key is refused', () => {
    refused(twoJobs(ENV_ANCHOR, ['      - name: build', '        env:', '          <<: *build-env', '        run: echo one']),
      'example: line 12: a merge key (<<: *build-env)');
    refused(twoJobs(['      - name: build', '        <<: { run: echo one }'], ['      - name: build', '        run: echo one']),
      'example: line 5: a merge key (<<: { run: echo one })');
  });

  test('an anchor or alias on any other key is refused', () => {
    const cause = 'an anchor or alias anywhere but the whole value of run or env';
    refused(twoJobs(['      - name: &build build', '        run: echo one'], ['      - name: *build', '        run: echo one']),
      `example: line 4: ${cause} (- name: &build build)`);
    refused(text('jobs:', '  alpha: &job', '    steps:', '      - run: echo one', '  beta: *job'),
      `example: line 2: ${cause} (alpha: &job)`);
    refused(text('jobs:', '  alpha:', '    steps: &steps', '      - run: echo one', '  beta:', '    steps: *steps'),
      `example: line 3: ${cause} (steps: &steps)`);
    refused(twoJobs(['      - name: build', '        env:', '          MODE: &mode fast', '        run: echo one'],
      ['      - name: build', '        env:', '          MODE: *mode', '        run: echo one']),
    `example: line 6: ${cause} (MODE: &mode fast)`);
    refused(twoJobs(['      - name: build', '        with: { node: &node 24 }'], ['      - name: build', '        with: { node: *node }']),
      `example: line 5: ${cause} (with: { node: &node 24 })`);
    refused(twoJobs(['      - name: build', '        &key run: echo one'], ['      - name: build', '        run: echo one']),
      `example: line 5: ${cause} (&key run: echo one)`);
    refused(twoJobs(['      - name: build', '        env: &build-env', '          run: &inner one'], ['      - name: build', '        env: *build-env']),
      `example: line 6: ${cause} (run: &inner one)`);
  });

  test('an anchor or alias on a list item is refused', () => {
    refused(twoJobs(['      - &build name: build', '        run: echo one'], ['      - name: build', '        run: echo one']),
      'example: line 4: an anchor or alias on a list item (- &build name: build)');
    refused(twoJobs(['      - name: build', '        run: echo one'], ['      - *build']),
      'example: line 8: an anchor or alias on a list item (- *build)');
  });

  test('an alias with anything after its name, on its line or below it, is refused', () => {
    const cause = 'an alias with something after its name';
    for (const after of [' extra', ' # the same', '|']) {
      refused(twoJobs(ANCHOR, ['      - name: build', `        run: *build-run${after}`]),
        `example: line 10: ${cause} (run: *build-run${after})`);
    }
    refused(twoJobs(ENV_ANCHOR, ['      - name: build', '        env: *build-env', '          ENTRY: one', '        run: echo one']),
      `example: line 12: ${cause} (ENTRY: one)`);
  });

  test('an anchor with something joined to its name is refused', () => {
    refused(twoJobs(['      - name: build', '        run: &build-run|', '          echo one'], ['      - name: build', '        run: *build-run']),
      'example: line 5: an anchor with something joined to its name (run: &build-run|)');
  });
});
