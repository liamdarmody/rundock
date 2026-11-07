'use strict';
// The mutation workflows, held to what keeps their one required check honest.
//
// A shard's verdict is its own file, uploaded whether or not the steps after
// it passed, so the aggregate must also read how GitHub recorded the shard
// jobs ending; a shard that left a file modified must fail and name each file;
// and the aggregate must not be able to end green by giving up. Both ci.yml
// (the scoped run behind `Mutation guards`) and the nightly sweep are read:
// they share the shape and the aggregate, and a fix made to one and not the
// other is the drift this pins.
const { test, describe, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const { parseWorkflow, readWorkflow, runCommands } = require('../helpers/workflow-text.js');

const WORKFLOWS = ['ci.yml', 'mutation-nightly.yml'];

const dirs = [];
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });
function tempDir(prefix) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(d);
  return d;
}

const runs = (step, text) => (step.run || '').includes(text);

// The three mutation jobs, found by what they run rather than by their ids,
// each exactly once.
function mutationJobs(wf) {
  const jobs = Object.values(wf.jobs);
  const running = (flag) => {
    const found = jobs.filter((j) => j.steps.some((s) => runs(s, 'scripts/mutation-scope.js') && runs(s, flag)));
    assert.strictEqual(found.length, 1,
      `${wf.label}: exactly one job runs mutation-scope.js ${flag}, found ${found.map((j) => j.id).join(', ') || 'none'}`);
    return found[0];
  };
  return { plan: running('--plan --out'), shard: running('--shard '), verdict: running('--aggregate') };
}

// The word after `flag` in a command, unquoted.
function flagValue(command, flag) {
  const words = command.split(/\s+/);
  const at = words.indexOf(flag);
  return at === -1 ? null : (words[at + 1] || '').replace(/^"|"$/g, '');
}

describe('the workflow reader', () => {
  test('it reads what each step runs and never a comment, and refuses a workflow it cannot read', () => {
    const specimen = [
      'name: specimen',
      'jobs:',
      '  # node scripts/mutation-scope.js --all, in a comment between jobs',
      '  plan:',
      '    name: Plan ${{ matrix.n }}',
      '    needs: [a, b]',
      '    if: always()',
      '    timeout-minutes: 5',
      '    steps:',
      '      # node scripts/mutation-scope.js --all, in a comment between steps',
      '      - name: Inline',
      '        run: node scripts/mutation-scope.js --all --plan --out plan.json',
      '      - name: Folded',
      '        # node scripts/mutation-scope.js --all, in a comment inside a step',
      '        env:',
      '          RESULT: ${{ needs.a.result }}',
      '        run: >-',
      '          node scripts/mutation-scope.js --aggregate',
      '          --shards-result "$RESULT"',
      '      - name: Literal',
      '        if: always()',
      '        run: |',
      '          # a shell comment is part of what runs',
      '          git diff --name-only HEAD',
      '',
      '          exit 0',
      '      - uses: actions/upload-artifact@v7',
      '        with:',
      '          path: verdict.json',
      '  other:',
      '    needs: plan',
      '    steps:',
      '      - run: echo done',
      'on: push',
      '',
    ].join('\n');
    const wf = parseWorkflow(specimen, 'specimen');
    assert.deepStrictEqual(Object.keys(wf.jobs), ['plan', 'other']);
    assert.deepStrictEqual(runCommands(wf).map((r) => r.run), [
      'node scripts/mutation-scope.js --all --plan --out plan.json',
      'node scripts/mutation-scope.js --aggregate --shards-result "$RESULT"',
      '# a shell comment is part of what runs\ngit diff --name-only HEAD\n\nexit 0',
      'echo done',
    ]);
    const { plan, other } = wf.jobs;
    assert.strictEqual(plan.name, 'Plan ${{ matrix.n }}');
    assert.deepStrictEqual(plan.needs, ['a', 'b']);
    assert.deepStrictEqual(other.needs, ['plan']);
    assert.strictEqual(plan.if, 'always()');
    assert.strictEqual(plan.timeoutMinutes, '5');
    assert.strictEqual(plan.steps[1].env.RESULT, '${{ needs.a.result }}');
    assert.strictEqual(plan.steps[2].if, 'always()');
    assert.strictEqual(plan.steps[3].uses, 'actions/upload-artifact@v7');
    assert.strictEqual(plan.steps[3].with.path, 'verdict.json');

    assert.throws(() => parseWorkflow('name: x\non: push\n', 'jobless'), /jobless: the workflow text has no jobs/);
    assert.throws(() => parseWorkflow('jobs:\n  a:\n    name: A\n', 'stepless'), /stepless: job a has no steps/);
  });

  test('it reads the real mutation workflows whole', () => {
    // A floor on what was read, so a reshaped file fails here rather than
    // leaving the checks below to pass on less than is there.
    for (const file of WORKFLOWS) {
      const wf = readWorkflow(file);
      assert.ok(Object.keys(wf.jobs).length >= 3, `${file}: jobs were read`);
      assert.ok(runCommands(wf).length >= 8, `${file}: run commands were read (${runCommands(wf).length})`);
      mutationJobs(wf);
    }
  });
});

