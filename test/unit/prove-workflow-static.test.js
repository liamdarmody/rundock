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
const { readWorkflow } = require('../helpers/workflow-text.js');
const { FLAGS: CAPTURE_FLAGS } = require('../fixtures/prove/capture.js');
const { REQUIRED_CI_CHECKS } = require('../../scripts/release-ci.js');

const ROOT = path.join(__dirname, '..', '..');
const { text, workflow } = readProve();
const lines = text.split('\n');
const jobs = Object.values(workflow.jobs);

const INPUTS = ['nonce', 'blocked', 'main', 'head', 'tests', 'rows', 'inputs_sha256'];
const STEPS = {
  red: ["check out the workflow's commit", 'set up Node', 'check inputs', 'merge main into the blocked head',
    'check the change', 'take the tests from the fix head', 'install', 'run the test', 'check the tree', 'judge the result'],
  green: ["check out the workflow's commit", 'set up Node', 'check inputs', 'check out the fix head', 'install',
    'run the test', 'check the tree', 'judge the result'],
  break: ["check out the workflow's commit", 'set up Node', 'check inputs', 'check out the fix head', 'apply the row',
    'install', 'run the test', 'check the tree', 'judge the result'],
};

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
      'check the tree', 'install', 'judge the result', 'run the test', 'set up Node'].sort());
    for (const name of shared) {
      const [first, ...rest] = copies.get(name);
      for (const c of rest) assert.strictEqual(c.raw, first.raw, `"${name}" in ${c.job} is the text it is in ${first.job}`);
    }
  });

  test('the workflow carries no YAML anchors or aliases', () => {
    assert.ok(!lines.some((l) => /^\s*[\w-]+:\s*[&*][\w-]+/.test(l) || /^\s*<<:/.test(l)));
  });

  test('the checkout is the workflow commit, with full history and no stored credentials', () => {
    for (const job of jobs) {
      const step = job.steps[0];
      assert.deepStrictEqual(step.with, { 'fetch-depth': '0', 'persist-credentials': 'false' }, job.id);
    }
  });

  test("Node is 24, one of the versions CI's test job runs, with no package cache", () => {
    const ci = Object.values(readWorkflow('ci.yml').jobs).find((j) => j.name === 'Test (Node ${{ matrix.node }})');
    assert.ok(ci, "ci.yml's test job is found");
    const matrix = /^\s*node: \[([^\]]+)\]/m.exec(ci.text);
    const versions = matrix ? matrix[1].split(',').map((v) => v.trim().replace(/'/g, '')) : [];
    assert.ok(versions.includes('24'), `24 is in ${versions.join(', ')}`);
    for (const job of jobs) {
      assert.deepStrictEqual(job.steps[1].with, { 'node-version': "'24'", 'package-manager-cache': 'false' }, job.id);
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

  test('every install is npm ci with package scripts off, and no shell step runs anything else from the commits', () => {
    const allowed = ['npm ci --ignore-scripts', 'git checkout -q --detach "$HEAD_SHA"', 'rm -rf test', 'git checkout "$HEAD_SHA" -- test'];
    for (const job of jobs) {
      for (const [name, raw] of rawSteps(job)) {
        const step = job.steps.find((s) => s.name === name);
        if (step.run === undefined || isNode(raw)) continue;
        assert.ok(!/^ {8}shell:/m.test(raw), `${job.id}, "${name}" runs in the default shell or in node`);
        for (const command of step.run.split('\n').filter((l) => l.trim())) {
          assert.ok(allowed.includes(command.trim()), `${job.id}, "${name}" runs ${command}`);
        }
      }
      const raws = rawSteps(job);
      const installs = job.steps.filter((s) => s.run && !isNode(raws.get(s.name)) && s.run.includes('npm'));
      assert.deepStrictEqual(installs.map((s) => s.run.trim()), ['npm ci --ignore-scripts'], job.id);
    }
  });

  test('the code in a node step loads only modules built into Node', () => {
    const NODE_STEPS = {
      red: ['check inputs', 'merge main into the blocked head', 'check the change', 'run the test', 'check the tree', 'judge the result'],
      green: ['check inputs', 'run the test', 'check the tree', 'judge the result'],
      break: ['check inputs', 'apply the row', 'run the test', 'check the tree', 'judge the result'],
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

  test('the full name, escaped and anchored, is the only name pattern', () => {
    const name = 'a (b) [c] {d} * + ? . ^ $ | \\ / end';
    const args = testArgs({ name, file: 'test/x.test.js' }, '/runner/run-1.tap');
    assert.deepStrictEqual(args.slice(0, -3), [...FLAGS.split(' '), '--test-reporter-destination=/runner/run-1.tap']);
    assert.deepStrictEqual(args.slice(-3, -1), ['--test-name-pattern', `^${escape(name)}$`]);
    assert.strictEqual(args[args.length - 1], 'test/x.test.js');
    const pattern = new RegExp(args[args.length - 2]);
    assert.ok(pattern.test(name), 'the name matches itself');
    for (const other of [`${name} more`, `more ${name}`, name.replace('(', '['), 'a b c d']) assert.ok(!pattern.test(other), other);
    assert.ok(testArgs({ name: '/x/i', file: 'f' }, 'd')[args.length - 2].startsWith('^'), 'a name in slashes is never read as a regex literal');
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

  test('three runs, each to its own TAP file under the runner temp directory', () => {
    const run = rawSteps(workflow.jobs.red).get('run the test');
    assert.ok(run.includes("path.join(env.RUNNER_TEMP, 'prove')"));
    assert.ok(run.includes('for (let n = 1; n <= 3; n++)') && run.includes('`run-${n}.tap`'));
  });
});
