'use strict';
// A CI run that did not succeed is read job by job, and re-run once only when
// a runner going away was the whole reason. The fixtures are real runs of
// this repository, recorded with only the fields read here, plus two cases
// built from them where no recording exists (each says so in `source`).
const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { classifyJob, decide } = require('../../scripts/ci-verdict.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'ci-verdict');
const load = (name) => JSON.parse(fs.readFileSync(path.join(FIXTURES, `${name}.json`), 'utf8'));
const decideFor = (fx, extra = {}) => decide({
  run: fx.run,
  jobs: fx.jobs,
  annotationsFor: (job) => fx.annotations[job.id] || [],
  ...extra,
});

describe('each recorded case gets the action it should', () => {
  test('a runner shutdown on a first attempt is no verdict, and re-run once', () => {
    const v = decideFor(load('runner-shutdown'));
    assert.strictEqual(v.action, 'rerun');
    assert.match(v.reason, /^no verdict: Test \(Node 22\)/);
    assert.strictEqual(v.jobs.find((j) => j.name === 'Test (Node 22)').kind, 'runner-lost');
  });

  test('the same shutdown on the second attempt is never re-run, so a retry cannot loop', () => {
    const v = decideFor(load('runner-shutdown-second-attempt'));
    assert.strictEqual(v.action, 'none');
    assert.match(v.reason, /attempt 2 is never re-run/);
    assert.strictEqual(decideFor(load('second-attempt')).action, 'none');
  });

  test('a run superseded by the concurrency group is left alone', () => {
    const fx = load('superseded');
    const v = decideFor(fx);
    assert.strictEqual(v.action, 'none');
    assert.match(v.reason, /superseded/);
    for (const j of v.jobs.filter((x) => x.kind !== 'ok')) assert.strictEqual(j.kind, 'superseded', j.name);
  });

  test('a job at its time cap is no verdict, and not re-run, because it would time out again', () => {
    const v = decideFor(load('timed-out'));
    assert.strictEqual(v.action, 'none');
    assert.match(v.reason, /no verdict: .*time cap/);
    assert.strictEqual(v.jobs.find((j) => j.kind !== 'ok').kind, 'timed-out');
  });

  test('a real failure is left alone, even beside a job that only timed out', () => {
    const v = decideFor(load('real-failure'));
    assert.strictEqual(v.action, 'none');
    assert.match(v.reason, /a real failure: Coverage floors/);
  });

  test('a newer run for the same branch means superseded, whatever the jobs say', () => {
    assert.strictEqual(decideFor(load('runner-shutdown'), { newerRun: true }).action, 'none');
  });
});

describe('classifying one job', () => {
  test('lost communication is a lost runner, as a shutdown is', () => {
    const c = classifyJob({ conclusion: 'failure' }, [{ title: '', message: 'The self-hosted runner lost communication with the server.' }]);
    assert.strictEqual(c.kind, 'runner-lost');
  });

  test('the mutation check\'s no verdict is retried only when a signal ended a shard', () => {
    const bySignal = classifyJob({ conclusion: 'failure' },
      [{ title: 'No verdict: shard 2: mutate-x-guards.js no verdict (ended by signal SIGTERM)', message: '' }]);
    assert.strictEqual(bySignal.kind, 'runner-lost');
    const missing = classifyJob({ conclusion: 'failure' },
      [{ title: 'No verdict: shard 2 wrote no verdict (it died, was cancelled or timed out)', message: '' }]);
    assert.strictEqual(missing.kind, 'no-verdict');
  });

  test('a green, skipped or neutral job is not looked at', () => {
    for (const conclusion of ['success', 'skipped', 'neutral']) {
      assert.strictEqual(classifyJob({ conclusion }, [{ message: 'The runner has received a shutdown signal.' }]).kind, 'ok');
    }
  });

  test('a plain non-zero exit is a real failure', () => {
    assert.strictEqual(classifyJob({ conclusion: 'failure' }, [{ title: '', message: 'Process completed with exit code 1.' }]).kind, 'failure');
  });
});

describe('the retry workflow', () => {
  const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ci-retry.yml'), 'utf8');

  test('it runs on a completed CI run, first attempts only, and not on success', () => {
    assert.match(yml, /workflow_run:\n\s+workflows: \[CI\]\n\s+types: \[completed\]/);
    assert.match(yml, /github\.event\.workflow_run\.run_attempt == 1/);
    assert.match(yml, /github\.event\.workflow_run\.conclusion != 'success'/);
  });

  test('it can re-run actions and write nothing else, and never runs pull request code', () => {
    // workflow_run runs with the base repository's token, so checking out the
    // head of the run that triggered it would hand that token to its code.
    const perms = /permissions:\n((?:\s{2}\S.*\n)+)/.exec(yml);
    assert.ok(perms, 'the workflow declares its permissions');
    const granted = perms[1].trim().split('\n').map((l) => l.trim());
    assert.deepStrictEqual(granted.filter((l) => /: write$/.test(l)), ['actions: write'], 'only actions may be written');
    assert.doesNotMatch(yml, /head_sha|head_branch|ref: \$\{\{ github\.event\.workflow_run/,
      'the checkout must be the default branch, never the run\'s head');
    assert.doesNotMatch(yml, /npm (ci|install)/, 'nothing is installed, so nothing from a package runs');
  });
});
