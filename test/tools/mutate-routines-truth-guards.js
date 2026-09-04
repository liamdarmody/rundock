#!/usr/bin/env node
'use strict';
// Break each of the truth-telling guards in turn and report which tests
// notice.
//
// The five rules this lane leaves behind are all rules about HONESTY: a
// stopped run rendered in its own tone, a cancel honoured before the turn at
// both of its checkpoints, cancelled meaning a stop was DELIVERED, the row's
// offer consuming the scheduler's published refusal, and the ambiguous-skill
// picker keeping the skill the reader pressed. Every one of them can be
// deleted with the product still rendering SOMETHING, which is exactly why a
// green suite proves nothing about them until each is broken on purpose and a
// test goes red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-routines-truth-guards.js            # report
//   node test/tools/mutate-routines-truth-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routines-guards.js and is
// deliberately a separate copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a feature is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

// The list's model, watched by the walks that read the scheduler's own
// declarations against it.
const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/routines-truth.test.js' };
// The scheduler, watched by the suite that drives real runs through it.
const SCHEDULER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/scheduler-lib.test.js' };
// The skill door, watched by the file that PRESSES it in a real DOM, because
// what the picker offers is only observable on the picker.
const DOOR = { src: path.join(ROOT, 'public', 'views', 'routine-editor.js'), suite: 'test/unit/routine-editor-doors.test.js' };
// The editor model's half of the same rule, watched at the model seam.
const EDITOR_MODEL = { src: path.join(ROOT, 'public', 'routine-editor-model.js'), suite: 'test/unit/routines-truth.test.js' };
// The roster enrichment, watched by the walk that runs real discovery over a
// real workspace, because the single-source claim is a claim about what the
// roster actually carries.
const DISCOVERY = { src: path.join(ROOT, 'lib', 'agents', 'discovery.js'), suite: 'test/unit/routines-truth.test.js' };
// The view's pass-through of that field, watched by the rendered-row probe
// that drives a refusal word the model has no private check for.
const VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-truth.test.js' };
// The scheduler again, but watched by the truth walks rather than by the run
// suite: the vocabulary and refusal declarations are read against their own
// writers there.
const SCHEDULER_DECL = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routines-truth.test.js' };

const MUTATIONS = [
  // ===== A STOPPED RUN IS NEVER REPORTED AS A SUCCESS =====
  // Remove the reading and a cancelled run falls through to the time-based
  // evaluation, which is precisely the defect the card describes: a run
  // stopped on time reads "Ran".
  [MODEL, 'a deliberate stop is its own outcome, read before the clock',
    "    if (statusWord === 'cancelled') return 'stopped';",
    ''],
  // Invert the tone and the row celebrates the stop instead. The walk judges
  // the tone the word actually renders with, not the mapping table.
  [MODEL, 'the stopped outcome carries the quiet non-success tone',
    "    'stopped': { tone: 'neutral', lead: 'Stopped' },",
    "    'stopped': { tone: 'ok', lead: 'Stopped' },"],

  // ===== A CANCEL BEFORE THE TURN STARTS PREVENTS THE TURN =====
  // The EARLIER checkpoint, before the thread. Deleting it starts a thread
  // the stop had already forbidden; the wire assertion on thread/start is
  // what has to notice.
  [SCHEDULER, 'a cancel that arrived before the thread never starts one',
    "      // cancelled because the scheduler itself delivered the stop.\n      if (run.cancelRequested || run.cancelled) { run.cancelled = true; return false; }",
    '      // cancelled because the scheduler itself delivered the stop.'],
  // The LATER checkpoint, between the thread and the turn, which is the
  // moment a run gains write access. Deleting it starts the turn anyway; the
  // between-checkpoints test is what has to notice.
  [SCHEDULER, 'a cancel that landed while the thread was starting still prevents the turn',
    "      // stop to arrive, and a turn is the thing that can write.\n      if (run.cancelRequested || run.cancelled) { run.cancelled = true; return false; }",
    '      // stop to arrive, and a turn is the thing that can write.'],

  // ===== CANCELLED MEANS A STOP WAS DELIVERED =====
  // Remove the set beside stopSent and a run somebody stopped ends as
  // whatever its exit code says, which records a delivered stop as a success
  // or a failure that never happened that way.
  [SCHEDULER, 'a delivered stop is what records a run as cancelled',
    "    run.cancelled = true;\n    if (asked && typeof asked.catch === 'function') {",
    "    if (asked && typeof asked.catch === 'function') {"],

  // ===== THE ROW'S PROMISE AND THE SCHEDULER'S REFUSALS ARE ONE LIST =====
  // Shrink the understood list and the divergence walk must fail naming the
  // word, because a refusal the row never learned is an offer that promises a
  // run the tick refuses.
  [MODEL, 'the refusal list a divergence check reads is the whole list',
    "  const REFUSALS_UNDERSTOOD = ['paused', 'enabled', 'runOn', 'prompt', 'approval'];",
    "  const REFUSALS_UNDERSTOOD = ['paused', 'enabled', 'runOn', 'prompt'];"],
  // Remove the consumption and the offer stops reading the tick's published
  // answer at all, falling back to its own copy of the reasons, which is the
  // drift this card exists to make impossible.
  [MODEL, 'the offer consumes the published refusal, fail-safe on unknown words',
    "    if (input.refusal !== undefined) {\n      if (input.refusal !== null && input.refusal !== 'enabled') return true;\n    } else if (input.paused) return true;",
    '    if (input.paused) return true;'],

  // ===== SCHEDULING AN AMBIGUOUS SKILL KEEPS THE SKILL =====
  // Put the old shape back: the full list with the pressed skill merely
  // first, which re-asks a question the reader answered by pressing the
  // control. The door test's row enumeration is what has to notice.
  [DOOR, 'the ambiguous door is scoped to the pressed skill',
    '      skills: (skill && assigned.length) ? [skill] : list,',
    "      skills: skill ? [skill].concat(list.filter(s => s.id !== skill.id)) : list,"],
  // Remove the scoped lead and the picker asks the reader to pick a skill
  // while offering only agents, which is the small lie the lead exists not to
  // tell.
  [EDITOR_MODEL, 'the scoped picker\'s lead asks only which agent',
    "    if (skills.length === 1 && assignedAgentsOf(skills[0]).length > 1) {\n      return STEP_LEADS.pickAgent.replace('{skill}', skills[0].name || skills[0].id);\n    }",
    ''],

  // ===== THE PUBLISHED REFUSAL REACHES THE ROW ON THE LIVE PATH =====
  // Report the switch first again and every switched-off routine publishes
  // 'enabled', the one word the offer ignores, whatever else is wrong with
  // it: the shadowing this ordering exists to remove.
  [SCHEDULER_DECL, 'the switch is reported last, so it never shadows the real fault',
    "  if (routine.paused) return 'paused';\n  if (!isRunOnSupported(routine.runOn)) return 'runOn';\n  if (!hasRunnablePrompt(routine)) return 'prompt';",
    "  if (routine.paused) return 'paused';\n  if (!routine.enabled) return 'enabled';\n  if (!isRunOnSupported(routine.runOn)) return 'runOn';\n  if (!hasRunnablePrompt(routine)) return 'prompt';"],
  // Delete the enrichment and the roster stops carrying the tick's answer;
  // the model's fallback quietly absorbs the loss everywhere except the walk
  // that runs real discovery and reads the field itself.
  [DISCOVERY, 'the roster carries the tick\'s own refusal',
    '        r.refusal = routineRefusal(r);\n',
    ''],
  // Delete the pass-through and the model reverts to its private copy of the
  // reasons; only the rendered-row probe with a word that copy has never
  // heard can tell the difference.
  [VIEW, 'the view hands the published refusal to the model',
    '    refusal: r.refusal,\n',
    ''],

  // ===== THE DECLARED VOCABULARY IS THE WRITTEN ONE =====
  // Change a writer's word without teaching the declaration and the walk
  // that reads the writers' own source must fail naming it.
  [SCHEDULER_DECL, 'a writer cannot gain a status word the declaration does not carry',
    "        status: 'interrupted',",
    "        status: 'stalled',"],

  // ===== A REFUSED STOP CLEARS THE CANCELLED FLAG =====
  // Delete the clearing and a codex run whose interrupt was refused ends
  // recorded as cancelled: a stop the user was wrongly told worked.
  [SCHEDULER, 'a stop that comes back refused is not recorded as delivered',
    '        run.cancelled = false;\n',
    ''],
];

