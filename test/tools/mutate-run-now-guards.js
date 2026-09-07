#!/usr/bin/env node
'use strict';
// Break each rule of the run-now change in turn and report which tests notice.
// Every rule here can be deleted with the product still drawing SOMETHING, so
// each is broken on purpose and a test must go red. Same shape as its
// siblings, deliberately a separate copy.
//
//   node test/tools/mutate-run-now-guards.js [--markdown]

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');
const SUITE = 'test/unit/run-now.test.js';
const SCHEDULER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: SUITE };
const DISCOVERY = { src: path.join(ROOT, 'lib', 'agents', 'discovery.js'), suite: SUITE };
const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: SUITE };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: SUITE };
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'runs.js'), suite: SUITE };

const MUTATIONS = [
  // ===== A MANUAL RUN MOVES NO SCHEDULE =====
  [SCHEDULER, 'the state write is withheld from a pressed run at its start',
    "  if (run.trigger !== 'manual') {\n    recordRoutineRun(key, { lastRun: deps.now().toISOString(), status: 'running', duration: null });",
    "  if (true) {\n    recordRoutineRun(key, { lastRun: deps.now().toISOString(), status: 'running', duration: null });"],
  [SCHEDULER, 'the state write is withheld from a pressed run at its end',
    "    if (run.trigger !== 'manual') {\n      recordRoutineRun(key, {",
    "    if (true) {\n      recordRoutineRun(key, {"],
  // ===== THE RECORD SAYS WHO STARTED IT =====
  [SCHEDULER, 'the opening writer stamps the trigger',
    "    trigger: run.trigger,\n    status: 'running',",
    "    status: 'running',"],
  [SCHEDULER, 'the closing writer stamps the trigger',
    "    trigger: run.trigger,\n    // A run somebody stopped is not a run that failed",
    "    // A run somebody stopped is not a run that failed"],
  [SCHEDULER, 'the tick starts its runs as scheduled',
    "executeRoutine(agent, routine, key, now, 'scheduled')",
    "executeRoutine(agent, routine, key, now, 'manual')"],
  [SCHEDULER, 'the event carries the trigger',
    "status: outcome, duration, trigger: run.trigger }",
    "status: outcome, duration }"],
  // ===== A PRESS IS REFUSED FOR EXACTLY THREE THINGS =====
  [SCHEDULER, 'the refusal set does not grow to hold what only holds the tick',
    "  if (inFlight.has(key)) return 'running';\n  return null;",
    "  if (routine.paused) return 'paused';\n  if (inFlight.has(key)) return 'running';\n  return null;"],
  [SCHEDULER, 'the refusal set does not shrink past what cannot produce a run',
    "  if (!hasRunnablePrompt(routine)) return 'prompt';\n  if (inFlight.has(key)) return 'running';",
    "  if (inFlight.has(key)) return 'running';"],
  [HANDLER, 'the handler adds no refusal of its own',
    "  const key = `${agent.id}:${routine.name}`;\n  let answer;",
    "  if (routine.paused) { refuse(`Routine \"${name}\" is paused.`, 'paused'); return; }\n  const key = `${agent.id}:${routine.name}`;\n  let answer;"],
  // ===== THE ROSTER CARRIES THE IN-FLIGHT FACT, AND THE ROW READS IT =====
  [DISCOVERY, 'the roster carries whether a run is in flight',
    "        r.running = going ? { trigger: going.trigger === 'manual' ? 'manual' : 'scheduled', startedAt: going.startedAt } : null;",
    "        r.running = null;"],
  [VIEW, 'the row hands the in-flight fact to the model rather than deriving it',
    "    running: r.running,\n",
    "    running: r.state && r.state.status === 'running' ? { trigger: 'scheduled' } : null,\n"],
  [MODEL, 'Run is disabled exactly while a run is in flight',
    "    return { label: running ? 'Run in progress' : 'Run now', disabled: running };",
    "    return { label: running ? 'Run in progress' : 'Run now', disabled: false };"],
  [MODEL, 'a pressed run in flight says so in its own words',
    "  const RUNNING_WORDS = { scheduled: 'Still going', manual: 'Running now (started manually)' };",
    "  const RUNNING_WORDS = { scheduled: 'Still going', manual: 'Still going' };"],
  // ===== THE TWO PAUSED STATES =====
  [MODEL, 'the paused sentence reads the published refusal word',
    "    const consent = approvalOffer(input);\n    if (consent) return { kind: 'consent'",
    "    const consent = null;\n    if (consent) return { kind: 'consent'"],
  [VIEW, 'the play glyph is bound to Run and not to resume',
    "\">${esc(words.selfAction)}</button>`",
    "\">${iconSvg(ICONS.play)}${esc(words.selfAction)}</button>`"],
  [VIEW, 'a consent-paused row carries the sentence and its one action',
    "  if (row.pausedState && row.pausedState.kind === 'consent' && withActions) {",
    "  if (false) {"],
  [VIEW, 'Run is first in the action group',
    "    if (!row.pausedState) actions += pauseSwitch(index, false);",
    "    if (!row.pausedState) actions = '<div class=\"rr-actions\">' + pauseSwitch(index, false) + actions.slice('<div class=\"rr-actions\">'.length);"],
];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', '--test-reporter', 'spec', suite], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) return failed ? { unparsable: true } : [];
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [SCHEDULER, DISCOVERY, MODEL, VIEW, HANDLER];
  const session = beginMutationRun({ files: targets.map((t) => t.src) });
  const originals = new Map(targets.map((t) => [t, session.original(t.src)]));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches !== 1) { results.push({ label, applied: false, ambiguous: matches > 1 ? matches : 0, red: [] }); continue; }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable ? { label, applied: true, unparsable: true, red: [] } : { label, applied: true, red });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    session.finish();
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous, unparsable } of results) {
    let why = null;
    if (unparsable) why = 'no verdict: the suite failed but its output could not be parsed';
    else if (ambiguous) why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
    else if (!applied) why = 'the guard text was not found, so nothing was mutated';
    else if (red.length === 0) why = 'nothing turned red';
    if (why) {
      failed++;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
  }
  for (const line of lines) console.log(markdown ? line : `\n${line}`);
  return failed;
}
if (require.main === module) {
  const verdict = preflight(os.tmpdir());
  if (!verdict.ok) { console.error(verdict.message); process.exit(2); }
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded.`);
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
