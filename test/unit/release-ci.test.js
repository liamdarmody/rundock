'use strict';
// The release gate takes the suite, coverage and browser results from CI
// instead of running them again.
//
// Why: the 0.15.2 gate spent 602 of its 878 seconds re-running suite, coverage
// and e2e that CI had already passed as required checks on the same tree, and
// on a loaded laptop those local copies failed for reasons unrelated to the
// change. CI is the single source for them now. The gate asks GitHub for CI's
// results on the exact tree it gates and refuses, naming the check, unless each
// required job passed there.
//
// `gh` is injected, so nothing here reaches the network.

const { test, describe } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { ciVerdict, REQUIRED_CI_CHECKS } = require('../../scripts/release-ci.js');

const TREE = 'a'.repeat(40);
const OTHER_TREE = 'b'.repeat(40);
const HEAD = 'c'.repeat(40);
const BASE = 'd'.repeat(40);

const passingJobs = (names = REQUIRED_CI_CHECKS) =>
  names.map((name) => ({ name, status: 'completed', conclusion: 'success' }));

function run(id, { tree = TREE, event = 'push', head = HEAD, prs = [], jobs = passingJobs() } = {}) {
  return { id, event, head_sha: head, head_commit: { id: head, tree_id: tree }, pull_requests: prs, html_url: `https://example.test/runs/${id}`, jobs };
}

// A fake gh that serves the runs list and each run's jobs from the fixtures.
function fakeGh(runs, { fail } = {}) {
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (fail) throw new Error(fail);
    const url = args.find((a) => a.startsWith('repos/'));
    if (/\/actions\/workflows\/ci\.yml\/runs/.test(url)) {
      return JSON.stringify({ workflow_runs: runs.map(({ jobs, ...r }) => r) });
    }
    const m = /\/actions\/runs\/(\d+)\/jobs/.exec(url);
    if (m) {
      const r = runs.find((x) => String(x.id) === m[1]);
      return JSON.stringify({ jobs: r ? r.jobs : [] });
    }
    throw new Error(`unexpected gh call: ${args.join(' ')}`);
  };
  gh.calls = calls;
  return gh;
}

const anyAncestor = () => true;
const noAncestor = () => false;

describe('the gate reads CI for the exact tree it gates', () => {
  test('every required check green on a push run of this tree passes', () => {
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([run(1)]), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, true, verdict.error);
    for (const name of REQUIRED_CI_CHECKS) assert.ok(verdict.checks[name], `${name} is recorded`);
  });

  test('the required checks include both Test jobs, Coverage floors and E2E', () => {
    for (const name of ['Test (Node 22)', 'Test (Node 24)', 'Coverage floors', 'E2E']) {
      assert.ok(REQUIRED_CI_CHECKS.includes(name), `${name} is required`);
    }
  });

  test('a failed check is refused, by name', () => {
    const jobs = passingJobs().map((j) => (j.name === 'E2E' ? { ...j, conclusion: 'failure' } : j));
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([run(1, { jobs })]), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.error, /"E2E"/);
    assert.doesNotMatch(verdict.error, /"Coverage floors"/, 'only the missing check is named');
  });

  test('a check that is still running is not a pass', () => {
    const jobs = passingJobs().map((j) => (j.name === 'Coverage floors' ? { ...j, status: 'in_progress', conclusion: null } : j));
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([run(1, { jobs })]), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.error, /"Coverage floors"/);
  });

  test('a missing job is refused, by name', () => {
    const jobs = passingJobs(REQUIRED_CI_CHECKS.filter((n) => n !== 'Test (Node 22)'));
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([run(1, { jobs })]), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.error, /"Test \(Node 22\)"/);
  });

  test('green runs on another tree do not count: a one-file difference is a different tree', () => {
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([run(1, { tree: OTHER_TREE })]), isAncestor: anyAncestor });
    assert.strictEqual(verdict.ok, false);
    for (const name of REQUIRED_CI_CHECKS) assert.ok(verdict.error.includes(`"${name}"`), `${name} named`);
    assert.match(verdict.error, /no CI run/i);
  });

  test('a run cancelled overall still counts for the jobs that finished green', () => {
    // CI's mutation job hits its time limit on large changes and the run reads
    // "cancelled". The required jobs inside it still passed, which is what the
    // gate asks about.
    const jobs = [...passingJobs(), { name: 'Mutation guards and fixture provenance', status: 'completed', conclusion: 'cancelled' }];
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([run(1, { jobs })]), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, true, verdict.error);
  });

  test('checks may pass in different runs of the same tree, such as a re-run', () => {
    const first = run(1, { jobs: passingJobs().map((j) => (j.name === 'E2E' ? { ...j, conclusion: 'failure' } : j)) });
    const rerun = run(2, { jobs: passingJobs(['E2E']) });
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([first, rerun]), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, true, verdict.error);
    assert.strictEqual(verdict.checks.E2E.run, 2);
  });

  test('GitHub unreachable is a refusal that says so, never a pass', () => {
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([], { fail: 'gh: not logged in' }), isAncestor: noAncestor });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.error, /not logged in/);
  });
});

describe('a pull request run counts only when it tested this exact tree', () => {
  // A pull request's CI tests the merge of the branch into main, not the
  // branch. That merge has the branch's tree exactly when main is already in
  // the branch, so the run counts only then.
  const prRun = (prs) => run(7, { event: 'pull_request', prs });

  test('the branch contains main: the merge is this tree, and the run counts', () => {
    const verdict = ciVerdict({
      tree: TREE,
      gh: fakeGh([prRun([{ number: 9, base: { sha: BASE }, head: { sha: HEAD } }])]),
      isAncestor: (a, b) => a === BASE && b === HEAD,
    });
    assert.strictEqual(verdict.ok, true, verdict.error);
  });

  test('main has moved past the branch: the run tested a different tree and is refused', () => {
    const verdict = ciVerdict({
      tree: TREE,
      gh: fakeGh([prRun([{ number: 9, base: { sha: BASE }, head: { sha: HEAD } }])]),
      isAncestor: noAncestor,
    });
    assert.strictEqual(verdict.ok, false);
    assert.match(verdict.error, /"E2E"/);
    assert.match(verdict.error, /main/i, 'says why the run did not count');
  });

  test('a pull request run with no base recorded is refused', () => {
    const verdict = ciVerdict({ tree: TREE, gh: fakeGh([prRun([])]), isAncestor: anyAncestor });
    assert.strictEqual(verdict.ok, false);
  });
});

describe('the required check names are the ones CI actually runs', () => {
  // A renamed job would make the gate refuse every release, which is safe but
  // useless. Read the workflow so a rename fails here first.
  test('each required check is a job name in .github/workflows/ci.yml', () => {
    const yml = fs.readFileSync(path.join(__dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');
    const names = [];
    for (const m of yml.matchAll(/^ {4}name: (.+)$/gm)) names.push(m[1].trim());
    const matrix = /node: \[([^\]]+)\]/.exec(yml);
    const nodes = matrix ? matrix[1].split(',').map((s) => s.trim().replace(/'/g, '')) : [];
    const expanded = names.flatMap((n) => (/\$\{\{ matrix\.node \}\}/.test(n) ? nodes.map((v) => n.replace(/\$\{\{ matrix\.node \}\}/, v)) : [n]));
    assert.ok(expanded.length >= 7 && nodes.length >= 2, `sanity: the workflow's job names were read (found ${expanded.length})`);
    for (const name of REQUIRED_CI_CHECKS) assert.ok(expanded.includes(name), `${name} is a CI job (found: ${expanded.join(', ')})`);
  });
});
