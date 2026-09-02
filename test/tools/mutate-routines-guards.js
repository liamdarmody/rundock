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
const os = require('node:os');
const { preflight } = require('../helpers/temp-root.js');
const { beginMutationRun } = require('./mutation-run.js');

const ROOT = path.join(__dirname, '..', '..');

const MODEL = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/routines-model.test.js' };
const VIEW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view.test.js' };
// THE STYLESHEET IS A MUTATION TARGET, and that is the point of it being one.
// The three-tone ruling is about what a reader SEES, and what they see is
// resolved from these rules, not from any table in a module. An earlier
// version of this card asserted the ruling against a constant in the model
// that nothing rendered, so giving Missed the danger colour moved the page and
// moved no test. These break the rules a browser actually applies.
const STYLES = { src: path.join(ROOT, 'public', 'styles', 'views', 'routines.css'), suite: 'test/unit/routines-view.test.js' };
// The scheduler, where the two stores meet and must not.
const SCHEDULER = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routines-next-run.test.js' };
// The roster, which is how a row ever sees any of it, watched by the walk that
// goes from real agent files through the real stores to the rendered page.
// Watched from anywhere else, these lines can be deleted with every test green
// while Missed and Caught up become unreachable in the product.
const DISCOVERY = { src: path.join(ROOT, 'lib', 'agents', 'discovery.js'), suite: 'test/unit/routines-end-to-end.test.js' };
// The same walk watches the instant the row measures lateness from, because
// that is a claim about what a real routine's real state renders as.
const END_TO_END = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routines-end-to-end.test.js' };
const VIEW_E2E = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-end-to-end.test.js' };
// The shell: who draws this list and how a reader arrives at it. Watched by
// the enumeration, because renderRoutines was once reached only through the
// roster case and deleting that call left every test green while the rail
// entry never appeared and the list never refreshed.
const APP = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-view-doors.test.js' };
// The view's half of the reply path, watched by the file that enumerates the
// replies and drives the dispatch cases that carry them.
const VIEW_REPLY = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view-doors.test.js' };
const INDEX = { src: path.join(ROOT, 'public', 'index.html'), suite: 'test/unit/routines-view-doors.test.js' };
// The routines sidebar panel: where it sits in the page, what it draws, and
// the scope it hands to the list and to the plus. Watched by the file that
// presses the panel against the real markup, because every rule here is a rule
// about a surface and a rule about a surface asserted anywhere else can be
// deleted with the surface broken and the suite green.
const PANEL = { src: path.join(ROOT, 'public', 'views', 'routines-panel.js'), suite: 'test/unit/routines-panel.test.js' };
const SCOPE_MODEL = { src: path.join(ROOT, 'public', 'routines-scope-model.js'), suite: 'test/unit/routines-panel.test.js' };
// THE RENAME IS WATCHED WHERE A SAVE IS DRIVEN, not where an element is
// looked up. routines-panel.test.js goes red on this rename too, but it goes
// red on a getElementById check, and an element existing is a proxy for a save
// landing. AC-10 is about a reader who writes a routine and is put somewhere
// else with nothing thrown, so the suite that presses that walk is the one
// that has to notice.
const INDEX_PANEL = { src: path.join(ROOT, 'public', 'index.html'), suite: 'test/unit/routines-view-doors.test.js' };
// The editor's half of the same trap: the resolution, and the silent answer it
// gives when the shell cannot reach the section.
const EDITOR_NAV = { src: path.join(ROOT, 'public', 'views', 'routine-editor.js'), suite: 'test/unit/routines-view-doors.test.js' };
const APP_PANEL = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-panel.test.js' };
const STYLES_PANEL = { src: path.join(ROOT, 'public', 'styles', 'components', 'sidebar.css'), suite: 'test/unit/routines-panel.test.js' };
// The panel's two effects on the surface BESIDE it, watched by the file that
// enumerates everything that draws this list rather than by the file that
// presses the panel. A scope pressed and no list redrawn is a defect on the
// list, so the list's own manifest is where it has to be noticed.
const PANEL_PRESS = { src: path.join(ROOT, 'public', 'views', 'routines-panel.js'), suite: 'test/unit/routines-view-doors.test.js' };
// The pending confirmation, watched by the file that drives a scope change
// against an open one. Watched from the list's own suite these are green: that
// suite has one agent and no panel, so the list it addresses never changes
// under the confirmation, which is the entire condition the defect needs.
const VIEW_CONFIRM = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view-doors.test.js' };
const APP_WORKSPACE = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-view-doors.test.js' };
const APP_DISPATCH = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-view-doors.test.js' };
// The Skills pane, which the permanent rail makes reachable and which had no
// empty state at all until this pass. Its copy and its two guards are watched
// by the file that presses the pane.
const SKILLS_MODEL = { src: path.join(ROOT, 'public', 'skills-model.js'), suite: 'test/unit/skills-empty.test.js' };
// THE RAIL'S PERMANENCE IS AN ABSENCE, so its mutations put the withdrawal
// BACK rather than take a guard away. A rule whose whole content is "nothing
// does this" is otherwise unmutatable, and an unmutatable rule is one the next
// person reinstates without anything going red.
const INDEX_RAIL = { src: path.join(ROOT, 'public', 'index.html'), suite: 'test/unit/routines-view.test.js' };
const VIEW_RAIL = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view.test.js' };
const SKILLS_VIEW_RAIL = { src: path.join(ROOT, 'public', 'views', 'skills.js'), suite: 'test/unit/routines-view.test.js' };
const SKILLS_VIEW = { src: path.join(ROOT, 'public', 'views', 'skills.js'), suite: 'test/unit/skills-empty.test.js' };
// The chrome's own stylesheet, where the failure dot's colour actually lives.
// The three-tone ruling is about what a reader SEES, and a dot proven against
// a token name in a module is the mistake this project already made once.
const SIDEBAR_CSS = { src: path.join(ROOT, 'public', 'styles', 'components', 'sidebar.css'), suite: 'test/unit/routines-view.test.js' };
// The dispatch call that settles which routines empty state is shown, watched
// by the enumeration of everything that draws this list.
const APP_SKILLS = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-view-doors.test.js' };
// The two openers, watched by the file that presses them rather than by the
// file that calls what they draw.
const APP_OPENER = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-view.test.js' };
// The team panel, watched by the file that presses it. The rule this card
// leaves behind is "the panel carries the roster and nothing else", which is a
// rule about absence, so these mutations PUT SOMETHING BACK rather than take a
// guard away: an absence nobody can break is an absence nobody is checking.
const TEAM_PANEL = { src: path.join(ROOT, 'public', 'views', 'team.js'), suite: 'test/unit/team-sidebar.test.js' };
const INDEX_SWEEP = { src: path.join(ROOT, 'public', 'index.html'), suite: 'test/unit/team-sidebar.test.js' };
// The sentences that name the guide, and the two views that show them. They
// sit beside the skills empty-state guards above rather than in an instrument
// of their own, because they are the same class of rule and fail the same way:
// copy that names an agent through a slot, on surfaces whose default workspace
// happens to make a hard-coded name correct, which is precisely the fault a
// green suite cannot see.
const GUIDE_COPY_MOD = { src: path.join(ROOT, 'public', 'guide-copy.js'), suite: 'test/unit/guide-name.test.js' };
const TEAM_COPY = { src: path.join(ROOT, 'public', 'views', 'team.js'), suite: 'test/unit/guide-name.test.js' };
const PROFILE_COPY = { src: path.join(ROOT, 'public', 'views', 'profile.js'), suite: 'test/unit/guide-name.test.js' };
// The agent profile's three boxes. Two targets on one file, because a guard is
// only proved by the suite that presses it: what the box SAYS is pressed by the
// profile's own file, and where a row GOES is pressed by the routes
// enumeration. Pointing either at the other's suite would be a mutation that
// cannot turn red wearing the shape of one that can.
const PROFILE_BOXES = { src: path.join(ROOT, 'public', 'views', 'profile.js'), suite: 'test/unit/profile-boxes.test.js' };
const PROFILE_ROUTE = { src: path.join(ROOT, 'public', 'views', 'profile.js'), suite: 'test/unit/routines-view-doors.test.js' };
// The team sidebar as a DOOR rather than as a panel, watched by the file that
// enumerates every way into the editor.
const TEAM_DOOR = { src: path.join(ROOT, 'public', 'views', 'team.js'), suite: 'test/unit/routine-editor-doors.test.js' };
// The scope, on both sides of it: the filter that applies one and the arm that
// clears it. Both are watched by the file that presses the two routes.
const VIEW_SCOPE = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view-doors.test.js' };
// The handlers behind the row's two controls, and the data model they write
// through.
const HANDLER = { src: path.join(ROOT, 'lib', 'protocol', 'handlers', 'team.js'), suite: 'test/unit/routine-actions.test.js' };
// The way into the editor from a routine row. It lives in the editor's file and
// is watched by the file that PRESSES it, because an entry point is tested by
// the surface a user touches: aimed at the list's own suite these mutations
// would report a guard nobody holds.
const EDIT_DOOR = { src: path.join(ROOT, 'public', 'views', 'routine-editor.js'), suite: 'test/unit/routine-editor-doors.test.js' };
// The ROW's half of that door, watched by the same file for the same reason:
// what the row hands over is only observable by pressing it and reading what
// the editor then sends.
const EDIT_DOOR_ROW = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routine-editor-doors.test.js' };
// The double-fire guard itself, watched by the file that drives a schedule edit
// past it. The edit path is forbidden from touching run state, so what those
// tests establish is what the EXISTING guard does across an edit; mutating it
// here is what proves they are watching the guard rather than restating it.
const SCHEDULER_EDIT = { src: path.join(ROOT, 'lib', 'scheduler.js'), suite: 'test/unit/routine-edit-duplicate-run.test.js' };
// WHERE A ROUTINE RUNS, WATCHED AT THE RENDERED SURFACE AND NOWHERE ELSE.
//
// The rule is that a routine in a workspace this window does not have open is
// not drawn as one that will run. That is a PROHIBITION, and reverting the
// source it lives in cannot prove one: the test goes red because the code
// vanished, not because the rule held. A mutation is the only thing that can,
// because it commits the forbidden act with everything else in place.
//
// Watched by the walk that goes from two real workspaces through real
// discovery to the real view, because each of these rules is a rule about what
// a reader sees. Proven against the model alone, the roster line that carries
// the workspace could be deleted with every model test green and the rule
// unreachable in the product.
const MODEL_WORKSPACE = { src: path.join(ROOT, 'public', 'routines-model.js'), suite: 'test/unit/routines-end-to-end.test.js' };
const VIEW_WORKSPACE = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-end-to-end.test.js' };
const DISCOVERY_WORKSPACE = { src: path.join(ROOT, 'lib', 'agents', 'discovery.js'), suite: 'test/unit/routines-end-to-end.test.js' };
// The shell's half of the same walk. Watched by the file that runs app.js's own
// writer and then reads the rendered page, because the doors suite stubs that
// writer out and would stay green with the shell recording nothing at all.
const APP_E2E = { src: path.join(ROOT, 'public', 'app.js'), suite: 'test/unit/routines-end-to-end.test.js' };
// The one place every workspace change reaches, which is where the notice that
// a window did not ask for is sent from. Watched by the file that drives the
// switch handler and the rollback with a real capturing client on the real
// broadcast set.
const ROOT_SERVER = { src: path.join(ROOT, 'server.js'), suite: 'test/unit/protocol-handlers-lib.test.js' };
// The server's half: telling every window where the scheduler went. Watched by
// the file that drives the switch handler through a context whose broadcast it
// can read, because a notice sent only to the socket that asked is exactly the
// silence this change removes and every client-side test would stay green.
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
  [SCHEDULER, 'the walk is bounded rather than counting every day since the anchor',
    'step < MAX_SLOTS_PER_WAKE; step++',
    'step < 100000; step++'],
  [SCHEDULER, 'the slot the last run served is named',
    '    lastSlot: started ? slotFor(parsed, started).toISOString() : null,\n',
    '    lastSlot: null,\n'],
  [SCHEDULER, 'the most recent recorded miss is the one reported',
    '  const missed = entry && entry.missed.length ? entry.missed[entry.missed.length - 1].slot : null;',
    '  const missed = null;'],
  [DISCOVERY, 'the roster carries when a routine runs next',
    '        r.nextRun = facts.nextRun;\n',
    ''],
  [DISCOVERY, 'the roster carries when the last run began',
    '        r.lastStart = facts.lastStart;\n',
    ''],
  [DISCOVERY, 'the roster carries the slot the last run served',
    '        r.lastSlot = facts.lastSlot;\n',
    ''],
  [DISCOVERY, 'the roster carries the slot that passed unserved',
    '        r.missedSlot = facts.missedSlot;\n',
    ''],

  // ===== WHICH INSTANT LATENESS IS MEASURED FROM =====
  // The second one this file exists for. routineState.lastRun is the moment a
  // finished run ENDED, and an agent run routinely takes longer than the
  // catch-up boundary, so measuring from it would put the quieter tone on
  // almost every ordinary row: the ruling inverted in the commonest case.
  [END_TO_END, 'lateness is measured from when the run began, not when it ended',
    '  return new Date(ended.getTime() - seconds * 1000);',
    '  return ended;'],
  [SCHEDULER, 'a stamp with no duration is already the start',
    "  if (typeof seconds !== 'number' || !isFinite(seconds)) return ended;\n",
    ''],
  [SCHEDULER, 'the slot a run served is the one on the day it started',
    '    lastSlot: started ? slotFor(parsed, started).toISOString() : null,',
    '    lastSlot: lastRunStartedAt(key) ? slotFor(parsed, new Date(routineState[key].lastRun)).toISOString() : null,'],
  [VIEW_E2E, 'the row asks the roster for the instant the run began',
    '    lastStart: r.lastStart,',
    '    lastStart: r.state ? r.state.lastRun : null,'],

  // ===== THE ANCHOR MEANS NOW, NOT WHENEVER THIS MACHINE WAS LAST AWAKE =====
  // The third one this file exists for. The slot store's `due` is refreshed by
  // the tick and by nothing else, so a machine reopened after days closed
  // answers the client's first roster request with an anchor days old, and the
  // missed row renders a next run that has already gone by. That is the value
  // the criteria call constrained rather than chosen, failing in exactly the
  // situation the row exists for.
  [END_TO_END, 'the anchor is the period now falls in, not the last one a tick recorded',
    '  let slot = slotFor(parsed, deps.now());',
    '  const anchored = routineSlots.routines[key];\n  if (!anchored) return null;\n  let slot = new Date(anchored.due);'],
  [SCHEDULER, 'a row can name a next run before any tick has seen the routine',
    '  let slot = slotFor(parsed, deps.now());',
    '  const anchored = routineSlots.routines[key];\n  if (!anchored) return null;\n  let slot = new Date(anchored.due);'],

  // ===== UNCHANGED BYTES ARE NOT AN ANSWER =====
  // A file this module cannot address returns unchanged content, exactly as a
  // no-op edit does. Reading that as success announces a routine stopped that
  // is still scheduled to run.
  // The read-back guard moved into the one setter both controls call, so this
  // watches it there. It covers pausing and turning on at once, which is the
  // point of sharing it: one guard, one mutation, and no second copy free to
  // admit something the first refuses.
  [HANDLER, 'a routine flag change asks whether the write happened, not whether the bytes moved',
    '  if (!written || written[field] !== value) {',
    '  if (next === before && false) {'],
  [HANDLER, 'a delete counts the blocks rather than looking one up by index',
    '  if (readRoutineBlocks(next, found.name).length !== readRoutineBlocks(before, found.name).length - 1) {',
    '  if (readRoutineBlock(next, found.name, found.occurrence)) {'],
  [ROUTINES, 'a block is read back through the same pair the roster is built from',
    '    .map(raw => normalizeRoutine(raw))\n',
    ''],

  // ===== A REFUSAL BELONGS TO THE SCREEN THAT ASKED =====
  // Sending a refused pause or delete down the SAVE road calls the editor's
  // save-failure callback outside any save and puts the only reply in the
  // conversation view, while the list the control was pressed on says nothing.
  [HANDLER, 'a refused action answers on the routines surface, not the save road',
    "    type: 'routine_action_error',",
    "    type: 'routine_error',"],
  [HANDLER, 'a refusal names the routine it is about',
    "    name: msg && msg.name ? msg.name : null,\n",
    ''],
  [APP, 'the refusal reaches the list that asked',
    '      routinesActionFailed(d);\n',
    ''],
  [APP, 'a delete that goes through retires the last refusal',
    "    case 'routine_deleted':\n      routinesActionCleared();",
    "    case 'routine_deleted':"],
  [APP, 'a pause that goes through retires the last refusal',
    "    case 'routine_paused':\n      routinesActionCleared();",
    "    case 'routine_paused':"],
  [VIEW_REPLY, 'the refusal is drawn on the list',
    '    h += `<p class="routines-problem" role="alert" data-routines-problem>${esc(pendingProblem)}</p>`;\n',
    ''],
  [VIEW_REPLY, 'a refusal with nothing in it still says something',
    '  pendingProblem = routinesModel().actionProblem(reply);',
    '  pendingProblem = reply && reply.message ? reply.message : null;'],
  // ONE ROW, because the guard lives in one place: both controls delegate to
  // one send path. A control added later that clears the refusal itself, rather
  // than through that path, needs a row of its own.
  // ANCHORED ON THE FUNCTION IT BELONGS TO. The three lines now open two
  // functions, the shared send path and the door onto the editor, and String
  // replace takes the first: unanchored, this would break whichever came first
  // and report on whatever that turned red. The guard itself is unchanged.
  [VIEW_REPLY, 'a control the reader presses clears the last refusal',
    "  const entry = allRoutines()[index];\n  pendingProblem = null;\n  if (!entry || typeof ws === 'undefined'",
    "  const entry = allRoutines()[index];\n  if (!entry || typeof ws === 'undefined'"],
  [MODEL, 'a refusal says nothing was changed',
    "  const ACTION_PROBLEM = 'That routine could not be changed. Nothing has been altered.';",
    "  const ACTION_PROBLEM = 'That routine could not be changed.';"],
  [MODEL, 'the server\'s own words are the ones shown',
    "    const message = input && typeof input.message === 'string' ? input.message.trim() : '';\n    return message || ACTION_PROBLEM;",
    '    return ACTION_PROBLEM;'],

  // ===== THE SENTENCES THAT NAME THE GUIDE =====
  //
  // Each of the four view mutations writes the DEFAULT NAME back in, which is
  // the defect in its exact form: it type-checks, it reads correctly, and on
  // the shipped workspace it is even true. Only a workspace whose guide is
  // called something else can tell, which is why the suite these point at
  // builds one.
  [GUIDE_COPY_MOD, 'the slot is substituted rather than left in the sentence',
    "    return line ? line.replace('{agent}', name) : null;",
    '    return line || null;'],
  [GUIDE_COPY_MOD, 'a workspace with no guide gets the line that names none',
    '    if (!name) return GUIDE_COPY[`${key}NoGuide`] || null;',
    '    if (!name) return GUIDE_COPY[key] || null;'],
  [GUIDE_COPY_MOD, 'no sentence carries a pronoun for the agent it names',
    "    fresh: 'Fresh workspace. {agent} can help you set up your agent team from scratch.',",
    "    fresh: 'Fresh workspace. {agent} can set up your agent team, and he starts from scratch.',"],
  [TEAM_COPY, 'the sidebar names the guide the workspace actually has',
    "guideLine('sidebar', guide.displayName)", "guideLine('sidebar', 'Doc')"],
  [TEAM_COPY, 'the conversations pane names the guide the workspace actually has',
    "guideLine('conversations', guide.displayName)", "guideLine('conversations', 'Doc')"],
  [TEAM_COPY, 'the fresh-workspace state names the guide the workspace actually has',
    "guideLine('fresh', guide && guide.displayName)", "guideLine('fresh', 'Doc')"],
  [PROFILE_COPY, 'the Setup button names the guide it opens a conversation with',
    "guideCopy.guideLine('setup', getGuide()?.displayName)", "guideCopy.guideLine('setup', 'Doc')"],

  // ===== THE AGENT PROFILE'S ROUTINES BOX =====
  //
  // THE FIRST OF THESE IS THE DEFECT IN ITS EXACT FORM. It is the line that
  // shipped, it reads as a helpful detail, and it routes around the three-tone
  // ruling entirely. It is written back here so that the ruling's absence from
  // this surface cannot return quietly.
  [PROFILE_BOXES, 'no run outcome reaches the agent profile',
    "          <span style=\"font-size:var(--caption);color:var(--text-2)\">${esc(when)}</span>",
    "          <span style=\"font-size:var(--caption);color:var(--text-2)\">${esc(when)}</span>\n"
    + "          <span style=\"font-size:var(--caption)\">${r.state ? `Last run: ${formatTimeAgo(r.state.lastRun)} (${r.state.status})` : ''}</span>"],
  [PROFILE_BOXES, 'a schedule reads in the words the routines view uses',
    '        const when = (routinesModel && routinesModel.scheduleWords(r.schedule)) || r.schedule;',
    '        const when = r.schedule;'],
  // The other direction. The model has plain words only for the schedules the
  // editor offers, so a routine written by hand has none, and without the
  // fallback its row shows an empty line where its schedule should be.
  [PROFILE_BOXES, 'a schedule the model cannot translate falls back to the stored string',
    '        const when = (routinesModel && routinesModel.scheduleWords(r.schedule)) || r.schedule;',
    '        const when = routinesModel && routinesModel.scheduleWords(r.schedule);'],
  [PROFILE_BOXES, 'the Routines box is there whether or not the agent has any',
    '    h+=`<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Routines</div>`;\n    if(hasRoutines) {',
    '    if (!hasRoutines) { h+=\'\'; } else {\n    h+=`<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Routines</div>`;\n    if(hasRoutines) {'],
  [PROFILE_BOXES, 'Add routine goes once the agent has a routine',
    '    if(hasRoutines) {\n      for(const r of a.routines) {',
    '    if(false) {\n      for(const r of a.routines) {'],
  [PROFILE_BOXES, 'no pause or delete is offered on the profile',
    '          <span style="font-weight:600">${esc(r.name)}</span>',
    '          <span style="font-weight:600">${esc(r.name)}</span>\n'
    + '          <button type="button" data-routines-action="pause">Pause</button>'],

  // Where a row goes, watched by the file that presses the route.
  [PROFILE_ROUTE, 'a routine row carries the agent whose profile it is on',
    'onclick="showRoutinesForAgent(this.dataset.agentId)"',
    'onclick="showRoutinesForAgent(null)"'],
  [VIEW_SCOPE, 'the list is filtered to the agent it was opened for',
    '  if (typeof setRoutinesScope === \'function\') setRoutinesScope(agentId);',
    '  if (typeof setRoutinesScope === \'function\') setRoutinesScope(null);'],
  [VIEW_SCOPE, 'a route that names no agent clears the scope rather than keeping the last one',
    '  if (typeof setRoutinesScope === \'function\') setRoutinesScope(agentId);\n  else renderRoutines();',
    '  if (agentId && typeof setRoutinesScope === \'function\') setRoutinesScope(agentId);\n  else renderRoutines();'],
  // Arriving redraws the ROWS as well as the list. The panel carries the
  // counts and the selection, so a route that drew only the pane would land a
  // reader on a list scoped to an agent the panel shows as unselected.
  [VIEW_SCOPE, 'arriving draws the panel as well as the list',
    '  if (typeof setRoutinesScope === \'function\') setRoutinesScope(agentId);\n  else renderRoutines();',
    '  renderRoutines();'],
  // A DESTRUCTIVE ACTION ADDRESSED BY POSITION, IN A LIST THE SCOPE REMAPS.
  // Removing this line leaves a confirmation the reader never opened on the
  // page, aimed at whichever routine now sits at that index, and confirming it
  // deletes that one.
  // Anchored on the line that follows the clear rather than on the nav call that
  // used to: the section is a property of the view now, so showRoutinesForAgent
  // names none. The guard being broken is the clear itself, unchanged.
  [VIEW_SCOPE, 'arriving on the list clears a confirmation opened under another scope',
    '  pendingDelete = null;\n  pendingProblem = null;\n  if (typeof showView',
    '  if (typeof showView'],

  // ===== WHAT THE TEAM PANEL NO LONGER CARRIES =====
  //
  // The listing is gone and the rule left behind is an absence. Each of these
  // writes the absent thing back, in the shape it had, and requires the panel's
  // own file to notice.
  [TEAM_PANEL, 'the team panel carries the roster and nothing beside it',
    "  document.getElementById('agent-list').innerHTML = h;",
    "  document.getElementById('agent-list').innerHTML = h;\n"
    + "  document.getElementById('sidebar-team').insertAdjacentHTML('beforeend',"
    + " '<div class=\"routine-item\">Compile the ops summary, 7:00 AM</div>');"],
  [TEAM_PANEL, 'an agent row says how the agent is, never how many routines it has',
    "  if (onTeam.length) {\n    for (const a of onTeam) {\n"
    + "      const isWorking = workingIds.has(a.id);\n"
    + "      const last = agentLastActivity[a.id];\n"
    + "      const statusText = isWorking ? 'working' : (last ? formatTimeAgo(last.time) : 'idle');",
    "  if (onTeam.length) {\n    for (const a of onTeam) {\n"
    + "      const isWorking = workingIds.has(a.id);\n"
    + "      const last = agentLastActivity[a.id];\n"
    + "      const statusText = `${(a.routines || []).length} routines`;"],
  [TEAM_DOOR, 'the team sidebar renders no way into the editor',
    "  document.getElementById('agent-list').innerHTML = h;",
    "  h += '<button data-sidebar-action=\"add-routine\" onclick=\"addRoutine()\">Add</button>';\n"
    + "  document.getElementById('agent-list').innerHTML = h;"],
  [INDEX_SWEEP, 'the element the listing rendered into went with the listing',
    '      <div class="agent-status-list" id="agent-list"></div>\n',
    '      <div class="agent-status-list" id="agent-list"></div>\n      <div id="sidebar-routines"></div>\n'],

  // ===== WHO DRAWS THIS LIST, AND HOW A READER ARRIVES AT IT =====
  [APP, 'the arriving roster redraws the list',
    'renderRoutinesPanel(); renderRoutines(); renderConvoList();',
    'renderRoutinesPanel(); renderConvoList();'],
  [APP, 'the rail entry draws something into the view it shows',
    "  else if(nav==='routines') { showRoutinesForAgent(null); }",
    "  else if(nav==='routines') { }"],
  [APP, 'the routines section reveals a sidebar the reader can see',
    'document.getElementById(`sidebar-${nav}`).classList.remove(\'hidden\');',
    "document.getElementById(`sidebar-${nav === 'routines' ? 'team' : nav}`).classList.remove('hidden');"],
  [APP, 'the routines panel is one the router hides before revealing another',
    "['team','conversations','skills','files','settings','routines']",
    "['team','conversations','skills','files','settings']"],
  [APP, 'the routines panel is one showView knows how to reveal',
    "'settings','routine-editor','routines','run-detail']",
    "'settings','routine-editor','run-detail']"],
  [INDEX, 'the rail carries a way to this section',
    '<button class="nav-item" data-nav="routines" onclick="switchNav(\'routines\')" data-tooltip="Routines">',
    '<button class="nav-item" data-nav="not-routines" onclick="switchNav(\'not-routines\')" data-tooltip="Routines">'],
  [INDEX, 'the page carries the element this list renders into',
    '<div class="routines-content" id="routines-content"></div>',
    '<div class="routines-content"></div>'],

  // ===== WHICH ROUTINE OF ITS NAME =====
  [VIEW, 'a row says which routine of its name it is',
    '      out.push({ routine, agent, occurrence });',
    '      out.push({ routine, agent, occurrence: 0 });'],
  [VIEW, 'a delete says which routine of its name it means',
    "      type: 'delete_routine', agentId: target.agentId, name: target.name, occurrence: target.occurrence,",
    "      type: 'delete_routine', agentId: target.agentId, name: target.name, occurrence: 0,"],
  // One send path, so one mutation: dropping the occurrence makes EVERY
  // control act on the first routine of its name, which both the pause and the
  // turn-on namesake tests notice.
  [VIEW, 'a routine flag change says which routine of its name it means',
    "    occurrence: entry.occurrence, [field]: value,",
    "    occurrence: 0, [field]: value,"],
  [HANDLER, 'which routine of a name is required rather than assumed to be the first',
    '  if (!Number.isInteger(occurrence) || occurrence < 0) {\n    fail(\'Which routine of that name is required.\');\n    return null;\n  }',
    '  if (false) { return null; }'],
  [HANDLER, 'the delete tells the writer which block',
    '  const next = removeRoutineBlock(before, found.name, found.occurrence);',
    '  const next = removeRoutineBlock(before, found.name);'],
  // The write moved into the one function both the row's controls and the
  // schedule edit go through, so the guard text moved with it. Unchanged
  // otherwise: dropping the occurrence still makes every control act on the
  // first routine of its name whatever the reader pointed at.
  [HANDLER, 'a routine field change tells the writer which block',
    '    next = updateRoutineBlock(before, found.name, { [field]: value }, found.occurrence);',
    '    next = updateRoutineBlock(before, found.name, { [field]: value });'],

  // ===== THE GUARD A SCHEDULE EDIT HAS TO SURVIVE =====
  //
  // A routine keeps its run stamp when its schedule moves, because the state is
  // keyed by identity. Each of these breaks one half of the comparison that
  // then decides whether it runs again, runs twice, or never runs.
  [SCHEDULER_EDIT, 'the daily suppression compares the hour, not just the day',
    '      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parsed.hour) return null;',
    '      if (lastRun.toDateString() === now.toDateString()) return null;'],
  [SCHEDULER_EDIT, 'the daily suppression compares the day, not just the hour',
    '      if (lastRun.toDateString() === now.toDateString() && lastRun.getHours() >= parsed.hour) return null;',
    '      if (lastRun.getHours() >= parsed.hour) return null;'],
  [SCHEDULER_EDIT, 'a weekly routine that already ran on its day is not run again',
    '    if (daysSinceLastRun < 1 && lastRun.getDay() === parsed.day) return null;',
    '    if (false) return null;'],

  // ===== THE THIRD CONTROL ON THE ROW =====
  //
  // A routine's schedule could only be changed by deleting the routine and
  // making a new one, so the control's absence is the defect these put back.
  [VIEW, 'a row offers a way to change when it runs',
    "    actions += iconButton('edit', 'Edit schedule', ICONS.pencil, `routinesEditSchedule(${index})`, false);\n",
    ''],
  [VIEW, 'the edit control says what it opens',
    "    actions += iconButton('edit', 'Edit schedule', ICONS.pencil, `routinesEditSchedule(${index})`, false);",
    "    actions += iconButton('edit', '', ICONS.pencil, `routinesEditSchedule(${index})`, false);"],
  // Changing when a routine runs is not destructive and must not be dressed as
  // it. The danger flag reads as the delete control's tone.
  [VIEW, 'the edit control is not dressed as a destructive one',
    "    actions += iconButton('edit', 'Edit schedule', ICONS.pencil, `routinesEditSchedule(${index})`, false);\n"
    + "    actions += iconButton('delete'",
    "    actions += iconButton('edit', 'Edit schedule', ICONS.pencil, `routinesEditSchedule(${index})`, true);\n"
    + "    actions += iconButton('delete'"],
  [EDIT_DOOR_ROW, 'the edit door says which routine of its name it means',
    '  editRoutineSchedule(entry.agent.id, entry.routine.name, entry.occurrence);',
    '  editRoutineSchedule(entry.agent.id, entry.routine.name, 0);'],
  [VIEW, 'opening the editor clears the refusal the last action left',
    '  const entry = allRoutines()[index];\n  pendingProblem = null;\n  if (!entry || typeof editRoutineSchedule',
    '  const entry = allRoutines()[index];\n  if (!entry || typeof editRoutineSchedule'],
  // The door itself, watched by the file that enumerates every way into the
  // editor rather than by the file that draws the row.
  [EDIT_DOOR, 'the edit door opens on the routine it was handed, not on the first of its name',
    '    const routine = (agent.routines || []).filter(r => r && r.name === name)[occurrence] || null;',
    '    const routine = (agent.routines || []).filter(r => r && r.name === name)[0] || null;'],
  [EDIT_DOOR, 'the edit door pre-fills from the routine it opened on',
    '      frequency: parsed ? parsed.frequency : null,\n      time: parsed ? parsed.time : null,',
    '      frequency: null,\n      time: null,'],
  [EDIT_DOOR, 'a stored schedule is looked up rather than split apart',
    '    const parsed = model().readSchedule(routine.schedule);',
    "    const p = /^every ([a-z]+) at (\\d{2}:\\d{2})$/.exec(String(routine.schedule).toLowerCase());\n"
    + '    const parsed = p ? { frequency: p[1], time: p[2] } : null;'],
  [EDIT_DOOR, 'the editor opens on the step an edit has, not on the picker',
    "      step: 'schedule',\n      agentId: agent.id,",
    "      step: 'pick',\n      agentId: agent.id,"],

  // ===== THE THREE TONES, AS THE PAGE RESOLVES THEM =====
  [STYLES, 'a late run keeps the success colour, and no state is amber',
    '.run-status.ok-quiet { font-weight: 500; color: var(--success); }',
    '.run-status.ok-quiet { font-weight: 500; color: var(--attention); }'],
  [STYLES, 'a late run is quieter than a punctual one',
    '.run-status.ok { font-weight: 600; color: var(--success); }',
    '.run-status.ok { font-weight: 500; color: var(--success); }'],
  [STYLES, 'a slot nobody served is not dressed as a failure',
    '.run-status.neutral { font-weight: 500; color: var(--idle); }',
    '.run-status.neutral { font-weight: 500; color: var(--danger); }'],
  [STYLES, 'a failure is not dressed as a success',
    '.run-status.failed { font-weight: 600; color: var(--danger); }',
    '.run-status.failed { font-weight: 600; color: var(--success); }'],

  // ===== THE SAVE DESTINATION, AND THE SILENCE AROUND IT =====
  // The trap the criteria name. Each of these is a way for a written routine
  // to land on the team chart with nothing thrown and nothing logged.
  [EDITOR_NAV, 'a save resolves its destination rather than assuming one',
    "    return navigable(destination) ? destination : 'team';",
    "    return 'team';"],
  // THE THIRD HALF OF THE CHECK IS NOT MUTATED HERE, and the reason is the
  // reason this card dropped a probe of its own. Removing a check cannot fail
  // against a shell that HAS the thing checked: this suite's page carries the
  // sidebar panel, so a permissive check still resolves and still lands. What
  // discriminates it is removing the ELEMENT, which INDEX_PANEL below does,
  // and taking the halves away one at a time, which the editor's own harness
  // does against a shell built for exactly that.

  // ===== ONE MOUNT, ONE RENDERER =====
  // The legacy team-sidebar listing draws into this panel's element. It is no
  // longer called, and the mutation calls it again, AFTER the panel, which is
  // the order that was one edit away the whole time.
  [APP_DISPATCH, 'nothing draws over the scope panel after it is drawn',
    'renderOrgChart(); renderRoutinesPanel(); renderRoutines();',
    'renderOrgChart(); renderRoutinesPanel(); renderRoutinesSidebar(); renderRoutines();'],

  // ===== A CONFIRMATION CANNOT CHANGE SUBJECT UNDER THE READER =====
  // The scope filter made the list this addresses into one that changes
  // without the routines changing, so a pending delete held as a POSITION was
  // re-resolved against a different set the moment a scope row was pressed.
  // These put the position back.
  [VIEW_CONFIRM, 'the confirmation draws the namesake it was raised on',
    '    && entry.occurrence === pendingDelete.occurrence);',
    '    && true);'],
  [VIEW_CONFIRM, 'a pending delete is an identity, not a position in a filtered list',
    '  const pending = pendingEntry(list);\n  if (!pending) pendingDelete = null;\n  if (pending) content.innerHTML = confirmHtml(pending, list.indexOf(pending));',
    '  const pending = pendingDelete ? list[0] : null;\n  if (pending) content.innerHTML = confirmHtml(pending, 0);'],
  [VIEW_CONFIRM, 'a confirmation the reader has navigated away from does not come back',
    '  if (!pending) pendingDelete = null;\n',
    ''],

  // ===== ONE LIST OF PANELS, NOT TWO =====
  // The workspace switch carried its own copy of the router's hide list, and
  // the copy went stale the moment this panel was lifted out of the team one.
  // The mutation writes the second list back.
  [APP_WORKSPACE, 'the workspace switch hides panels through the router rather than its own list',
    '  routinesPanelReset();\n  setNavState(\'conversations\');',
    "  document.querySelectorAll('.nav-item[data-nav]').forEach(n=>n.classList.remove('active'));\n"
    + "  document.querySelector('[data-nav=\"conversations\"]')?.classList.add('active');\n"
    + "  ['team','conversations','skills','files','settings'].forEach(s=>document.getElementById(`sidebar-${s}`).classList.add('hidden'));\n"
    + "  document.getElementById('sidebar-conversations').classList.remove('hidden');"],
  [APP_WORKSPACE, 'the workspace switch forgets the scope the last workspace was left on',
    '  routinesPanelReset();\n  setNavState',
    '  setNavState'],

  // ===== THE ROUTINES PANEL IS A PANEL OF ITS OWN =====
  // The decision this card reversed, and the mutations put it BACK. The panel
  // was a child of the team one, revealed through an alias, so the two
  // sidebars were one element rather than two that resembled each other. A
  // rule whose content is "this is no longer nested" is otherwise unmutatable,
  // and an unmutatable rule is one the next person undoes with nothing red.
  [INDEX_PANEL, 'the routines panel is a sidebar in its own right',
    '    </div>\n    <!-- The routines panel is a sidebar in its own right',
    '    <div id="sidebar-routines" class="hidden"></div>\n    </div>\n    <!-- The routines panel is a sidebar in its own right'],
  [INDEX_PANEL, 'the panel the router reveals is the one the editor resolves to',
    '<div id="sidebar-routines" class="hidden"></div>',
    '<div id="sidebar-routines-panel" class="hidden"></div>'],

  // ===== WHAT THE SCOPE LIST HOLDS =====
  [SCOPE_MODEL, 'All routines is pinned in every state, including an empty one',
    '    const all = { id: ALL, name: COPY.all, count: total, active: scope === null };',
    '    const all = null;'],
  [SCOPE_MODEL, 'only agents that own a routine are scopes',
    '      if (!agent || !agent.routines || !agent.routines.length) continue;',
    '      if (!agent) continue;'],
  [SCOPE_MODEL, 'a paused routine is counted',
    '        count: agent.routines.length,',
    '        count: agent.routines.filter(r => !r.paused).length,'],
  [SCOPE_MODEL, 'the order is the roster order, never the count order',
    '    return out;\n  }\n\n  /**\n   * The scope the panel should be on',
    '    return out.sort((a, b) => b.count - a.count);\n  }\n\n  /**\n   * The scope the panel should be on'],
  [SCOPE_MODEL, 'a filter with one option is not drawn',
    '    if (list.length >= MIN_OWNERS) {',
    '    if (list.length >= 1) {'],
  [SCOPE_MODEL, 'a panel that draws no list says why',
      "      quiet: list.length === 1 ? soleOwnerLine(list[0].name) : COPY.none,",
      '      quiet: null,'],
  [SCOPE_MODEL, 'the panel does not repeat the pane\'s own lead sentence',
    "    none: 'Agents with routines are listed here.',",
    "    none: 'No routines yet. Agents with routines are listed here.',"],
  [SCOPE_MODEL, 'a scope whose agent stops owning routines falls back to All',
    '    return list.filter(o => o.id === scope).length ? scope : null;',
    '    return scope;'],
  [SCOPE_MODEL, 'a scope goes when the list that offered it is withdrawn',
    '    if (list.length < MIN_OWNERS) return null;\n',
    ''],

  // ===== THE SCOPE, AND WHO IT REACHES =====
  [PANEL, 'the plus inherits the scope the panel is on',
    '  addRoutineForAgent(routinesScopeAgentId());',
    '  addRoutineForAgent(null);'],
  [PANEL_PRESS, 'pressing a scope redraws the list beside the panel',
    '  renderRoutinesPanel();\n  renderRoutines();',
    '  renderRoutinesPanel();'],
  [PANEL, 'the scope is resolved on every read rather than kept',
    '  scope = m.resolveScope({ agents: roster(), scope });\n  return scope;',
    '  return scope;'],
  [APP_PANEL, 'the rail forgets the scope, so a visit always opens on All',
    "  else if(nav==='routines') { showRoutinesForAgent(null); }",
    "  else if(nav==='routines') { showRoutinesForAgent(routinesScopeAgentId()); }"],
  [APP_DISPATCH, 'the arriving roster redraws the panel as well as the list',
    'renderOrgChart(); renderRoutinesPanel(); renderRoutines();',
    'renderOrgChart(); renderRoutines();'],
  [VIEW_SCOPE, 'the list is the scope the panel is on',
    '  const scoped = scope ? out.filter(entry => entry.agent.id === scope) : out;',
    '  const scoped = out;'],

  // ===== A SCOPE ROW IS NOT A ROSTER ROW =====
  // The complaint the panel answers is that the two sidebars looked the same,
  // and the answer has to be visible rather than structural. These break what
  // a browser actually resolves.
  [STYLES_PANEL, 'selected takes the selected fill, not the hover fill',
    '.scope-item.active { background: var(--accent-glow); }',
    '.scope-item.active { background: var(--elevated); }'],
  [STYLES_PANEL, 'hover takes the hover fill',
    '.scope-item:hover { background: var(--elevated); }',
    '.scope-item:hover { background: var(--accent-glow); }'],

  // ===== THE VALUE THAT IS CONSTRAINED, NOT COPY =====
  // The second one this file exists for: the literal two design frames wrote.
  [MODEL, 'the next-run label renders the instant it is handed, with no value of its own',
    '    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);',
    "    const words = 'tomorrow, 7:00am, London time';"],

  // ===== THE THREE TONES =====
  [MODEL, 'each outcome carries its own leading word',
    "    'caught-up': { tone: 'ok-quiet', lead: 'Caught up' },",
    "    'caught-up': { tone: 'ok-quiet', lead: 'Ran' },"],
  [MODEL, 'a late run is told from a punctual one by more than a moment',
    '  const CATCH_UP_AFTER_MS = 5 * 60 * 1000;',
    '  const CATCH_UP_AFTER_MS = 0;'],
  [MODEL, 'a run still going names no outcome',
    "    if (statusWord === 'running') return null;",
    ''],
  // A routine that was never in service is owed no record of what it did not
  // do, and the withholding has to survive the moment somebody turns it on.
  [SCHEDULER, 'a routine nobody turned on accrues no missed slots',
    '  if (!inService) {\n    entry.due = current.toISOString();\n    return;\n  }',
    '  if (false) { return; }'],
  // And the anchor still moves while it waits, or turning it on enumerates
  // every slot since as a backlog of misses.
  [SCHEDULER, 'the anchor moves even while nothing is being recorded',
    '  if (!inService) {\n    entry.due = current.toISOString();\n    return;\n  }',
    '  if (!inService) return;'],
  // The offer says when the first run lands only where that is true: past
  // means immediate, ahead means the day and time, none means say nothing.
  [MODEL, 'the offer only claims an immediate first run when the time has gone',
    '      timing = when <= now',
    '      timing = true'],
  [MODEL, 'a miss later than the last run is what happened last',
    "    if (missedSlot && (!started || missedSlot > started) && !heldBack) return 'missed';",
    "    if (missedSlot && !heldBack) return 'missed';"],
  // A routine nobody turned on is not owed an explanation naming an event that
  // did not happen.
  [MODEL, 'a routine nobody turned on is not told Rundock was closed on it',
    "    const heldBack = input && input.enabled === false;",
    '    const heldBack = false;'],
  // And the withholding skips the OUTCOME rather than the whole status: a run
  // that really happened is still reported underneath a slot that passed after
  // it.
  [MODEL, 'withholding the missed outcome does not hide a run that happened',
    "    if (missedSlot && (!started || missedSlot > started) && !heldBack) return 'missed';",
    "    if (missedSlot && (!started || missedSlot > started)) return heldBack ? null : 'missed';"],
  [MODEL, 'a run the process died inside is a failure',
    "    return statusWord === 'failed' || statusWord === 'interrupted';",
    "    return statusWord === 'failed';"],

  // ===== THE WORDS =====
  [MODEL, 'a missed row names the cause rather than the routine',
    "      text = `Missed: Rundock was closed at ${place ? `${when}, ${place} time` : when}`;",
    '      text = `Missed: the routine did not run at ${when}`;'],
  [MODEL, 'a caught-up row names the time it was due as well as the time it ran',
    '      text = `Caught up: ran ${timeWords(input.lastStart, now, zone)}, due ${clockWords(input.lastSlot)}`;',
    '      text = `Caught up: ran ${timeWords(input.lastStart, now, zone)}`;'],
  [MODEL, 'a punctual row reads as the time, with no label in front of it',
    '      text = `Ran ${timeWords(input.lastStart, now, zone)}`;',
    '      text = `Ran on time: ${timeWords(input.lastStart, now, zone)}`;'],
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
    '  } else if (row.status) {',
    '  } else if (true) {'],
  [VIEW, 'a paused row offers resume rather than pause again',
    "    actions += r.paused\n      ? iconButton('resume', 'Resume', ICONS.play, `routinesSetPaused(${index}, false)`, false)\n      : iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);",
    "    actions += iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);"],
  [VIEW, 'delete asks before it acts',
    '  pendingDelete = entry\n    ? { agentId: entry.agent.id, name: entry.routine.name, occurrence: entry.occurrence }\n    : null;',
    '  pendingDelete = null;'],
  [VIEW, 'a delete names the routine that was confirmed',
    "      type: 'delete_routine', agentId: target.agentId, name: target.name, occurrence: target.occurrence,",
    "      type: 'delete_routine', agentId: target.agentId, name: 'anything', occurrence: target.occurrence,"],
  [VIEW, 'the empty state offers something to press',
    "      + `<button class=\"settings-btn-primary\" type=\"button\" data-routines-action=\"${action.marker}\"`",
    "      + '<button class=\"settings-btn-primary\" type=\"button\" data-routines-action=\"nothing\"'"],

  // ===== WHICH EMPTY STATE, AND WHETHER IT WAITS =====
  // The locked copy presupposes a tested skill, which gating quietly
  // guaranteed and permanence removes. Every guard below is one half of that.
  [MODEL, 'a workspace with no skills gets the variant written for it',
    '    if (choice.createSkill) {',
    '    if (false) {'],
  [MODEL, 'the build-a-skill variant drops the aside',
    '        // No aside: the second way in it names is a skill\'s own page, and this\n'
    + '        // workspace has no skill to have one.\n        aside: null,',
    '        aside: EMPTY.aside,'],
  [MODEL, 'the offer waits for the skill list to arrive',
    '    if (input && input.loading) {\n'
    + '      return { lead: EMPTY.lead, body: editor.STEP_LEADS.loading, action: null, actionKind: null, aside: null };\n'
    + '    }\n',
    ''],
  [MODEL, 'the build offer goes with the agent that fulfils it',
    '        action: guideName ? choice.createSkillLabel : null,',
    '        action: choice.createSkillLabel,'],
  // The half review found missing: dropping the button used to drop the only
  // thing telling the reader what to do, leaving a line that instructs an
  // action with nothing to press.
  [MODEL, 'the no-guide state gains a next step rather than only losing its button',
    '        body: guideName ? choice.emptyLead : `${choice.emptyLead} ${skills.EMPTY.nextStepNoGuide}`,',
    '        body: choice.emptyLead,'],
  [MODEL, 'the shipped line is kept whole rather than replaced',
    '        body: guideName ? choice.emptyLead : `${choice.emptyLead} ${skills.EMPTY.nextStepNoGuide}`,',
    '        body: skills.EMPTY.nextStepNoGuide,'],
  [VIEW, 'the list tells the model whether the skills have arrived',
    '    loading: !skillsHaveArrived(),',
    '    loading: false,'],
  [VIEW, 'the list tells the model which guide the workspace has',
    "    guideName: guide ? (guide.displayName || guide.name || null) : null,",
    "    guideName: 'Doc',"],
  [VIEW, 'the aside is drawn only where the model kept one',
    '  if (state.aside) h += `<p class="settings-caption routines-empty-aside">${esc(state.aside)}</p>`;',
    '  h += `<p class="settings-caption routines-empty-aside">${esc(model.EMPTY.aside)}</p>`;'],
  [APP_SKILLS, 'the skill list arriving redraws the list that asks about skills',
    "renderSkills(); renderRoutines(); routineEditorSkillsArrived(d.skills);",
    'renderSkills(); routineEditorSkillsArrived(d.skills);'],
  // THE OPENER, not the render behind it. This is the line whose absence left
  // the first press of Skills in a session opening onto a blank pane while
  // every test that called renderSkills stayed green.
  [APP_OPENER, 'pressing the Skills entry draws into the pane it reveals',
    "  else if(nav==='skills') { showView('skills'); renderSkillsIfEmpty(); if(!skillsLoaded)",
    "  else if(nav==='skills') { showView('skills'); if(!skillsLoaded)"],
  // THE OTHER DIRECTION, and it is the one a single mutation would miss. These
  // two calls are one word apart and only one of them is what the card wanted:
  // drawing unconditionally also fixes the blank pane, and takes a pane the
  // reader had scrolled or opened a card on with it.
  [APP_OPENER, 'pressing the Skills entry leaves a pane that is already drawn',
    "  else if(nav==='skills') { showView('skills'); renderSkillsIfEmpty(); if(!skillsLoaded)",
    "  else if(nav==='skills') { showView('skills'); renderSkills(); if(!skillsLoaded)"],
  // Watched by the file that PRESSES the entry, not the one that calls the
  // render: the pane this guard protects is one only a press can find already
  // drawn. Aimed at the copy suite first, this mutation turned nothing red,
  // which is the harness reporting a proof pointed at the wrong place rather
  // than a guard nothing holds.
  [SKILLS_VIEW_RAIL, 'the opener asks the page whether anything is drawn',
    '  if (detail && detail.firstElementChild) return false;\n',
    ''],
  [APP_OPENER, 'pressing the Routines entry draws into the pane it reveals',
    "  else if(nav==='routines') { showRoutinesForAgent(null); }",
    "  else if(nav==='routines') { }"],

  // ===== THE SKILLS PANE =====
  // It had none of this until now: renderSkills returned before rendering, so
  // a workspace with no skills had no pane at all.
  [SKILLS_VIEW, 'a workspace with no skills gets a pane rather than a blank one',
    '  if (!skillsHaveArrived() || !skills.length) {\n    renderSkillsEmpty(!skillsHaveArrived());\n    return;\n  }\n',
    '  if (!skills.length) return;\n'],
  [SKILLS_VIEW, 'the pane waits for the reply rather than reading nothing as none',
    '    renderSkillsEmpty(!skillsHaveArrived());',
    '    renderSkillsEmpty(false);'],
  [SKILLS_VIEW, 'the pane offers the build only where a guide can fulfil it',
    '  if (state.action) {',
    '  if (true) {'],
  [SKILLS_VIEW, 'the pane names the guide the workspace has rather than a literal',
    "    guideName: guide ? (guide.displayName || guide.name || null) : null,",
    "    guideName: guide ? 'Doc' : null,"],
  [SKILLS_MODEL, 'the pane claims nothing about skills that have not arrived',
    '    if (input && input.loading) {\n'
    + '      return { lead: null, body: editor.STEP_LEADS.loading, action: null, aside: null };\n    }\n',
    ''],
  [SKILLS_MODEL, 'the next step swaps with the guide rather than disappearing',
    "    return name ? EMPTY.nextStep.replace('{agent}', name) : EMPTY.nextStepNoGuide;",
    "    return name ? EMPTY.nextStep.replace('{agent}', name) : '';"],
  [SKILLS_MODEL, 'the guide is named through a slot rather than as a literal',
    "    return name ? EMPTY.nextStep.replace('{agent}', name) : EMPTY.nextStepNoGuide;",
    '    return name ? EMPTY.nextStep : EMPTY.nextStepNoGuide;'],
  [SKILLS_MODEL, 'the mechanism is on every state, ahead of whichever next step it has',
    '      body: `${EMPTY.mechanism} ${nextStep(guideName)}`,',
    '      body: nextStep(guideName),'],
  [SKILLS_MODEL, 'the action goes with the agent that fulfils it',
    '      action: guideName ? EMPTY.action : null,',
    '      action: EMPTY.action,'],

  // ===== THE RAIL IS A MAP OF PLACES =====
  // Each of these is the gate coming back in one of the three shapes it could
  // come back in: hidden in the markup, withdrawn by the routines render, or
  // withdrawn by the skills render.
  [INDEX_RAIL, 'no rail entry is withdrawn in the page it ships in',
    '<button class="nav-item" data-nav="routines" onclick="switchNav(\'routines\')" data-tooltip="Routines">',
    '<button class="nav-item" data-nav="routines" onclick="switchNav(\'routines\')" data-tooltip="Routines"'
    + ' style="display:none">'],
  [VIEW_RAIL, 'the routines render leaves the rail alone',
    '  const list = allRoutines();\n',
    '  const list = allRoutines();\n'
    + '  document.querySelector(\'.nav-item[data-nav="routines"]\').style.display = list.length ? \'\' : \'none\';\n'],
  [SKILLS_VIEW_RAIL, 'the skills render leaves the rail alone',
    '  renderSkillsSidebar(skills);\n',
    '  document.querySelector(\'.nav-item[data-nav="skills"]\').style.display = skills.length ? \'\' : \'none\';\n'
    + '  renderSkillsSidebar(skills);\n'],
  // The sentence is composed rather than escaped as one blob now, so escaping
  // is watched on both of the roads it takes: the plain sentence and the
  // pieces the link is built from.
  [VIEW, 'a routine name reaches the page as text, not as markup',
    '  if (!routineSkill(row.parts.name)) return esc(row.sentence);',
    '  if (!routineSkill(row.parts.name)) return row.sentence;'],
  [VIEW, 'a routine name reaches the link as text, not as markup',
    '${esc(row.parts.name)}</button>',
    '${row.parts.name}</button>'],

  // ===== THE TWO CONTROLS =====
  // The byte check in the delete handler is a backstop against a WRITER that
  // silently removes nothing, which the roster check above it cannot see: the
  // roster and the block addresser are different parsers. So the mutation
  // breaks the writer rather than the check, which is the only way to reach it.
  [ROUTINES, 'a removal that removes nothing is not announced as a deletion',
    '  lines.splice(from, target.end - from);\n',
    ''],
  [HANDLER, 'the roster is invalidated before it is rebroadcast',
    "  ws.send(JSON.stringify(message));\n  ctx.agents.invalidateAgentCache();\n  ws.send(JSON.stringify(rosterMessage()));",
    "  ws.send(JSON.stringify(message));\n  ws.send(JSON.stringify(rosterMessage()));"],
  [HANDLER, 'an agent file outside the workspace is refused',
    "  if (!ctx.workspace.isInsideWorkspace(filePath)) { fail('That agent is outside the workspace.'); return null; }\n",
    ''],
  [ROUTINES, 'the last routine takes the routines key with it',
    '  const from = items.length === 1 ? section.start : target.start;',
    '  const from = target.start;'],
  [ROUTINES, 'a removal takes the block it was asked for and no other',
    '  })[occurrence];\n  if (!target) return content;\n\n  const from',
    '  })[0];\n  if (!target) return content;\n\n  const from'],
  // ===== THE ORDER THE LIST IS READ IN =====
  // Roster order is file order. It is invisible at nine routines and is what
  // makes the view unusable at thirty, and reverting to it is a one-line
  // simplification that reads as tidying.
  [VIEW, 'the list is ordered rather than rendered in the order the roster arrived',
    '  return routinesModel().orderByNextRun(scoped, entry => entry.routine);',
    '  return scoped;'],
  [MODEL, 'paused routines are a band of their own rather than sorted with the rest',
    '      if (f.paused) return 2;',
    ''],
  [MODEL, 'the paused band keeps roster order rather than sorting by an instant it was told does not apply',
    '      return band(a) === 0 ? at(a) - at(b) : 0;',
    '      return at(a) - at(b);'],
  [MODEL, 'the caller keeps the roster order the namesake count was taken over',
    '    return list.slice().sort((a, b) => {',
    '    return list.sort((a, b) => {'],
  // ===== THE SKILL NAME AS A DESTINATION =====
  // The row outlives the skill it names, because the two live in different
  // files. Linking unconditionally offers a page for something that is gone.
  [VIEW, 'the name is a link only where the skill it names still exists',
    '  if (!routineSkill(row.parts.name)) return esc(row.sentence);',
    ''],
  // The sentence is composed from the model's pieces, each escaped alone. Going
  // back to matching the name inside the assembled string is the tidy-looking
  // change that puts user-written text through markup twice.
  [VIEW, 'the pieces are escaped separately rather than the assembled sentence being cut up',
    '  return esc(row.parts.lead)',
    '  return esc(row.sentence).replace(esc(row.parts.name), '],
  // THE PROPERTY MOVED, so the mutation follows it. This used to take the
  // switchNav call out of the jump and leave Routines lit over Skills. The
  // section is a property of the view now: showView resolves it from
  // NAV_FOR_VIEW and sets it, so removing the call from the jump breaks
  // nothing, and a mutation that cannot break the property proves nothing
  // about it. Breaking the resolution itself is what this route's own test has
  // to notice, and it is aimed at that route's suite rather than the router's,
  // because the claim is that THIS jump lands the reader correctly.
  [APP_OPENER, 'the jump sets the rail as well as the pane',
    ' const nav=NAV_FOR_VIEW[v]; if(nav) setNavState(nav); }',
    ' }'],
  [VIEW, 'the skill is resolved again at press time rather than assumed to still be there',
    '  if (!skill) return;',
    ''],
  [MODEL, 'the sentence is built from the pieces rather than beside them',
    '    return parts ? `${parts.lead}${parts.name}` : null;',
    "    return parts ? `${parts.lead}, run: ${parts.name}` : null;"],
  [MODEL, 'the lead carries the space that separates it from the name',
    '    return { lead: `${words}, run: `, name: name };',
    '    return { lead: `${words}, run:`, name: name };'],
  // ===== THE HEADER =====
  // The component, not the size. A view that LISTS things heading itself the
  // way the view that CONFIGURES things does is what this replaced, and going
  // back is a one-line change that reads as removing an indirection.
  [VIEW, 'the header is the component the skills view uses rather than the settings heading',
    '  let h = \'<div class="profile-header">\'',
    '  let h = `<div class="settings-section-title">${esc(routinesModel().LEAD.title)}</div>`;\n  const unused = \'<div class="profile-header">\''],
  [VIEW, 'the glyph is the clock rather than nothing',
    '    + `<div class="profile-avatar skill-avatar">${CLOCK_SVG}</div>`',
    '    + \'<div class="profile-avatar skill-avatar"></div>\''],
  [VIEW, 'the lead sentence is under the title rather than dropped with the paragraph it left',
    '      + (subtitle ? `<div class="routines-subtitle">${esc(subtitle)}</div>` : \'\')',
    "      + ''"],
  [VIEW, 'the empty pane takes its own state line rather than the sentence about a full list',
    '  let h = headerHtml(null)',
    '  let h = listHeaderHtml()'],
  [MODEL, 'the scoped subtitle names the agent rather than repeating the unscoped sentence',
    "      subtitle: agentName ? LEAD.scopedLead.replace('{agent}', () => agentName) : LEAD.lead,",
    '      subtitle: LEAD.lead,'],
  [STYLES, 'the subtitle takes the body size rather than restating the title',
    '.routines-subtitle { font-size: var(--body); color: var(--text-2); line-height: 1.5; margin-top: 2px; }',
    '.routines-subtitle { font-size: var(--title); color: var(--text-2); line-height: 1.5; margin-top: 2px; }'],
  // ===== THE FAILURE QUESTION (RundockRoutinesModel.anyFailure) =====
  // The nav-rail dot this model function used to drive (app.js,
  // updateRoutineFailureBadge) was removed 2026-08-27: it read as distracting
  // in practice. The model function itself stays, tested, in case a quieter
  // signal for this replaces it later, so its own correctness is still worth
  // guarding even with nothing in the UI consuming it today.
  [MODEL, 'only a real failure counts as a failure',
    '    return routines.some(routine => !(routine && routine.paused) && lastCompletedRunFailed(routine));',
    '    return routines.length > 0;'],
  // ===== THE PAUSE CLAUSE AND THE FAILURE QUESTION =====
  [MODEL, 'a paused routine is excluded before the failure question is asked',
    '    return routines.some(routine => !(routine && routine.paused) && lastCompletedRunFailed(routine));',
    '    return routines.some(routine => lastCompletedRunFailed(routine));'],
  // The rail asks about the last completed run and the row asks what happened
  // most recently. Collapsing the rail back onto the row's answer lets an
  // ordinary missed slot hide the only alarming state in the product.
  [MODEL, 'a later missed slot does not mask a failed run on the rail',
    '    return routines.some(routine => !(routine && routine.paused) && lastCompletedRunFailed(routine));',
    "    return routines.some(routine => !(routine && routine.paused) && outcomeOf(routine) === 'failed');"],
  [MODEL, 'the agent name is inserted rather than read as a replacement pattern',
    "      subtitle: agentName ? LEAD.scopedLead.replace('{agent}', () => agentName) : LEAD.lead,",
    "      subtitle: agentName ? LEAD.scopedLead.replace('{agent}', agentName) : LEAD.lead,"],
  // The header reads the one scope the view holds, rather than a notion of its
  // own. Two notions of scope in one file is how a filtered list ends up under
  // an unfiltered sentence.
  [VIEW, 'the header reads the scope the panel actually holds',
    '  if (!scope) return null;',
    '  if (true) return null;'],
  // ===== WHERE A ROUTINE RUNS =====
  // The forbidden act itself: a next-run time drawn against a routine no
  // scheduler is going to fire.
  [MODEL_WORKSPACE, 'a routine nothing is serving is drawn with no next run',
    '    if (!isServed(input)) return null;\n    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);',
    '    const words = timeWords(input && input.nextRun, input && input.now, input && input.zone);'],
  [MODEL_WORKSPACE, 'the row says where Rundock went',
    '      workspaceNote: workspaceNote(input),\n',
    ''],
  [MODEL_WORKSPACE, 'the two workspaces are compared rather than assumed equal',
    '    return mine === serving;',
    '    return true;'],
  [MODEL_WORKSPACE, 'the note names the workspace rather than leaving the slot in',
    "      ? NOT_SERVED.body.replace('{serving}', () => serving)",
    '      ? NOT_SERVED.body'],
  // THE INVERSION, WRITTEN IN. Comparing against the path the window remembers
  // opening calls the served workspace's routines dormant at the moment they
  // are the only ones running. This is the defect the first round shipped, and
  // it is here so it cannot ship again quietly.
  [MODEL_WORKSPACE, 'the comparison is against what the server serves, not what a window remembers',
    '    const serving = input ? input.servingWorkspace : undefined;',
    '    const serving = input ? input.openWorkspace : undefined;'],
  // NEVER TOLD AND TOLD NOTHING ARE DIFFERENT STATES. Collapsing them makes a
  // workspace that has gone look exactly like a window that has heard nothing,
  // and every row goes on promising a run nothing can make.
  [MODEL_WORKSPACE, 'a window told nothing is served is not treated as a window never told',
    '    if (serving === null) return false;',
    '    if (serving === null) return true;'],
  [MODEL_WORKSPACE, 'the header describes the rows it heads, in both states',
    '    if (workspaceName && isServed(input)) {',
    '    if (workspaceName) {'],
  [MODEL_WORKSPACE, 'the header names the workspace the listed routines came from',
    "      workspaceLine = LEAD.workspaceLine.replace('{workspace}', () => workspaceName);",
    '      workspaceLine = null;'],
  [MODEL_WORKSPACE, 'two workspaces of the same name are told apart',
    '    while (say(a, depth) === say(b, depth) && (depth < a.length || depth < b.length)) depth++;',
    ''],
  [DISCOVERY_WORKSPACE, 'the roster carries the workspace a routine was read out of',
    '        r.workspace = ws;\n',
    ''],
  [VIEW_WORKSPACE, 'the row is told which workspace the server is serving',
    '    workspace: r.workspace,\n    servingWorkspace: routinesServingWorkspace(),\n    now: routinesClock(),',
    '    workspace: r.workspace,\n    now: routinesClock(),'],
  // The header used to name the path the window remembered, directly above a
  // list of rows that had come from somewhere else.
  [VIEW_WORKSPACE, 'the header reads the roster it heads rather than the served workspace',
    '    workspace: routinesRosterWorkspace(),\n    servingWorkspace: routinesServingWorkspace(),\n  });',
    '    workspace: routinesServingWorkspace(),\n    servingWorkspace: routinesServingWorkspace(),\n  });'],
  [VIEW_WORKSPACE, 'the three states of the served workspace reach the model intact',
    "  if (typeof servingWorkspacePath === 'undefined') return undefined;\n",
    ''],
  [VIEW_WORKSPACE, 'the note reaches the page',
    "      + `<span class=\"workspace-note\">${esc(row.workspaceNote.text)}</span>`",
    "      + '<span class=\"workspace-note\"></span>'"],
  [VIEW_WORKSPACE, 'the header line reaches the page',
    '    + (workspace ? `<div class="routines-workspace" data-routines-workspace>${esc(workspace)}</div>` : \'\')',
    "    + ''"],
  // THE REDRAW. The notice is the only message a window that did not ask for
  // the switch receives; recording it and drawing nothing leaves every row
  // promising a run until an unrelated event happens to redraw.
  [APP_E2E, 'the switch notice redraws the list it changes the meaning of',
    "    case 'serving_workspace': setServingWorkspace(d.path); renderRoutines(); break;",
    "    case 'serving_workspace': setServingWorkspace(d.path); break;"],
  [APP_E2E, 'the shell records the workspace a switch notice names',
    "    case 'serving_workspace': setServingWorkspace(d.path); renderRoutines(); break;\n",
    ''],
  [APP_E2E, 'the writer keeps the value it was handed',
    "  servingWorkspacePath = typeof path === 'string' && path ? path : null;",
    '  servingWorkspacePath = null;'],
  [APP_E2E, 'the shell records the workspace that arrives beside a roster',
    'setRosterWorkspace(d.workspace); ',
    ''],
  // THE ANNOUNCE, AT THE ONE PLACE EVERY WORKSPACE CHANGE REACHES. Removing it
  // takes every window that did not ask back to being told nothing; the
  // rollback is a call to the same function, so it retracts by construction.
  [ROOT_SERVER, 'every workspace change is announced to every window',
    '  announceServingWorkspace(dir);\n}',
    '}'],
  [ROOT_SERVER, 'the announcement names the workspace actually being served',
    "  safeSend(JSON.stringify({ type: 'serving_workspace', path: dir || null }));",
    "  safeSend(JSON.stringify({ type: 'serving_workspace', path: null }));"],
  [DISCOVERY_WORKSPACE, 'the roster message carries the workspace it was read from',
    '    workspace: getWorkspace(),\n',
    ''],

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
  const targets = [MODEL, VIEW, VIEW_E2E, VIEW_REPLY, VIEW_RAIL, STYLES, SCHEDULER, END_TO_END,
    DISCOVERY, HANDLER, ROUTINES, APP, APP_SKILLS, APP_OPENER, INDEX, INDEX_RAIL, SKILLS_MODEL, SKILLS_VIEW,
    SKILLS_VIEW_RAIL, PANEL, SCOPE_MODEL, INDEX_PANEL, APP_PANEL, STYLES_PANEL, VIEW_SCOPE,
    PANEL_PRESS, APP_DISPATCH, VIEW_CONFIRM, APP_WORKSPACE, EDITOR_NAV,
    TEAM_PANEL, INDEX_SWEEP, PROFILE_BOXES, PROFILE_ROUTE,
    GUIDE_COPY_MOD, TEAM_COPY, PROFILE_COPY, TEAM_DOOR, SIDEBAR_CSS,
    MODEL_WORKSPACE, VIEW_WORKSPACE, DISCOVERY_WORKSPACE, APP_E2E, ROOT_SERVER,
    EDIT_DOOR, EDIT_DOOR_ROW, SCHEDULER_EDIT];
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
