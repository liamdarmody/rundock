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
// The scope, on both sides of it: the filter that applies one and the arm that
// clears it. Both are watched by the file that presses the two routes.
const VIEW_SCOPE = { src: path.join(ROOT, 'public', 'views', 'routines.js'), suite: 'test/unit/routines-view-doors.test.js' };
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
  [HANDLER, 'a pause asks whether the write happened, not whether the bytes moved',
    '  if (!written || written.paused !== paused) {',
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
  [VIEW_REPLY, 'the next action the reader takes clears the last refusal',
    '  const entry = allRoutines()[index];\n  pendingProblem = null;',
    '  const entry = allRoutines()[index];'],
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
    'onclick="showRoutinesForAgent(\'${esc(a.id)}\')"',
    'onclick="showRoutinesForAgent(null)"'],
  [VIEW_SCOPE, 'the list is filtered to the agent it was opened for',
    '    if (scopeAgentId && agent.id !== scopeAgentId) continue;\n',
    ''],
  [VIEW_SCOPE, 'a route that names no agent clears the scope rather than keeping the last one',
    '  scopeAgentId = agentId || null;',
    '  if (agentId) scopeAgentId = agentId;'],

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
  [INDEX_SWEEP, 'the element the listing rendered into went with the listing',
    '      <div class="agent-status-list" id="agent-list"></div>\n',
    '      <div class="agent-status-list" id="agent-list"></div>\n      <div id="sidebar-routines"></div>\n'],

  // ===== WHO DRAWS THIS LIST, AND HOW A READER ARRIVES AT IT =====
  [APP, 'the arriving roster redraws the list',
    'renderOrgChart(); renderRoutines(); renderConvoList();',
    'renderOrgChart(); renderConvoList();'],
  [APP, 'the rail entry draws something into the view it shows',
    "  else if(nav==='routines') { showRoutinesForAgent(null); }",
    "  else if(nav==='routines') { }"],
  [APP, 'the routines section reveals a sidebar the reader can see',
    "const SIDEBAR_FOR = { routines: 'team' };",
    'const SIDEBAR_FOR = {};'],
  [APP, 'the routines panel is one showView knows how to reveal',
    "'settings','routine-editor','routines']",
    "'settings','routine-editor']"],
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
    '  const entry = allRoutines()[pendingDelete];',
    '  const entry = allRoutines()[0];'],
  [VIEW, 'a pause says which routine of its name it means',
    "    occurrence: entry.occurrence, paused,",
    "    occurrence: 0, paused,"],
  [HANDLER, 'which routine of a name is required rather than assumed to be the first',
    '  if (!Number.isInteger(occurrence) || occurrence < 0) {\n    fail(\'Which routine of that name is required.\');\n    return null;\n  }',
    '  if (false) { return null; }'],
  [HANDLER, 'the delete tells the writer which block',
    '  const next = removeRoutineBlock(before, found.name, found.occurrence);',
    '  const next = removeRoutineBlock(before, found.name);'],
  [HANDLER, 'the pause tells the writer which block',
    '  const next = updateRoutineBlock(before, found.name, { paused }, found.occurrence);',
    '  const next = updateRoutineBlock(before, found.name, { paused });'],

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
  [MODEL, 'a miss later than the last run is what happened last',
    '    if (missedSlot && (!started || missedSlot > started)) return \'missed\';',
    '    if (missedSlot) return \'missed\';'],
  [MODEL, 'a run the process died inside is a failure',
    "    if (statusWord === 'failed' || statusWord === 'interrupted') return 'failed';",
    "    if (statusWord === 'failed') return 'failed';"],

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
    '  if (row.status) {',
    '  if (true) {'],
  [VIEW, 'a paused row offers resume rather than pause again',
    "    actions += r.paused\n      ? iconButton('resume', 'Resume', ICONS.play, `routinesSetPaused(${index}, false)`, false)\n      : iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);",
    "    actions += iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);"],
  [VIEW, 'delete asks before it acts',
    'function routinesAskDelete(index) {\n  pendingProblem = null;\n  pendingDelete = index;',
    'function routinesAskDelete(index) {\n  pendingProblem = null;\n  pendingDelete = null;'],
  [VIEW, 'a delete names the routine that was confirmed',
    "      type: 'delete_routine', agentId: entry.agent.id, name: entry.routine.name, occurrence: entry.occurrence,",
    "      type: 'delete_routine', agentId: entry.agent.id, name: 'anything', occurrence: entry.occurrence,"],
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
  [VIEW, 'a routine name reaches the page as text, not as markup',
    '`<div class="rr-sentence">${esc(sentence)}</div>',
    '`<div class="rr-sentence">${sentence}</div>'],

  // ===== THE TWO CONTROLS =====
  // The byte check in the delete handler is a backstop against a WRITER that
  // silently removes nothing, which the roster check above it cannot see: the
  // roster and the block addresser are different parsers. So the mutation
  // breaks the writer rather than the check, which is the only way to reach it.
  [ROUTINES, 'a removal that removes nothing is not announced as a deletion',
    '  lines.splice(from, target.end - from);\n',
    ''],
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
  const targets = [MODEL, VIEW, VIEW_E2E, VIEW_REPLY, VIEW_RAIL, STYLES, SCHEDULER, END_TO_END,
    DISCOVERY, HANDLER, ROUTINES, APP, APP_SKILLS, APP_OPENER, INDEX, INDEX_RAIL, SKILLS_MODEL, SKILLS_VIEW,
    SKILLS_VIEW_RAIL, TEAM_PANEL, INDEX_SWEEP, PROFILE_BOXES, PROFILE_ROUTE, VIEW_SCOPE,
    GUIDE_COPY_MOD, TEAM_COPY, PROFILE_COPY];
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