describe('the aggregate reads how GitHub recorded the shard jobs ending', () => {
  test('both workflows give the aggregate the shard jobs\' result, and it still runs always()', () => {
    for (const file of WORKFLOWS) {
      const { plan, shard, verdict } = mutationJobs(readWorkflow(file));
      assert.strictEqual(verdict.if, 'always()',
        `${file}: the aggregate job must run always(), or a failed shard skips it and a skipped required check passes`);
      assert.ok(verdict.needs.includes(plan.id) && verdict.needs.includes(shard.id),
        `${file}: the aggregate job needs ${plan.id} and ${shard.id}, found ${verdict.needs.join(', ')}`);
      const step = verdict.steps.find((s) => runs(s, '--aggregate'));
      for (const [flag, job] of [['--shards-result', shard], ['--plan-result', plan]]) {
        const value = flagValue(step.run, flag);
        assert.ok(value && value.startsWith('$'), `${file}: the aggregate is given ${flag} from its environment, got ${value}`);
        assert.strictEqual(step.env[value.slice(1)], `\${{ needs.${job.id}.result }}`,
          `${file}: ${flag} is how GitHub recorded ${job.id} ending`);
      }
    }
  });

  test('the aggregate job is bounded, and nothing in it ends green by giving up', () => {
    // Stalled, it is cut off at its limit, and a job cut off has failed.
    for (const file of WORKFLOWS) {
      const { verdict } = mutationJobs(readWorkflow(file));
      assert.strictEqual(verdict.timeoutMinutes, '5', `${file}: the aggregate job is held to five minutes`);
      assert.strictEqual(verdict.continueOnError, undefined, `${file}: the aggregate job may not continue on error`);
      for (const s of verdict.steps) {
        assert.strictEqual(s.continueOnError, undefined, `${file}: step "${s.name}" may not continue on error`);
        assert.ok(!/\|\|\s*(?:true|:|exit 0)\b/.test(s.run || ''), `${file}: step "${s.name}" swallows its own failure`);
      }
    }
  });
});

