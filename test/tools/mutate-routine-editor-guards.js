#!/usr/bin/env node
'use strict';
// Break each of the routine editor's guards in turn and report which tests
// notice.
//
// WHY THIS EXISTS SEPARATELY FROM THE SUITE
//
// A green suite says the guards and the tests agree today. It does not say the
// tests are testing the guards. That gap is wider than usual here, because
// most of what this editor is judged on is COPY, and a copy assertion is the
// easiest kind of test to write so that it cannot fail: assert a string is
// absent and the test passes against a module that returns nothing at all.
//
// The one that matters most is exactly that shape. The local option must not
// promise that a routine runs while the computer is off, because it does not.
// The mutation below writes the always-on option's words onto the local option
// and requires a test to go red for it. Until that has been run, "the string is
// absent" is a claim about a test nobody has tried to break.
//
// A guard whose mutation turns nothing red is reported as a FAILURE rather than
// passed over. An experiment that changes nothing has not been run.
//
//   node test/tools/mutate-routine-editor-guards.js            # report
//   node test/tools/mutate-routine-editor-guards.js --markdown # the same, as a table
//
// The file is restored afterwards, including when a run throws.
//
// The harness below is the same shape as mutate-render-guards.js and is
// deliberately a second copy rather than a shared module: pulling the two
// together means editing an instrument that is already in the gate, and mixing
// that refactor into a feature is how a gate quietly stops checking what it
// used to. Raised rather than absorbed.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// The two halves of the editor, each with the suite that watches it.
//
// THE VIEW IS MUTATED TOO, and that is not thoroughness for its own sake. The
// model can carry exactly the right words while a view renders different ones,
// and every model test still passes. The copy rule this editor exists to hold
// is a claim about what a person SEES, so the render has to be broken and
// noticed as well.
const MODEL = { src: path.join(ROOT, 'public', 'routine-editor-model.js'), suite: 'test/unit/routine-editor-model.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'routine-editor.js'), suite: 'test/unit/routine-editor-view.test.js' };

// [target, label, the guard as it is written, what it becomes without it]
const MUTATIONS = [
  // THE ONE THIS FILE EXISTS FOR. Copy the always-on option's promise onto the
  // option a user can actually pick. This is the defect in its exact form.
  [MODEL, 'the local option carries its own words, not the always-on option\'s',
    "      meta: 'Runs while Rundock is open here.',",
    "      meta: 'Not set up yet. Keeps your files synced, and keeps this routine running while your computer is off.',"],
  [MODEL, 'selectability is membership of the supported set',
    '      selectable: RUN_ON_SUPPORTED.indexOf(option.value) !== -1,',
    '      selectable: true,'],
  [MODEL, 'the supported set is the one the data model supports',
    "  const RUN_ON_SUPPORTED = ['local'];",
    "  const RUN_ON_SUPPORTED = ['local', 'agent-computer'];"],
  [MODEL, 'the preview sentence reads the run-on words off the option',
    '    return `Every ${freq.label} at ${time.label}, run: ${skillName}, on ${option.sentence}.`;',
    '    return `Every ${freq.label} at ${time.label}, run: ${skillName}, on this computer.`;'],
  [MODEL, 'the confirmation line reads its second sentence off the option',
    '    return words ? `${words} time. ${option.meta}` : option.meta;',
    '    return words ? `${words} time. Runs while Rundock is open here.` : option.meta;'],
  [MODEL, 'both halves of the schedule are looked up, never taken from the input',
    '    if (!freq || !time) return null;\n    return `every ${freq.value} at ${time.value}`;',
    '    return `every ${input.frequency} at ${input.time}`;'],
  [MODEL, 'the picker is scoped to the agent it was opened from',
    '        if (agentId && agent.id !== agentId) continue;\n',
    ''],
  [MODEL, 'a scoped row does not repeat the agent',
    '          agentName: agentId ? null : (agent.name || null),',
    '          agentName: agent.name || null,'],
  [MODEL, 'an unscoped row names the agent that runs it',
    '          agentName: agentId ? null : (agent.name || null),',
    '          agentName: null,'],
  [MODEL, 'a skill with no agent is not offered',
    '      for (const agent of assigned) {',
    '      for (const agent of (assigned.length ? assigned : [{ id: null, name: null }])) {'],
  [MODEL, 'the zero-skills state offers a way to make one',
    '      createSkill: options.length === 0,',
    '      createSkill: false,'],
  [MODEL, 'the reserved target is refused where a routine is made',
    '    if (RUN_ON_SUPPORTED.indexOf(runOn) === -1) return null;\n',
    ''],
  [MODEL, 'the caveat names the machine a routine was made on',
    "  const RUN_ON_CAVEAT = 'Routines run on the machine they were made on. '",
    "  const RUN_ON_CAVEAT = 'Routines run when Rundock is open here. '"],
  [MODEL, 'the caveat names what a workspace on several computers does',
    "    + 'A workspace open on more than one computer runs its routines on each of them.';",
    "    + '';"],
  [MODEL, 'the caveat travels with the field the choice is made in',
    '    return { label: RUN_ON_LABEL, options: runOnOptions(), caveat: RUN_ON_CAVEAT };',
    '    return { label: RUN_ON_LABEL, options: runOnOptions(), caveat: null };'],
  [MODEL, 'save leaves the editor for the list',
    "  const SAVE_DESTINATION = 'routines';",
    "  const SAVE_DESTINATION = 'editor';"],
  [MODEL, 'midnight and noon read as twelve rather than zero',
    '      const hour12 = hour % 12 === 0 ? 12 : hour % 12;',
    '      const hour12 = hour % 12;'],
  [MODEL, 'the lead line names the agent the choice was scoped to',
    "    return STEP_LEADS.pick.replace('{agent}', agentName);",
    '    return STEP_LEADS.pickAny;'],

  // The render. THE DEFECT IN ITS OTHER FORM: a model with the right words and
  // a view that prints the wrong ones.
  [VIEW, 'the run-on row reads its second line off the option',
    '          <div class="re-meta">${escText(option.meta)}</div>',
    '          <div class="re-meta">Keeps this routine running while your computer is off.</div>'],
  [VIEW, 'the run-on row reads its name off the option',
    '          <div class="re-name">${escText(option.name)}</div>',
    '          <div class="re-name">This computer</div>'],
  [VIEW, 'the caveat is rendered inside the field',
    '    h += `<p class="re-caveat" data-routine-editor="caveat">${escText(field.caveat)}</p>`;\n',
    ''],
  [VIEW, 'the reserved option cannot be selected by pressing its row',
    '    if (!option || !option.selectable) return state.runOn;',
    '    if (!option) return state.runOn;'],
  [VIEW, 'the zero-skills state offers something to press',
    '        <button class="settings-btn-primary" type="button" data-routine-editor="create-skill"',
    '        <button class="settings-btn-primary" type="button" data-routine-editor="nothing"'],
  [VIEW, 'the zero-skills state does not ask the reader to pick from nothing',
    '    if (choice.createSkill) {',
    '    if (choice.createSkill && false) {'],
  [VIEW, 'a save that cannot be built does not leave the editor',
    '    if (!draft) return;',
    '    if (!draft) { if (typeof switchNav === \'function\') switchNav(m.SAVE_DESTINATION); return; }'],
  [VIEW, 'a save sends the routine before it leaves',
    "        type: 'save_routine',",
    "        type: 'not_save_routine',"],
  [VIEW, 'a skill name reaches the page as text, not as markup',
    '<div class="re-name">${escText(option.name)}</div>${meta}',
    '<div class="re-name">${option.name}</div>${meta}'],
  [VIEW, 'the time zone reaches the page',
    '    if (zone) h += `<p class="re-caption">${escText(zone)}</p>`;\n',
    ''],
];

// The reporter is named explicitly rather than left to the default, which
// varies with whether stdout is a TTY. This parses the spec reporter's summary,
// so a different reporter would yield no names, every mutation would read as
// "nothing turned red", and a passing run would fail as a row of phantom
// unguarded guards instead of one clear message about the reporter.
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
    // The suite failed and the summary this reads is not in its output. That is
    // a reporting problem, not a result, and reporting it as "no tests noticed"
    // would be a lie in the dangerous direction.
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
  // Both files are read up front and both are restored in the same finally, so
  // a throw part way through cannot leave either one mutated.
  const originals = new Map();
  for (const target of [MODEL, VIEW]) originals.set(target, fs.readFileSync(target.src, 'utf8'));
  const results = [];
  try {
    for (const [target, label, guard, without] of MUTATIONS) {
      const original = originals.get(target);
      if (!original.includes(guard)) {
        results.push({ label, applied: false, red: [] });
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
  for (const { label, applied, red } of results) {
    if (!applied) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **the guard text was not found, so nothing was mutated** | |`
        : `${label}\n  THE GUARD TEXT WAS NOT FOUND, so nothing was mutated`);
      continue;
    }
    if (red.length === 0) {
      failed++;
      lines.push(markdown
        ? `| ${label} | **nothing turned red** | |`
        : `${label}\n  NOTHING TURNED RED`);
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
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded.`);
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
