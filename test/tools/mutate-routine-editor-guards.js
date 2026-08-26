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
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

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
// The model's shape for the schedule step, watched by the file that RENDERS
// that step. Watched from the model's own suite, taking the caveat off the step
// stays green: that suite can still read the constant directly, which is
// exactly the reading this shape exists to stop being sufficient.
const MODEL_STEP = { src: path.join(ROOT, 'public', 'routine-editor-model.js'), suite: 'test/unit/routine-editor-view.test.js' };
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
// The door that starts from a skill rather than from an agent, a list or a
// panel. Watched by the file that PRESSES the doors rather than by the view
// suite, because an entry point is tested by the surface a user touches: aimed
// at the view suite these mutations would report a guard nobody holds, when
// what they would really be reporting is a proof pointed at the wrong place.
//
// The team sidebar target that used to sit here went with the door it watched.
const SKILL_DOOR = { src: path.join(ROOT, 'public', 'views', 'routine-editor.js'), suite: 'test/unit/routine-editor-doors.test.js' };
const SKILLS_PAGE = { src: path.join(ROOT, 'public', 'views', 'skills.js'), suite: 'test/unit/routine-editor-doors.test.js' };
// The data model's write path, where a routine becomes bytes in a file.
const ROUTINES = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: 'test/unit/routine-write.test.js' };
// The same file, watched by the suite that owns the timezone a schedule was
// set in. It is a second entry rather than a second suite on the first because
// each mutation runs exactly one suite, and these guards are watched by that
// one. Both entries read and restore the same file, one mutation at a time.
const ROUTINES_TZ = { src: path.join(ROOT, 'lib', 'agents', 'routines.js'), suite: 'test/unit/routine-timezone.test.js' };

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
    '    return `Run ${skillName} every ${freq.label} at ${time.label}, on ${option.sentence}.`;',
    '    return `Run ${skillName} every ${freq.label} at ${time.label}, on this computer.`;'],
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
  // THE CHECK ASKS FOR THREE THINGS AND EACH IS MUTATED AWAY IN TURN. The rail
  // lights the entry, setNavState reveals the sidebar by name and showView
  // reveals the view by name, so a shell missing any one of them cannot show
  // this section and the save has to notice.
  [VIEW, 'the destination is checked for a view panel, not just a rail entry',
    '      && document.getElementById(`view-${nav}`));',
    '      );'],
  [VIEW, 'the destination is checked for a sidebar panel, not just a view',
    '      && document.getElementById(`sidebar-${nav}`)\n',
    ''],
  [VIEW, 'an unreachable destination falls back to one the shell has',
    "    return navigable(destination) ? destination : 'team';",
    '    return destination;'],
  [VIEW, 'a skill list that has not arrived is not an empty one',
    '    if (state.loading) {',
    '    if (state.loading && false) {'],
  // Every door that can open the editor before the skill list has landed goes
  // through this one asker, so deleting the send takes the ask away from all
  // of them at once. It used to be a line copied into each door, which the
  // harness refused to mutate the moment there was more than one copy: a
  // search text matching two places would break whichever came first and prove
  // nothing about either.
  [VIEW, 'the editor asks for the skill list it is missing',
    "    ws.send(JSON.stringify({ type: 'get_skills' }));\n",
    ''],
  [VIEW, 'the skill list fills in when it arrives',
    '    state.skills = list || [];\n    state.loading = false;',
    '    state.skills = list || [];'],
  [VIEW, 'the breadcrumb returns to the agent it names',
    "    if (agentId && typeof showProfile === 'function') { showProfile(agentId); return; }\n",
    ''],
  // ===== THE DOOR THAT STARTS FROM A SKILL =====
  // THE ONE THAT MATTERS. A skill can belong to more than one agent, and
  // taking the first is a guess wearing the shape of a decision: the reader
  // would only discover which agent they had been given by reading the routine
  // afterwards. This writes the guess in and requires a test to go red for it.
  [SKILL_DOOR, 'an agent is carried only when exactly one has the skill',
    '    const only = assigned.length === 1 ? assigned[0] : null;',
    '    const only = assigned[0] || null;'],
  [SKILL_DOOR, 'a skill with one agent skips the step there is nothing to pick on',
    "      step: only ? 'schedule' : 'pick',",
    "      step: 'pick',"],
  [SKILL_DOOR, 'the breadcrumb belongs to the skill the editor was opened from',
    '    if (state.originSkillId && state.originSkillName) {',
    '    if (false) {'],
  // The dead end. Without the check, leaving by the breadcrumb calls
  // selectSkill for a skill that has gone from the list, which returns doing
  // nothing, and state is already null: the editor stays on screen with every
  // control answering nothing.
  [SKILL_DOOR, 'the skill breadcrumb leaves even when the skill has gone',
    '    if (skillId && canSelectSkill(skillId)) { selectSkill(skillId); return; }',
    "    if (skillId && typeof selectSkill === 'function') { selectSkill(skillId); return; }"],
  // Agent-agnostic, but the reader is not asked to find the skill they
  // pressed a second time.
  [SKILL_DOOR, 'the pressed skill is ordered first in the agent-agnostic picker',
    '      skills: only ? [skill] : (skill ? [skill].concat(list.filter(s => s.id !== skill.id)) : list),',
    '      skills: only ? [skill] : list,'],
  [SKILL_DOOR, 'leaving by that breadcrumb goes back to the skill it names',
    '    if (skillId && canSelectSkill(skillId)) { selectSkill(skillId); return; }\n',
    ''],
  [SKILLS_PAGE, 'a skill page offers a way to schedule the skill',
    ' data-skills-action="schedule-skill"',
    ' data-skills-action="not-a-door"'],
  // The control is offered only where it can lead somewhere. A skill nobody
  // has produces no row in the picker, so the control would be a label
  // promising something the reader cannot reach.
  [SKILLS_PAGE, 'the way in is offered only where an agent has the skill',
    '  if (s.assignedAgents.length) {\n'
    + "    // SAME SHAPE AS THE AGENT PROFILE'S ROUTINES CARD:",
    '  if (true) {\n'
    + "    // SAME SHAPE AS THE AGENT PROFILE'S ROUTINES CARD:"],

  [VIEW, 'the breadcrumb names an agent only when there is one to return to',
    '    } else if (state.agentId && state.agentName) {',
    '    } else if (state.agentName || true) {'],

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
    "  ws.send(JSON.stringify(message));\n  ctx.agents.invalidateAgentCache();\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents(), workspace: getWorkspace() }));",
    "  ws.send(JSON.stringify(message));\n  ws.send(JSON.stringify({ type: 'agents', agents: discoverAgents(), workspace: getWorkspace() }));"],
  [HANDLER, 'a refusal from the data model is reported rather than swallowed',
    "    fail(e && e.message ? e.message : 'That routine could not be written.');\n    return;",
    '    return;'],

  // The door. Every other test of the scoped entry calls the entry function
  // directly, which says nothing about whether anything calls it.
  [PROFILE, 'an agent profile offers a way to schedule its skills',
    '      <button class="settings-btn" type="button" data-profile-action="add-routine"\n'
    + '        data-agent-id="${escA(a.id)}" onclick="addRoutineForAgent(this.dataset.agentId)">Add routine</button>`;',
    '`;'],
  [PROFILE, 'the way in carries the agent whose profile it is on',
    'onclick="addRoutineForAgent(this.dataset.agentId)"',
    'onclick="addRoutineForAgent(\'\')"'],

  // Writing a second routines key produces invalid YAML in somebody's file.
  // Two guards stand between it and them, and each is broken on its own here.
  [ROUTINES, 'a routines key in a form this module cannot address is refused',
    '    if (declaredRoutines > 0) {',
    '    if (false) {'],
  [ROUTINES, 'whether the file already declares routines is asked of the independent counter',
    "  const declaredRoutines = (topLevelKeyCounts(content) || new Map()).get('routines') || 0;",
    '    const declaredRoutines = locateSection(content.split(\'\\n\')) ? 1 : 0;'],

  // The timezone a schedule was set in.
  //
  // THE ONE THESE EXIST FOR is the first: fill an absent zone in from the
  // machine. It is the defect in its exact form, it type-checks, it returns
  // location words, and on the computer a routine was made on it returns the
  // right answer, which is why no test that inherits the runner's zone can
  // see it. The suite pins the process zone and stores a different one, so
  // this mutation has nowhere to hide.
  [ROUTINES_TZ, 'an absent timezone is left absent rather than filled in from the machine',
    '  const timezone = routine.timezone === undefined || routine.timezone === null\n    ? null\n    : String(routine.timezone);',
    '  const timezone = routine.timezone === undefined || routine.timezone === null\n    ? Intl.DateTimeFormat().resolvedOptions().timeZone\n    : String(routine.timezone);'],
  [ROUTINES_TZ, 'absent and blank are read as different answers',
    '  const value = raw.timezone;\n  if (value === undefined || value === null) return null;\n  return unquote(value);',
    "  return readString(raw, 'timezone');"],
  [ROUTINES_TZ, 'the timezone is a field the model reads, not a string carried through',
    '    timezone: readTimezone(raw),\n',
    ''],
  // The check sits on the writer, which is the road an edit takes as well as
  // the road a creation takes. Removing it has to be noticed from both.
  [ROUTINES_TZ, 'a written timezone is checked on the road every write takes',
    '    assertFieldValue(key, formatted);\n',
    ''],
  [ROUTINES_TZ, 'a routine is not created carrying an empty timezone',
    "  if (timezone !== null && unquote(timezone) === '') {",
    '  if (false) {'],
  [ROUTINES_TZ, 'a timezone is location words rather than any text at all',
    'const TIMEZONE_WORDS = /^[A-Za-z][A-Za-z0-9_-]*(?:\\/[A-Za-z0-9_+-]+)+$/;',
    'const TIMEZONE_WORDS = /^[^\\n]*$/;'],
  [ROUTINES_TZ, 'a created routine carries its timezone into the file',
    '    runOn,\n    timezone,\n',
    '    runOn,\n'],
  // The decision, as a thing that can be broken rather than a comment. Adding
  // the field to either list reverses it silently, which is exactly how it
  // would happen.
  [ROUTINES_TZ, 'the timezone stays out of the plan hash',
    "const PLAN_FIELDS = ['prompt', 'skill', 'runOn'];",
    "const PLAN_FIELDS = ['prompt', 'skill', 'runOn', 'timezone'];"],
  [ROUTINES_TZ, 'the migration does not invent a timezone for a routine that never recorded one',
    "const MIGRATED_KEYS = ['runOn', 'enabled', 'paused', 'planHash'];",
    "const MIGRATED_KEYS = ['runOn', 'enabled', 'paused', 'planHash', 'timezone'];"],
  // WHICH WORKSPACE RUNS THE ROUTINE BEING MADE, said on the step every route
  // into this editor passes through. A requirement that a sentence APPEARS on
  // a surface is only proved by taking it away and watching something go red;
  // the constant on its own can be rendered on a help page and nowhere else
  // with the model's tests all green.
  [VIEW, 'the schedule step says which workspace this routine will run in',
    '    h += `<p class="re-caveat" data-routine-editor="workspace-caveat">${escText(m.scheduleStepFields().workspaceCaveat)}</p>`;\n',
    ''],
  [MODEL_STEP, 'the step carries the caveat, so a render of the step cannot drop it',
    '      workspaceCaveat: WORKSPACE_CAVEAT,\n',
    ''],
  [MODEL, 'the caveat names the rule rather than only the consequence',
    "  const WORKSPACE_CAVEAT = 'Rundock runs the routines of the workspace that is open. '",
    "  const WORKSPACE_CAVEAT = 'Routines run on a schedule. '"],
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
  // Every file is read up front and all of them are restored together, so a
  // throw part way through cannot leave one mutated, and neither can a signal.
  const targets = [MODEL, MODEL_STEP, VIEW, APP, HANDLER, PROFILE, SKILL_DOOR,
    SKILLS_PAGE, ROUTINES, ROUTINES_TZ];
  const session = beginMutationRun({ files: targets.map((target) => target.src) });
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
    session.finish();
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