describe('a shard that left a file modified fails, names each file, and its verdict is still uploaded', () => {
  // The diff check, as both workflows run it.
  function diffChecks() {
    return WORKFLOWS.map((file) => {
      const { shard } = mutationJobs(readWorkflow(file));
      const at = (found, what) => {
        const i = shard.steps.findIndex(found);
        assert.ok(i !== -1, `${file}: the shard job has no ${what}`);
        return i;
      };
      const run = at((s) => runs(s, '--shard '), 'mutation run');
      const diff = at((s) => runs(s, 'git diff'), 'diff check');
      const upload = at((s) => (s.uses || '').startsWith('actions/upload-artifact@') && (s.with.path || '').includes('verdict-'),
        'verdict upload');
      return { file, shard, run, diff, upload };
    });
  }

  test('in both workflows the diff check runs after the harnesses, whatever they did, and before the upload', () => {
    const checks = diffChecks();
    for (const { file, shard, run, diff, upload } of checks) {
      assert.ok(run < diff && diff < upload, `${file}: run, then the diff check, then the upload (${run}, ${diff}, ${upload})`);
      assert.strictEqual(shard.steps[diff].if, 'always()',
        `${file}: the diff check runs after a run that failed, so a shard whose guard survived is checked too`);
      assert.strictEqual(shard.steps[upload].if, 'always()',
        `${file}: a failed guard's verdict is still uploaded, since it is the evidence a reader needs`);
    }
    assert.strictEqual(checks[0].shard.steps[checks[0].diff].run, checks[1].shard.steps[checks[1].diff].run,
      'both workflows run the same diff check, so the one run below is the one each runs');
  });

  // A throwaway repository with three committed files.
  function fixtureRepo() {
    const root = tempDir('mutation-diff-check-');
    const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    git('init', '-q');
    git('config', 'user.email', 'diff-check@example.com');
    git('config', 'user.name', 'Diff Check');
    git('config', 'commit.gpgsign', 'false');
    for (const [rel, text] of [['lib/a.js', 'a\n'], ['lib/b.js', 'b\n'], ['docs/c.md', 'c\n']]) {
      fs.mkdirSync(path.join(root, path.dirname(rel)), { recursive: true });
      fs.writeFileSync(path.join(root, rel), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'initial');
    return root;
  }

  // GitHub runs a `run:` with no `shell:` as `bash -e {0}`.
  function runCheck(cwd) {
    const scratch = tempDir('mutation-diff-check-run-');
    const script = path.join(scratch, 'check.sh');
    const summary = path.join(scratch, 'summary.md');
    const [{ shard, diff }] = diffChecks();
    fs.writeFileSync(script, `${shard.steps[diff].run}\n`);
    fs.writeFileSync(summary, '');
    const r = spawnSync('bash', ['-e', script], { cwd, encoding: 'utf8', env: { ...process.env, GITHUB_STEP_SUMMARY: summary } });
    return { ...r, summary: fs.readFileSync(summary, 'utf8') };
  }

  test('a re-run attempt can upload the plan and its verdict again, so a clean retry can go green', () => {
    // "Re-run failed jobs" keeps the run, and the first attempt's artifact of
    // the same name is still there. Without overwrite the second upload is
    // refused, the re-run job fails at its upload however clean its run was,
    // and the aggregate stays red over a retry that should turn it green.
    for (const file of WORKFLOWS) {
      const { plan, shard } = mutationJobs(readWorkflow(file));
      const uploads = (job, what) => {
        const found = job.steps.filter((s) => (s.uses || '').startsWith('actions/upload-artifact@')
          && (s.with.path || '').includes(what));
        assert.strictEqual(found.length, 1, `${file}: ${job.id} uploads ${what} exactly once`);
        return found[0];
      };
      for (const [job, what] of [[plan, 'mutation-plan.json'], [shard, 'verdict-']]) {
        assert.strictEqual(uploads(job, what).with.overwrite, 'true',
          `${file}: ${job.id}'s upload of ${what} overwrites an artifact a previous attempt left`);
      }
    }
  });

  test('the diff check fails naming every file left modified, in its log and in the job summary', () => {
    const root = fixtureRepo();
    const clean = runCheck(root);
    assert.strictEqual(clean.status, 0, `a clean tree passes\n${clean.stdout}${clean.stderr}`);
    assert.strictEqual(clean.summary, '', 'and adds nothing to the summary');

    fs.appendFileSync(path.join(root, 'lib', 'a.js'), 'left behind\n');
    fs.rmSync(path.join(root, 'docs', 'c.md'));
    const dirty = runCheck(root);
    assert.notStrictEqual(dirty.status, 0, `a tree left modified fails\n${dirty.stdout}${dirty.stderr}`);
    for (const f of ['lib/a.js', 'docs/c.md']) {
      assert.ok(dirty.stdout.includes(f), `the log names ${f}\n${dirty.stdout}`);
      assert.ok(dirty.summary.includes(f), `the summary names ${f}\n${dirty.summary}`);
    }
    assert.ok(!dirty.summary.includes('lib/b.js'), 'and only the files that were left modified');

    const notARepo = runCheck(tempDir('mutation-diff-check-no-repo-'));
    assert.notStrictEqual(notARepo.status, 0, 'a diff check that cannot run git is not a pass');
  });
});
