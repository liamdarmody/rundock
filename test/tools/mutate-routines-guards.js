#!/usr/bin/env node
'use strict';
// Break each of the routines list's guards in turn and report which tests
// notice.
//
// WHY THIS EXISTS SEPARATELY FROM THE SUITE
//
// A green suite says the guards and the tests agree today. It does not say the
// tests are testing the guards. Most of what this list is judged on is a TONE
// or a piece of COPY, and a copy assertion is the easiest kind of test to
// write so that it cannot fail: assert a string is absent and the test passes
// against a module that returns nothing at all.
//
// THE TWO THIS FILE EXISTS FOR, and they are the two the card warned about
// before a line of it was written.
//
// The first is in the scheduler. `routineState.lastRun` is the only input to
// double-fire suppression; the slot store holds when a routine was due. This
// view is the first consumer the slot store has ever had, and feeding its
// `due` back into the suppression would type-check and would read as a tidy
// simplification. The mutation below writes exactly that line and requires a
// test to go red for it.
//
// The second is the missed row's next-run value. It is CONSTRAINED, not copy:
// a slot missed today is caught up within a minute by an open Rundock, so a
// missed row can only ever pair with a next run today. Two design frames wrote
// "tomorrow" there and both were rejected. The mutation writes the literal in
// and requires a test to go red for it.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather
// than passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-routines-guards.js            # report
//   node test/tools/mutate-routines-guards.js --markdown # the same, as a table
//
// The files are restored afterwards, including when a run throws.
//
// The harness is the same shape as mutate-routine-editor-guards.js and is
// deliberately a second copy rather than a shared module, for the reason
// stated there: pulling them together means editing an instrument already in
// the gate, and mixing that refactor into a feature is how a gate quietly
// stops checking what it used to.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/routines-model.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view.test.js' };
const RAIL = { src: path.join(ROOT, 'public', 'rail-presence.js'), suite: 'test/unit/routines-view.test.js' };
// The scheduler, where the two stores meet and must not.
const SCHEDULER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routines-next-run.test.js' };
// The roster, which is how a row ever sees any of it.
const DISCOVERY = { src: path.join(ROOT, 'lib', 'agents', 'discovery.js'), suite: 'test/unit/routines-next-run.test.js' };
// The handlers behind the row's two controls, and the data model they write
// through.
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/unit/routine-actions.test.js' };
const ROUTINES = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: 'test/unit/routine-actions.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // ===== THE SEPARATION =====
  // THE ONE THIS FILE EXISTS FOR, in its exact form. The slot store's `due` is
  // today's slot; read as the suppression's argument it says "already ran
  // today", and the catch-up run the routine is still owed never happens.
  [SCHEDULER, 'the suppression reads the run state and never the slot store',
    '        const nextRun = getNextRun(routine.schedule, routineState[key]?.lastRun);',
    '        const nextRun = getNextRun(routine.schedule, routineSlots.routines[key]?.due);'],
  [SCHEDULER, 'a period the last run already served is stepped over',
    '  for (let step = 0; served && served >= slot && step < MAX_SLOTS_PER_WAKE; step++) {\n    slot = stepSlots(parsed, slot, 1);\n  }',
    ''],
  [SCHEDULER, 'the anchor is the slot store\'s own due instant',
    '  let slot = new Date(entry.due);\n  if (isNaN(slot.getTime())) return null;',
    '  let slot = stepSlots(parsed, new Date(entry.due), 1);\n  if (isNaN(slot.getTime())) return null;'],
  [SCHEDULER, 'the walk is bounded rather than counting every day since the anchor',
    'step < MAX_SLOTS_PER_WAKE; step++',
    'step < 100000; step++'],
  [SCHEDULER, 'the slot the last run served is named',
    '    lastSlot: lastRun && !isNaN(lastRun.getTime()) ? slotFor(parsed, lastRun).toISOString() : null,',
    '    lastSlot: null,'],
  [SCHEDULER, 'the most recent recorded miss is the one reported',
    '  const missed = entry && entry.missed.length ? entry.missed[entry.missed.length - 1].slot : null;',
    '  const missed = null;'],
  [DISCOVERY, 'the roster carries what a routine row needs',
    '        r.nextRun = facts.nextRun;',
    '        r.nextRun = null;'],

  // ===== THE VALUE THAT IS CONSTRAINED, NOT COPY =====
  // The second one this file exists for: the literal two design frames wrote.
  [MODEL, 'the next-run label renders the instant it is handed, with no value of its own',
    '    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);',
    "    const words = 'tomorrow, 7:00am, London time';"],

  // ===== THE THREE TONES =====
  [MODEL, 'a late run keeps the success colour',
    "    'ok-quiet': { colour: 'var(--success)', weight: 500 },",
    "    'ok-quiet': { colour: 'var(--attention)', weight: 500 },"],
  [MODEL, 'a late run is quieter than a punctual one',
    "    'ok': { colour: 'var(--success)', weight: 600 },",
    "    'ok': { colour: 'var(--success)', weight: 500 },"],
  [MODEL, 'a slot nobody served is idle, not a failure',
    "    'neutral': { colour: 'var(--idle)', weight: 500 },",
    "    'neutral': { colour: 'var(--danger)', weight: 500 },"],
  [MODEL, 'each outcome carries its own leading word',
    "    'caught-up': { tone: 'ok-quiet', lead: 'Caught up' },",
    "    'caught-up': { tone: 'ok-quiet', lead: 'Ran' },"],
  [MODEL, 'a late run is told from a punctual one by more than a moment',
    '  const CATCH_UP_AFTER_MS = 5 * 60 * 1000;',
    '  const CATCH_UP_AFTER_MS = 0;'],
  [MODEL, 'a run still going names no outcome',
    "    if (statusWord === 'running') return null;",
    ''],
  [MODEL, 'a miss later than the last run is what happened last',
    '    if (missedSlot && (!lastRun || missedSlot > lastRun)) return \'missed\';',
    '    if (missedSlot) return \'missed\';'],
  [MODEL, 'a run the process died inside is a failure',
    "    if (statusWord === 'failed' || statusWord === 'interrupted') return 'failed';",
    "    if (statusWord === 'failed') return 'failed';"],

  // ===== THE WORDS =====
  [MODEL, 'a missed row names the cause rather than the routine',
    "      text = `Missed: Rundock was closed at ${place ? `${when}, ${place} time` : when}`;",
    '      text = `Missed: the routine did not run at ${when}`;'],
  [MODEL, 'a caught-up row names the time it was due as well as the time it ran',
    '      text = `Caught up: ran ${timeWords(input.lastRun, now, zone)}, due ${clockWords(input.lastSlot)}`;',
    '      text = `Caught up: ran ${timeWords(input.lastRun, now, zone)}`;'],
  [MODEL, 'a punctual row reads as the time, with no label in front of it',
    '      text = `Ran ${timeWords(input.lastRun, now, zone)}`;',
    '      text = `Ran on time: ${timeWords(input.lastRun, now, zone)}`;'],
  [MODEL, 'a day near now is a word rather than a date',
    "    if (gap === 1) return 'tomorrow';",
    "    if (gap === 1) return DAYS[when.getDay()];"],
  [MODEL, 'a day word counts calendar days, not hours',
    '    const a = new Date(from.getFullYear(), from.getMonth(), from.getDate());\n    const b = new Date(to.getFullYear(), to.getMonth(), to.getDate());\n    return Math.round((b - a) / 86400000);',
    '    return Math.round((to - from) / 86400000);'],
  [MODEL, 'midnight and noon read as twelve rather than zero',
    '    const hour12 = hour % 12 === 0 ? 12 : hour % 12;',
    '    const hour12 = hour % 12;'],
  [MODEL, 'the zone reaches the words as a place',
    '    return place ? `${day}, ${clock}, ${place} time` : `${day}, ${clock}`;',
    '    return `${day}, ${clock}`;'],
  [MODEL, 'a paused routine says so where its next run would be',
    "    if (input && input.paused) return { text: 'Paused', className: 'next-run paused-label' };",
    ''],
  [MODEL, 'both halves of the schedule are looked up, never formatted from the string',
    '    if (!freq || !time) return null;\n    return `Every ${freq.label} at ${time.label}`;',
    '    return `Every ${parts[1]} at ${parts[2]}`;'],
  [MODEL, 'the execution target reads off the option rather than a string built here',
    '      runsOn: option ? `Runs on ${option.sentence}` : null,',
    "      runsOn: 'Runs on this computer',"],
  [MODEL, 'delete names what stops',
    '      ? `This stops ${agentName} running ${name}, ${words.charAt(0).toLowerCase()}${words.slice(1)}. `',
    "      ? 'This stops the routine. '"],
  [MODEL, 'delete names what does NOT stop',
    "      body: `${what}The file it last updated stays exactly as it is. This can't be undone.`,",
    "      body: `${what}This can't be undone.`,"],
  [MODEL, 'the empty state speaks of agents rather than an agent',
    "    body: 'Pick a tested skill and give it a schedule. Your agents take it from there.',",
    "    body: 'Pick a tested skill and give it a schedule. Piper takes it from there.',"],

  // ===== THE RENDER =====
  // The defect in its other form: a model with the right words and a view that
  // prints something else.
  [VIEW, 'the row reads its tone off the model',
    '      + `<span class="run-status ${row.status.tone}">${esc(row.status.text)}</span>`',
    '      + `<span class="run-status ok">${esc(row.status.text)}</span>`'],
  [VIEW, 'the next-run fact survives on a row that also has a status',
    "      + (nextRun ? `${sep}${nextRun}` : '')",
    "      + ''"],
  [VIEW, 'a row with nothing to report keeps its next run on the meta line',
    '  if (!row.status && nextRun) meta += `${sep}${nextRun}`;',
    ''],
  [VIEW, 'the second line appears only once there is something to say',
    '  if (row.status) {',
    '  if (true) {'],
  [VIEW, 'the rail entry is gated on the first routine',
    "  railPresence('routines', list.length > 0);\n",
    ''],
  [VIEW, 'a paused row offers resume rather than pause again',
    "    actions += r.paused\n      ? iconButton('resume', 'Resume', ICONS.play, `routinesSetPaused(${index}, false)`, false)\n      : iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);",
    "    actions += iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);"],
  [VIEW, 'delete asks before it acts',
    'function routinesAskDelete(index) {\n  pendingDelete = index;',
    'function routinesAskDelete(index) {\n  pendingDelete = null;'],
  [VIEW, 'cancelling a delete sends nothing',
    "    ws.send(JSON.stringify({ type: 'delete_routine', agentId: entry.agent.id, name: entry.routine.name }));",
    "    ws.send(JSON.stringify({ type: 'delete_routine', agentId: entry.agent.id, name: 'anything' }));"],
  [VIEW, 'the empty state offers something to press',
    '    + \'<button class="settings-btn-primary" type="button" data-routines-action="add"\'',
    '    + \'<button class="settings-btn-primary" type="button" data-routines-action="nothing"\''],
  [VIEW, 'a routine name reaches the page as text, not as markup',
    '`<div class="rr-sentence">${esc(sentence)}</div>',
    '`<div class="rr-sentence">${sentence}</div>'],
  [RAIL, 'a withdrawn rail entry comes back',
    "    entry.style.display = present ? '' : 'none';",
    "    entry.style.display = 'none';"],

  // ===== THE TWO CONTROLS =====
  [HANDLER, 'a write that changes nothing is not a delete',
    '  if (next === before) { fail(`Routine "${found.name}" is not in that agent.`); return; }\n  fs.writeFileSync(found.filePath, next, \'utf-8\');\n  console.log(`[Routine] Deleted from ${found.target.id}: ${found.name}`);',
    "  fs.writeFileSync(found.filePath, next, 'utf-8');"],
  [HANDLER, 'the roster is invalidated before it is rebroadcast',
    "  ws.send(JSON.stringify(message));\n  ctx.agents.invalidateAgentCache();\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));",
    "  ws.send(JSON.stringify(message));\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));"],
  [HANDLER, 'an agent file outside the workspace is refused',
    "  if (!ctx.workspace.isInsideWorkspace(filePath)) { fail('That agent is outside the workspace.'); return null; }\n",
    ''],
  [ROUTINES, 'the last routine takes the routines key with it',
    '  const from = items.length === 1 ? section.start : target.start;',
    '  const from = target.start;'],
  [ROUTINES, 'a removal takes the block it was asked for and no other',
    '  })[occurrence];\n  if (!target) return content;\n\n  const from',
    '  })[0];\n  if (!target) return content;\n\n  const from'],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY.
