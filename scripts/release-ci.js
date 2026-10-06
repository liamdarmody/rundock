'use strict';

/**
 * CI's verdict on one tree, read from GitHub for the release gate.
 *
 * CI is the single source for the suite, coverage and the browser suite: they
 * run there as required checks on a clean machine, on both Node versions. The
 * release gate used to run them all again locally, which took most of its
 * time and failed on a loaded laptop for reasons unrelated to the change. It
 * asks GitHub instead, and refuses unless each required job passed on the
 * EXACT tree being gated.
 *
 * WHAT COUNTS AS THE SAME TREE. A run reports the tree of the commit it was
 * started for (`head_commit.tree_id`). A push or a dispatched run tests that
 * commit, so its tree is the tree tested. A pull request run tests the merge of
 * the branch into main, which has the branch's tree only when main is already
 * in the branch, so a pull request run counts only when its recorded base is
 * an ancestor of its head. Anything that cannot be shown to be the same tree
 * does not count.
 *
 * Checks may pass in different runs of the same tree (a re-run of a failed job
 * is a new attempt on the same tree). A run cancelled overall still counts for
 * the jobs inside it that finished green.
 *
 * `gh` is injected: `(args) => stdout`. Tests pass a fake; the gate passes the
 * gh CLI.
 */

const { execFileSync } = require('node:child_process');

const REPO = 'liamdarmody/rundock';
const WORKFLOW = 'ci.yml';

// The jobs in .github/workflows/ci.yml whose results stand in for the gate's
// old local steps. A unit test reads the workflow so a renamed job fails there.
const REQUIRED_CI_CHECKS = [
  'Test (Node 22)',
  'Test (Node 24)',
  'Coverage floors',
  'E2E',
  'Typecheck (JSDoc + checkJs)',
  'Hygiene (internal references, style drift)',
];

function ghCli(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function ghJson(gh, apiPath) {
  return JSON.parse(String(gh(['api', apiPath])));
}

// Whether a run tested `tree` exactly, or why not.
function exactness(run, tree, isAncestor) {
  if (!run.head_commit || run.head_commit.tree_id !== tree) return { exact: false };
  if (run.event !== 'pull_request') return { exact: true };
  const based = (run.pull_requests || []).some((pr) => pr && pr.base && pr.base.sha && isAncestor(pr.base.sha, run.head_sha));
  return based
    ? { exact: true }
    : { exact: false, why: `run ${run.id} is a pull request run whose branch did not contain main, so it tested a merge with a different tree` };
}

function ciVerdict({ tree, gh = ghCli, isAncestor, repo = REPO, required = REQUIRED_CI_CHECKS } = {}) {
  let runs;
  try {
    runs = ghJson(gh, `repos/${repo}/actions/workflows/${WORKFLOW}/runs?per_page=100`).workflow_runs || [];
  } catch (err) {
    return { ok: false, error: `Could not read CI's results from GitHub: ${err.message}` };
  }

  const notes = [];
  const exact = [];
  for (const run of runs) {
    const { exact: isExact, why } = exactness(run, tree, isAncestor);
    if (isExact) exact.push(run);
    else if (why) notes.push(why);
  }

  const checks = {};
  for (const run of exact) {
    let jobs;
    try {
      jobs = ghJson(gh, `repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`).jobs || [];
    } catch (err) {
      return { ok: false, error: `Could not read the jobs of CI run ${run.id}: ${err.message}` };
    }
    for (const job of jobs) {
      if (!required.includes(job.name) || checks[job.name]) continue;
      if (job.status === 'completed' && job.conclusion === 'success') {
        checks[job.name] = { run: run.id, url: run.html_url };
      }
    }
  }

  const missing = required.filter((name) => !checks[name]);
  if (missing.length) {
    const looked = exact.length
      ? `${exact.length} CI run(s) tested this tree: ${exact.map((r) => r.id).join(', ')}`
      : 'no CI run tested this tree';
    return {
      ok: false,
      checks,
      missing,
      error:
        `CI has not passed ${missing.map((n) => `"${n}"`).join(', ')} on tree ${tree.slice(0, 12)} (${looked}).` +
        (notes.length ? `\n  ${notes.join('\n  ')}` : '') +
        '\n  Push the candidate and let CI finish on it, or re-run the failed job, then run the gate again.',
    };
  }
  return { ok: true, checks };
}

module.exports = { ciVerdict, REQUIRED_CI_CHECKS, REPO };