const REPORTER = ['--test-reporter', 'spec'];

function redTests(suite) {
  let out = '';
  let failed = false;
  try {
    out = execFileSync('node', ['--test', ...REPORTER, suite],
      { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    failed = true;
    out = (e.stdout || '') + (e.stderr || '');
  }
  const marker = out.indexOf('failing tests:');
  if (marker === -1) {
    if (!failed) return [];
    // A suite that failed with output this could not read has produced no
    // verdict: not red, not green, nothing. Refused as a named row rather
    // than thrown, so the report says which mutation was in flight instead
    // of a stack trace that names nothing. The spec reporter's format is
    // what this parses; if it changed, fix the parser rather than trusting
    // an empty result.
    return { unparsable: true };
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [MODEL, SCHEDULER, DOOR, EDITOR_MODEL, DISCOVERY, VIEW, SCHEDULER_DECL];
  // Two targets share lib/scheduler.js (watched by different suites), so the
  // session is opened on the deduplicated file list.
  const session = beginMutationRun({ files: [...new Set(targets.map((target) => target.src))] });
  const originals = new Map();
  for (const target of targets) originals.set(target, session.original(target.src));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      const matches = original.split(guard).length - 1;
      if (matches === 0) {
        results.push({ label, applied: false, red: [] });
        continue;
      }
      // A GUARD THAT MATCHES MORE THAN ONCE IS REFUSED RATHER THAN TAKING THE
      // FIRST: String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      const red = redTests(target.suite);
      results.push(red && red.unparsable
        ? { label, applied: true, unparsable: true, red: [] }
        : { label, applied: true, red });
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
    if (unparsable) {
      failed++;
      const why = 'no verdict: the suite failed but its output could not be parsed, so nothing '
        + 'about this mutation is known; fix the reporter parsing rather than trusting a rerun';
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  ${why.toUpperCase()}`);
      continue;
    }
    if (ambiguous) {
      failed++;
      const why = `the guard text matches ${ambiguous} places, so it would break whichever came first`;
      lines.push(markdown ? `| ${label} | **${why}** | |` : `${label}\n  AMBIGUOUS: ${why}`);
      continue;
    }
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown ? `| ${label} | **nothing turned red** | |` : `${label}\n  NOTHING TURNED RED`);
      continue;
    }
    lines.push(markdown
      ? `| ${label} | ${red.length} | ${red.map((n) => `\`${n}\``).join('<br>')} |`
      : `${label}\n  ${red.length} red\n${red.map((n) => `    - ${n}`).join('\n')}`);
  }
  if (markdown) {
    console.log('| Guard broken | Tests red | Which |');
    console.log('|---|---|---|');
    for (const line of lines) console.log(line);
  } else {
    for (const line of lines) console.log(`\n${line}`);
  }
  return failed;
}

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT. See
// mutate-routines-guards.js for the two runs that taught this: a full temp
// root surfaces as tests going red, and red tests are exactly what this
// instrument reports as a guard nobody was watching.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