const REPORTER = ['--test-reporter=spec', '--test-reporter-destination=stdout'];

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
    throw new Error(
      'the suite failed but its output carries no "failing tests:" summary, so no '
      + 'test names could be read. The spec reporter\'s format is what this parses; '
      + 'if it changed, fix this parser rather than trusting the empty result.');
  }
  const names = [];
  for (const line of out.slice(marker).split('\n')) {
    const m = /^✖ (.+?) \(\d/.exec(line.trim());
    if (m && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

function run() {
  const targets = [MODEL, VIEW, RAIL, SCHEDULER, DISCOVERY, HANDLER, ROUTINES];
  const originals = new Map();
  for (const target of targets) originals.set(target, fs.readFileSync(target.src, 'utf8'));
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
      // FIRST. String.replace takes the first occurrence, so a search text
      // that also appears somewhere else quietly breaks the wrong code and
      // reports on whatever that turns red.
      if (matches > 1) {
        results.push({ label, applied: false, ambiguous: matches, red: [] });
        continue;
      }
      fs.writeFileSync(target.src, original.replace(guard, without));
      results.push({ label, applied: true, red: redTests(target.suite) });
      fs.writeFileSync(target.src, original);
    }
  } finally {
    for (const [target, original] of originals) fs.writeFileSync(target.src, original);
  }
  return results;
}

function report(results, markdown) {
  let failed = 0;
  const lines = [];
  for (const { label, applied, red, ambiguous } of results) {
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

if (require.main === module) {
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
