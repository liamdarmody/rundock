'use strict';
// The release walk's step engine. Pure: no server, no browser, no disk of
// its own. `runWalk` takes a step list and the context the steps drive, and
// answers one verdict per step under three rules the focused unit test
// holds it to:
//
//   1. A step whose precondition is not met records FAIL naming the step and
//      the missing precondition, and every later step that depends on it
//      records FAIL for that reason. A precondition is anything a step names
//      in `needs` (an earlier step) or answers from `precondition(ctx)` (a
//      reason string when unmet, null when met).
//   2. No path marks a step PASS without its assertion having run. A step's
//      body receives `check(condition, what)`; a body that returns without
//      calling it is a FAIL, because a step that asserted nothing proved
//      nothing.
//   3. A step that throws, before or after asserting, is a FAIL carrying the
//      message, and its dependents fail for that reason.
//
// Every step ends with a screenshot through the caller's hook, PASS or FAIL,
// so the report can show what the page looked like at the moment the verdict
// was taken. A screenshot that cannot be taken is noted on the result and
// does not change the verdict.

class WalkAssertion extends Error {}

// `root` is the first reason in a chain of dependents, so a step five deep
// still names the one thing that actually went wrong.
function failure(step, reason, root = reason) {
  return { id: step.id, name: step.name, verdict: 'FAIL', reason, root };
}

async function runStep(step, ctx, done) {
  for (const need of step.needs || []) {
    const prior = done.get(need);
    if (!prior) return failure(step, `precondition: step ${need} did not run before it`);
    if (prior.verdict !== 'PASS') return failure(step, `precondition: step ${need} failed (${prior.root})`, prior.root);
  }
  let asserted = 0;
  const check = (condition, what) => {
    asserted += 1;
    if (!condition) throw new WalkAssertion(what);
  };
  try {
    if (typeof step.precondition === 'function') {
      const unmet = await step.precondition(ctx);
      if (unmet) return failure(step, `precondition: ${unmet}`);
    }
    await step.run(ctx, check);
  } catch (e) {
    const message = e instanceof WalkAssertion ? `assertion failed: ${e.message}` : `threw: ${e && e.message ? e.message : String(e)}`;
    return failure(step, message);
  }
  if (asserted === 0) return failure(step, 'no assertion ran');
  return { id: step.id, name: step.name, verdict: 'PASS', reason: null };
}

async function runWalk(steps, ctx, { screenshot, log = () => {} } = {}) {
  const done = new Map();
  const results = [];
  let index = 0;
  for (const step of steps) {
    index += 1;
    const result = await runStep(step, ctx, done);
    result.screenshot = null;
    if (typeof screenshot === 'function') {
      try {
        result.screenshot = await screenshot(`${String(index).padStart(2, '0')}-${step.id}`);
      } catch (e) {
        result.screenshotError = e && e.message ? e.message : String(e);
      }
    }
    done.set(step.id, result);
    results.push(result);
    log(`${result.verdict}  ${step.id}  ${step.name}${result.reason ? `  (${result.reason})` : ''}`);
  }
  const failed = results.filter((r) => r.verdict !== 'PASS');
  return { ok: failed.length === 0, exitCode: failed.length ? 1 : 0, results, failed };
}

// The report file is the artifact the release runbook says to attach: the
// server commit, the tags the walk installed, and every step's verdict with
// its screenshot path and, on failure, its reason. Written as JSON beside a
// Markdown rendering of the same facts, so the pull request can carry the
// readable one and a tool can read the other.
function buildReport({ serverCommit, dirty, tags, startedAt, finishedAt, results }) {
  return {
    serverCommit, dirty: !!dirty, tags, startedAt, finishedAt,
    ok: results.every((r) => r.verdict === 'PASS'),
    steps: results.map((r) => ({
      id: r.id, name: r.name, verdict: r.verdict, screenshot: r.screenshot, reason: r.reason,
    })),
  };
}

function renderReport(report) {
  const lines = [
    '# Release walk report', '',
    `- Server commit: ${report.serverCommit}${report.dirty ? ' (working tree dirty)' : ''}`,
    `- Installed: ${Object.entries(report.tags).map(([repo, tag]) => `${repo} at ${tag}`).join(', ')}`,
    `- Started: ${report.startedAt}`, `- Finished: ${report.finishedAt}`,
    `- Result: ${report.ok ? 'PASS' : 'FAIL'}`, '',
    '| Step | Verdict | Screenshot | Reason |', '| --- | --- | --- | --- |',
  ];
  for (const s of report.steps) {
    lines.push(`| ${s.id} ${s.name} | ${s.verdict} | ${s.screenshot || ''} | ${s.reason || ''} |`);
  }
  return lines.join('\n') + '\n';
}

function writeReport(fs, dir, report) {
  fs.mkdirSync(dir, { recursive: true });
  const json = `${dir}/report.json`;
  fs.writeFileSync(json, JSON.stringify(report, null, 2) + '\n');
  fs.writeFileSync(`${dir}/report.md`, renderReport(report));
  return json;
}

module.exports = { runWalk, buildReport, renderReport, writeReport };
