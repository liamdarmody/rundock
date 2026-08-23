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
// The client's message dispatch. It is not a module the suite can load, so its
// case bodies are cut out and run; mutating it here is what proves those tests
// are watching the dispatch rather than the stubs they run it against. Wiring
// reachable only by loading the whole shell is exactly the wiring that gets
// deleted by accident.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routine-editor-view.test.js' };
// The handler that writes the routine.
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/unit/routine-write.test.js' };
// The agent profile, which renders the only way into the scoped editor.
const PROFILE = { src: path.join(ROOT, 'public', 'views', 'profile.js'), suite: 'test/unit/routine-editor-view.test.js' };

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
  [VIEW, 'a save asks for the routine it built',
    "      type: 'save_routine',",
    "      type: 'not_save_routine',"],
  [VIEW, 'a skill name reaches the page as text, not as markup',
    '<div class="re-name">${escText(option.name)}</div>${meta}',
    '<div class="re-name">${option.name}</div>${meta}'],
  [VIEW, 'the time zone reaches the page',
    '    if (zone) h += `<p class="re-caption">${escText(zone)}</p>`;\n',
    ''],

  // The reply path. A save that leaves before the server answers puts the
  // reader on a list without the routine and with nothing said, which is the
  // worst outcome this flow has.
  [VIEW, 'sending is not saving',
    '    state.saving = true;\n    state.error = null;\n    renderRoutineEditor();',
    '    state.saving = true;\n    if (typeof switchNav === \'function\') switchNav(routinesListNav());'],
  [VIEW, 'a refusal is shown where the reader is looking',
    '      ? `<p class="re-problem" data-routine-editor="error">${escText(state.error)}</p>`',
    "      ? ''"],
  [VIEW, 'a refused save does not leave the editor',
    '    state.saving = false;\n    state.error = message',
    '    state.saving = false;\n    if (typeof switchNav === \'function\') switchNav(routinesListNav());\n    state.error = message'],
  [VIEW, 'a save in flight is not sent twice',
    '    if (!state || state.saving) return;',
    '    if (!state) return;'],
  [VIEW, 'the destination is checked for a sidebar panel, not just a rail entry',
    '    return !!(document.querySelector(`[data-nav="${nav}"]`) && document.getElementById(`sidebar-${nav}`));',
    '    return !!document.querySelector(`[data-nav="${nav}"]`);'],
  [VIEW, 'an unreachable destination falls back to one the shell has',
    "    return navigable(destination) ? destination : 'team';",
    '    return destination;'],
  [VIEW, 'a skill list that has not arrived is not an empty one',
    '    if (state.loading) {',
    '    if (state.loading && false) {'],
  [VIEW, 'the editor asks for the skill list it is missing',
    "    if (!loaded && typeof ws !== 'undefined' && ws) ws.send(JSON.stringify({ type: 'get_skills' }));\n",
    ''],
  [VIEW, 'the skill list fills in when it arrives',
    '    state.skills = list || [];\n    state.loading = false;',
    '    state.skills = list || [];'],
  [VIEW, 'the breadcrumb returns to the agent it names',
    "    if (agentId && typeof showProfile === 'function') { showProfile(agentId); return; }\n",
    ''],
  [VIEW, 'the breadcrumb names an agent only when there is one to return to',
    '    if (state.agentId && state.agentName) {',
    '    if (state.agentName || true) {'],

  // The dispatch. Each of these deletes one call the client makes into the
  // editor, which is the accident these tests exist to catch.
  [APP, 'the client tells the editor its skill list arrived',
    'routineEditorSkillsArrived(d.skills); ',
    ''],
  [APP, 'the client releases the editor when the routine is written',
    '      routineEditorSaved();\n',
    ''],
  [APP, 'the client hands a refusal back to the editor',
    '      routineEditorFailed(d.message);\n',
    ''],
  [APP, 'the client shows the refusal the server sent',
    "      addSystemMsg(d.message || 'Routine could not be saved');",
    "      addSystemMsg('');"],

  // The write path. The first of these is why the broadcast test asserts what
  // the message CARRIES: without the invalidation the roster goes out warm and
  // the routine just written is not in it, which a test looking only at the
  // message type cannot tell from success.
  // The call text alone appears in four handlers and String.replace takes the
  // first, so this mutation silently broke a different one and nothing turned
  // red. It carries its neighbour now, which makes it unique to this handler.
  [HANDLER, 'the roster is invalidated before it is rebroadcast',
    "  ctx.agents.invalidateAgentCache();\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));",
    "  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents() }));"],
  [HANDLER, 'a refusal from the data model is reported rather than swallowed',
    "    fail(e && e.message ? e.message : 'That routine could not be written.');\n    return;",
    '    return;'],

  // The door. Every other test of the scoped entry calls the entry function
  // directly, which says nothing about whether anything calls it.
  [PROFILE, 'an agent profile offers a way to schedule its skills',
    '      <button class="settings-btn-primary" type="button" data-profile-action="add-routine"\n'
    + '        data-agent-id="${esc(a.id)}" onclick="addRoutineForAgent(\'${esc(a.id)}\')">Add routine</button>\n',
    ''],
  [PROFILE, 'the way in carries the agent whose profile it is on',
    'onclick="addRoutineForAgent(\'${esc(a.id)}\')"',
    'onclick="addRoutineForAgent(\'\')"'],
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
  for (const target of [MODEL, VIEW, APP, HANDLER, PROFILE]) originals.set(target, fs.readFileSync(target.src, 'utf8'));
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
      // FIRST.
      //
      // String.replace takes the first occurrence, so a search text that also
      // appears somewhere else quietly breaks the wrong code and reports on
      // whatever that turns red. One entry here did exactly that: the text
      // appeared six times in its file, the mutation broke a different
      // handler, and the row read as a proven guard while the guard it names
      // was never touched.
      //
      // The table's authority rests on each mutation breaking the thing it
      // says it breaks, and nothing was checking that. This is the check: make
      // the search text unique, usually by including a neighbouring line.
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
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
