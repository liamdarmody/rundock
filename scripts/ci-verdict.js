#!/usr/bin/env node
'use strict';

/**
 * Read a finished CI run that did not succeed, say why each job did not, and
 * re-run it once when the only reason was a runner that went away.
 *
 * WHY. A job whose runner is shut down or loses contact with GitHub ends red,
 * and that red says nothing about the change: the work never finished. Left
 * alone, it blocks a merge until somebody notices, reads the annotation and
 * presses re-run. This does that one press, and only for that cause.
 *
 * Each job that did not succeed is classified from its conclusion and its
 * annotations:
 *
 *   runner-lost   the runner shut down or lost contact, or the mutation check
 *                 reported no verdict because a shard was ended by a signal.
 *                 No verdict; the run is re-run once.
 *   superseded    the concurrency group cancelled it for a newer run. Nothing
 *                 to do: the newer run is the one that counts.
 *   timed-out     the job reached its time cap. No verdict, and no re-run,
 *                 because the same work would reach the same cap.
 *   no-verdict    the mutation check reached no verdict for another reason.
 *   failure       anything else: a real failure, left alone.
 *
 * A run whose attempt is not the first is never re-run, so this cannot loop.
 *
 * SECURITY. This runs from a workflow_run trigger with the base repository's
 * token. It reads the run through the API and asks GitHub to re-run it; it
 * never checks out, installs or executes anything from the pull request.
 *
 *   node scripts/ci-verdict.js --run <id> [--repo owner/name] [--dry-run]
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const RUNNER_LOST = [
  /runner has received a shutdown signal/i,
  /lost communication with the server/i,
];
const SUPERSEDED = /Canceling since a higher priority waiting request/i;
const TIMED_OUT = /has exceeded the maximum execution time/i;
const NO_VERDICT_TITLE = /^No verdict:/;

const OK_CONCLUSIONS = new Set(['success', 'skipped', 'neutral']);

/** One job's classification, from its conclusion and annotations. */
function classifyJob(job, annotations = []) {
  if (OK_CONCLUSIONS.has(job.conclusion)) return { kind: 'ok' };
  const texts = annotations.map((a) => `${a.title || ''}\n${a.message || ''}`);
  if (texts.some((t) => RUNNER_LOST.some((re) => re.test(t)))) {
    return { kind: 'runner-lost', why: 'its runner shut down or lost contact with GitHub' };
  }
  if (texts.some((t) => SUPERSEDED.test(t))) return { kind: 'superseded', why: 'a newer run replaced it' };
  if (texts.some((t) => TIMED_OUT.test(t))) return { kind: 'timed-out', why: 'it reached its time cap' };
  const noVerdict = annotations.find((a) => NO_VERDICT_TITLE.test(a.title || ''));
  if (noVerdict) {
    return /signal/i.test(`${noVerdict.title} ${noVerdict.message || ''}`)
      ? { kind: 'runner-lost', why: `${noVerdict.title} (a shard was ended by a signal)` }
      : { kind: 'no-verdict', why: noVerdict.title };
  }
  if (job.conclusion === 'cancelled') return { kind: 'superseded', why: 'it was cancelled' };
  return { kind: 'failure', why: `it ended ${job.conclusion || 'without a conclusion'}` };
}

/**
 * What to do about a run: { action: 'rerun' | 'none', reason, jobs }.
 *
 * Re-run only on a first attempt, only when no newer run replaced this one,
 * and only when every job that did not succeed is a lost runner or the no
 * verdict a lost runner causes. A real failure anywhere means the run stays
 * red as it is: re-running it would only spend a runner to say so twice.
 */
function decide({ run, jobs, annotationsFor = () => [], newerRun = false }) {
  const classified = jobs.map((job) => ({ name: job.name, ...classifyJob(job, annotationsFor(job)) }));
  const notOk = classified.filter((j) => j.kind !== 'ok');
  const none = (reason) => ({ action: 'none', reason, jobs: classified });
  if (run.conclusion === 'success') return none('the run succeeded');
  if (Number(run.run_attempt) !== 1) return none(`attempt ${run.run_attempt} is never re-run, so a retry cannot loop`);
  if (newerRun || notOk.some((j) => j.kind === 'superseded')) return none('superseded: a newer run is the one that counts');
  const failures = notOk.filter((j) => j.kind === 'failure');
  if (failures.length) return none(`a real failure: ${failures.map((j) => j.name).join(', ')}`);
  const lost = notOk.filter((j) => j.kind === 'runner-lost');
  if (!lost.length) {
    const timed = notOk.filter((j) => j.kind === 'timed-out');
    return none(timed.length
      ? `no verdict: ${timed.map((j) => j.name).join(', ')} reached the time cap, and would again`
      : 'no verdict, and not from a lost runner');
  }
  return { action: 'rerun', reason: `no verdict: ${lost.map((j) => `${j.name} (${j.why})`).join('; ')}`, jobs: classified };
}

// ---------------------------------------------------------------------------

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

function api(path) {
  return JSON.parse(gh(['api', path]));
}

function argValue(argv, flag) {
  const at = argv.indexOf(flag);
  return at === -1 ? null : argv[at + 1];
}

function main(argv = process.argv.slice(2)) {
  const id = argValue(argv, '--run');
  const repo = argValue(argv, '--repo') || process.env.GITHUB_REPOSITORY;
  if (!/^\d+$/.test(String(id)) || !/^[\w.-]+\/[\w.-]+$/.test(String(repo))) {
    console.error('usage: ci-verdict.js --run <numeric id> --repo <owner/name>');
    return 2;
  }
  const run = api(`repos/${repo}/actions/runs/${id}`);
  const jobs = api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100`).jobs || [];
  const annotations = new Map();
  for (const job of jobs) {
    if (OK_CONCLUSIONS.has(job.conclusion)) continue;
    try { annotations.set(job.id, api(`repos/${repo}/check-runs/${job.id}/annotations`)); } catch { annotations.set(job.id, []); }
  }
  let newerRun = false;
  try {
    const branch = encodeURIComponent(run.head_branch || '');
    const later = api(`repos/${repo}/actions/workflows/${run.workflow_id}/runs?branch=${branch}&event=${run.event}&per_page=20`);
    newerRun = (later.workflow_runs || []).some((r) => r.id !== run.id && r.created_at > run.created_at);
  } catch { /* unknown is not newer: the classification still decides */ }

  const verdict = decide({ run, jobs, annotationsFor: (job) => annotations.get(job.id) || [], newerRun });
  const lines = [`CI run ${id}, attempt ${run.run_attempt}: ${verdict.action === 'rerun' ? 're-running the failed jobs once' : 'left as it is'}`,
    `Reason: ${verdict.reason}`];
  for (const j of verdict.jobs.filter((x) => x.kind !== 'ok')) lines.push(`- ${j.name}: ${j.kind} (${j.why})`);
  console.log(lines.join('\n'));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  if (verdict.action === 'rerun' && !argv.includes('--dry-run')) {
    gh(['run', 'rerun', String(id), '--failed', '--repo', repo]);
  }
  return 0;
}

module.exports = { classifyJob, decide };

if (require.main === module) process.exit(main());