// REFUSE TO START ON A MACHINE THAT WOULD MISREPORT.
//
// This harness runs a suite once per guard, so it is the single
// largest producer of test fixtures on the machine and the tool most likely to
// meet a full disk. When it does, the write failures surface as tests going
// red, and red tests are exactly what this instrument reports as a guard
// nobody was watching. Two runs did precisely that, reporting 293 and 32
// failures that were out of space rather than unguarded. Wrong numbers in the
// direction that looks like work to do are worse than no numbers.
//
// The check sweeps roots whose owning process is gone before it counts, so a
// machine dirtied by earlier runs repairs itself rather than stopping.
function requireSaneTempRoot() {
  const verdict = preflight(os.tmpdir());
  if (verdict.ok) return;
  console.error(verdict.message);
  process.exit(2);
}

if (require.main === module) {
  requireSaneTempRoot();
  // Check and stop. Exists so the test that proves this entry point runs the
  // preflight does not have to let a harness loose to prove it: without it, the
  // only way to observe a MISSING preflight is to watch the harness start
  // mutating and then kill it, which skips the restore below and leaves a
  // source file mutated on every red run. The flag is read after the check, so
  // deleting the check still fails that test rather than passing it.
  if (process.argv.includes('--preflight-only')) process.exit(0);
  const failed = report(run(), process.argv.includes('--markdown'));
  if (failed) {
    console.error(`\n${failed} mutation(s) proved nothing. A guard no test notices is not guarded,`
      + ' and a mutation that could break more than one place proves nothing about either.');
    process.exit(1);
  }
}

module.exports = { MUTATIONS, run };
