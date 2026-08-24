'use strict';
// The routines list: every scheduled skill across the team, what happened to
// it last time, and when it runs next.
//
// WHAT THIS FILE DECIDES AND WHAT IT DOES NOT. Every word and every tone comes
// from public/routines-model.js, which has no DOM in it and can therefore be
// asserted line by line. This file turns that data into markup and wires the
// controls. The split is the same one the routine editor made, for the same
// reason: a copy rule written inline in a render is reachable only by a
// browser, and "the missed row names the cause rather than the routine"
// becomes a screenshot instead of a test.
//
// THE ONE THING IT DOES DECIDE is which of the two row shapes to draw. A
// routine with no completed run yet stays the single line revision 6 drew,
// with its next run on the meta line. A routine with a last-run fact gets the
// second line revision 7 added, which pairs that fact with the next-run time
// so neither is dropped to make room for the other.
//
// THE CLOCK AND THE ZONE ARE READ THROUGH THE GLOBAL, once per render, and
// passed down. A view that read the machine clock inside every row could only
// be tested near the times it happened to run, and this project found seven
// tests yesterday whose result depended on the box underneath them.
//
// The same UMD pattern as views/skills.js: node-requireable, window-attached,
// and republished on the root because the generated onclick handlers and the
// WebSocket dispatch reach these by name.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockRoutinesView = factory();
    Object.assign(root, root.RundockRoutinesView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// Which routine the reader has asked to delete, as its position in the list
// below. Held here rather than on the element because a routine's name is
// user-written text and an identifier built out of it has to be escaped into
// an attribute, unescaped out of one, and matched again on the server.
let pendingDelete = null;

// What the server said when it refused the last pause or delete, or null.
//
// IT IS HELD HERE BECAUSE THIS IS THE SCREEN THAT ASKED. A refused action used
// to answer on the save road, which posts to the conversation transcript and
// calls the editor's save-failure callback, so the reader pressed a control on
// this list and the only reply appeared somewhere else. An answer belongs to
// the surface the question was asked on.
let pendingProblem = null;

// Which agent the list is scoped to, or null for the whole team.
//
// IT BELONGS TO THE WAY IN RATHER THAN TO THE VIEW. A row in an agent's
// profile asks for that agent's routines; the rail asks for everybody's. Both
// arrive through the one destination function below, which is what makes the
// scope impossible to leave behind: a route that does not name an agent clears
// it, because it passes null rather than because somebody remembered to.
let scopeAgentId = null;

// The clock, taken from the global so a test can supply one. Undeclared
// identifiers are safe under typeof, so this works when the module is
// required in node with no global at all.
function routinesClock() {
  return typeof routinesNow === 'function' ? routinesNow() : new Date();
}

function routinesZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch (e) {
    // A runtime with no zone database says nothing rather than guessing one.
    return null;
  }
}

function routinesModel() {
  return typeof RundockRoutinesModel !== 'undefined' ? RundockRoutinesModel : null;
}

/**
 * Every routine on the team, flattened, with the agent that declares it and
 * WHICH OF THAT AGENT'S ROUTINES OF THAT NAME IT IS.
 *
 * NOTHING MAKES A ROUTINE NAME UNIQUE WITHIN A FILE, and the writer counts
 * namesakes deliberately so a second can be created through this interface. A
 * name alone therefore does not identify a routine, and a delete that sent one
 * would act on the first block of that name whatever the reader pointed at.
 * That is worse than an unlabelled delete: the confirmation names one routine
 * and the server removes another, so the dialogue is specific and wrong.
 *
 * The count runs in roster order, which is file order, so the nth namesake
 * here is the nth block in the file.
 *
 * AND THE COUNT IS TAKEN BEFORE THE LIST IS ORDERED, which is why the two
 * steps are in this order rather than folded together. The list a reader sees
 * is sorted by next run; the occurrence a delete is addressed by is a position
 * in the FILE. Counting after the sort would send the server the row's
 * position on screen wearing the name of its position in the file, and the
 * confirmation would name one routine while the server removed another.
 *
 * THE ORDER ITSELF IS THE MODEL'S DECISION, not this file's, for the same
 * reason every word on a row is: a rule written inline in a flatten is
 * reachable only by a browser.
 */
function allRoutines() {
  const out = [];
  const roster = typeof agents !== 'undefined' && agents ? agents : [];
  for (const agent of roster) {
    if (scopeAgentId && agent.id !== scopeAgentId) continue;
    if (!agent.routines) continue;
    const seen = {};
    for (const routine of agent.routines) {
      const occurrence = seen[routine.name] || 0;
      seen[routine.name] = occurrence + 1;
      out.push({ routine, agent, occurrence });
    }
  }
  return routinesModel().orderByNextRun(out, entry => entry.routine);
}

const ICONS = {
  pause: '<path d="M10 4H7v16h3z"/><path d="M17 4h-3v16h3z"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  trash: '<polyline points="3 6 5 6 21 6"/>'
    + '<path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
};

function iconButton(action, label, paths, onclick, danger) {
  return `<button class="icon-btn${danger ? ' danger' : ''}" type="button" title="${label}"`
    + ` aria-label="${label}" data-routines-action="${action}" onclick="${onclick}">`
    + '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
    + ` stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths}</svg></button>`;
}

/**
 * The skill a routine names, or nothing.
 *
 * A ROUTINE CAN NAME A SKILL THAT NO LONGER EXISTS. The routine is written
 * into an agent's file and the skill is declared somewhere else entirely, so
 * deleting the skill leaves the routine naming it. That is not a broken row:
 * the routine is still real and still scheduled, so it keeps its sentence and
 * loses only the link.
 *
 * The list is read through the same global the empty state reads, and an
 * unarrived list resolves nothing rather than guessing, so the sentence is
 * plain for the beat before the reply lands and reachable after it.
 */
function routineSkill(name) {
  const list = typeof skills !== 'undefined' && skills ? skills : [];
  return list.filter(s => s && s.name === name)[0] || null;
}

/**
 * The row's sentence, with the skill name reachable where the skill exists.
 *
 * THE NAME IS PUT IN ITS OWN ELEMENT RATHER THAN FOUND AGAIN IN THE MARKUP.
 * The model hands over the sentence in pieces, each escaped on its own, so a
 * routine called `<img onerror=...>` or one whose name happens to read like
 * the rest of the sentence cannot reach the page as anything but text.
 *
 * ONLY THE NAME IS THE LINK. The schedule is a fact about the routine and
 * leads nowhere, and underlining the whole sentence would say the row itself
 * is a destination, which it is not.
 *
 * THE HANDLER TRAVELS BY POSITION, like every other control on this row and
 * for the same reason: a skill id is user-adjacent text and an identifier
 * built out of it has to be escaped into an attribute and unescaped out again.
 */
function sentenceHtml(row, fallbackName, index, withActions) {
  if (!row.parts) return esc(row.sentence || fallbackName);
  // The delete confirmation draws a row to say which routine is about to go.
  // It offers nothing, and a link is an offer.
  if (!withActions) return esc(row.sentence);
  if (!routineSkill(row.parts.name)) return esc(row.sentence);
  return esc(row.parts.lead)
    + `<button class="rr-skill-link" type="button" data-routines-action="open-skill"`
    + ` onclick="routinesOpenSkill(${index})">${esc(row.parts.name)}</button>`;
}

/**
 * One row, in whichever of the two shapes its history earns.
 *
 * `withActions` is false in the delete confirmation, where the row is there to
 * say which routine is about to go rather than to offer anything.
 */
function rowHtml(entry, index, withActions) {
  const model = routinesModel();
  const r = entry.routine;
  const a = entry.agent;
  const row = model.row({
    name: r.name,
    schedule: r.schedule,
    agentName: a.displayName || a.name,
    runOn: r.runOn,
    // The moment the run BEGAN, computed by the server. Deliberately not
    // r.state.lastRun, which is when a finished run ENDED.
    lastStart: r.lastStart,
    lastRunStatus: r.state ? r.state.status : null,
    lastSlot: r.lastSlot,
    missedSlot: r.missedSlot,
    nextRun: r.nextRun,
    paused: !!r.paused,
    now: routinesClock(),
    zone: routinesZone(),
  });
  // A schedule the editor never offered has no plain words. The routine is
  // still real and still listed, so it reads as its own name rather than as a
  // sentence the product cannot actually assemble.
  const sentence = sentenceHtml(row, r.name, index, withActions);
  const sep = '<span class="sep">&middot;</span>';
  const nextRun = row.nextRun
    ? `<span class="${row.nextRun.className}">${esc(row.nextRun.text)}</span>`
    : '';

  let meta = esc(row.meta || '');
  if (row.runsOn) meta += `${sep}${esc(row.runsOn)}`;
  // Revision 6's shape: with nothing to say about a last run, next-run stays
  // on the meta line and the row is one line tall.
  if (!row.status && nextRun) meta += `${sep}${nextRun}`;

  let body = `<div class="rr-sentence">${sentence}</div><div class="rr-meta">${meta}</div>`;
  // Revision 7's second line. Both facts, together, because they answer the
  // one question a reader has after a miss or a failure: did it recover, and
  // when does it try again.
  if (row.status) {
    body += '<div class="rr-meta rr-run-line">'
      + `<span class="run-status ${row.status.tone}">${esc(row.status.text)}</span>`
      + (nextRun ? `${sep}${nextRun}` : '')
      // THE WAY INTO THE RUN'S OWN RECORD, and it sits here rather than on the
      // row as a whole because this is the line that carries the last-run
      // fact: the reader who wants to know more is already looking at it.
      //
      // Only where there is a last run to open. A routine that has never run
      // has no record, and an entry point onto nothing is worse than none.
      // Withheld on the delete confirmation for the same reason the pause and
      // delete controls are: that surface is a question, not a list.
      + (withActions
        ? `${sep}<button class="btn-link rr-view-run" type="button" data-routines-action="view-run"`
          + ` onclick="routinesViewLastRun(${index})">View last run</button>`
        : '')
      + '</div>';
  }

  let actions = '';
  if (withActions) {
    actions = '<div class="rr-actions">';
    actions += r.paused
      ? iconButton('resume', 'Resume', ICONS.play, `routinesSetPaused(${index}, false)`, false)
      : iconButton('pause', 'Pause', ICONS.pause, `routinesSetPaused(${index}, true)`, false);
    actions += iconButton('delete', 'Delete', ICONS.trash, `routinesAskDelete(${index})`, true);
    actions += '</div>';
  }

  return `<div class="routine-row${r.paused ? ' paused' : ''}">`
    // An agent with no colour of its own falls back to the idle token rather
    // than to a literal, so the one place that value is written stays the one
    // place it is written.
    + `<div class="avatar sm" style="background:${esc(a.colour || 'var(--idle)')}">${esc(a.icon || '')}</div>`
    + `<div class="rr-body">${body}</div>${actions}</div>`;
}

// The glyph this surface is known by: the clock the rail already draws for
// Routines, so the entry and the page it opens are recognisably the same
// place. Written here in the same box the Skills pane uses for its bolt, which
// is what makes the two views one component rather than two that resemble each
// other.
const CLOCK_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" stroke="none">'
  + '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm1 5v4.4l3.3 2a1 1 0 1 1-1 1.7l-3.8-2.3a1 1 0'
  + ' 0 1-.5-.9V7a1 1 0 0 1 2 0z"/></svg>';

/**
 * The agent this list is scoped to, said as a reader would say it, or nothing.
 *
 * ONE SCOPE, READ WHERE IT IS WRITTEN. This used to read a global of its own,
 * because the thing that sets a scope had not landed yet; it has, and it is
 * `scopeAgentId` above, set by the one destination function every way into
 * this view goes through. Two notions of scope in one file is how a filtered
 * list ends up under an unfiltered sentence, which is the exact reading the
 * subtitle exists to prevent.
 *
 * The NAME is resolved from the roster rather than stored beside the id, so a
 * rename reaches the sentence on the next broadcast without anything here
 * holding a stale copy of it. An id that matches no agent says nothing, which
 * leaves the unscoped sentence: better a true general sentence than a
 * specific one with a hole in it.
 */
function routinesScopeName() {
  if (!scopeAgentId) return null;
  const roster = typeof agents !== 'undefined' && agents ? agents : [];
  const agent = roster.filter(a => a && a.id === scopeAgentId)[0];
  return agent ? (agent.displayName || agent.name || null) : null;
}

/**
 * The header, which is the skills view's header with a clock in it.
 *
 * THE COMPONENT IS THE POINT OF THIS, and the type size is not. The heading
 * this replaced was `.settings-section-title`, borrowed from Settings, and it
 * is already `var(--title)` at weight 700, exactly as `.profile-name` is. So
 * nothing here changes a size. What changes is that a view which LISTS things
 * now heads itself the way every other view that lists things does, instead of
 * the way the view that CONFIGURES things does.
 *
 * `subtitle` is passed in rather than resolved here because the empty pane's
 * subtitle is its own state line, exactly as the Skills pane's is.
 */
function headerHtml(subtitle) {
  const model = routinesModel();
  let h = '<div class="profile-header">'
    + `<div class="profile-avatar skill-avatar">${CLOCK_SVG}</div>`
    + `<div><div class="profile-name">${esc(model.LEAD.title)}</div>`
    + (subtitle ? `<div class="routines-subtitle">${esc(subtitle)}</div>` : '')
    + '</div></div>';
  // On the header rather than in one of the three branches below, so the
  // refusal is on the page whichever state the list is in when it arrives.
  if (pendingProblem) {
    h += `<p class="routines-problem" role="alert" data-routines-problem>${esc(pendingProblem)}</p>`;
  }
  return h;
}

/** The header a list of routines carries, scoped or not. */
function listHeaderHtml() {
  return headerHtml(routinesModel().header({ agentName: routinesScopeName() }).subtitle);
}

// The one thing each variant offers, and where pressing it goes. Held as a
// table rather than as a branch in the template, so a variant added later has
// to name its handler here rather than growing a third ternary inside markup.
//
// `add` opens the picker that spans every agent's skills and names which agent
// runs each one. `build-skill` opens a conversation with the guide, which is
// what the routine editor's own zero-skills offer already does.
const EMPTY_ACTIONS = {
  'add-routine': { marker: 'add', onclick: 'addRoutine()', arrow: true },
  'build-skill': { marker: 'build-skill', onclick: 'routineEditorBuildSkill()', arrow: false },
};

// Whether the skill list has arrived. NOT the same as it being empty: an empty
// list before the reply lands looks exactly like a workspace with nothing to
// schedule, and only one of those two states is an offer. The routine editor
// carries the same guard, and the two must not disagree.
function skillsHaveArrived() {
  return typeof skillsLoaded === 'undefined' || skillsLoaded;
}

function emptyHtml() {
  const model = routinesModel();
  const arrow = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
    + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
    + '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>';
  // WHICH VARIANT IS THE MODEL'S DECISION, not this file's. All this does is
  // hand it what the shell knows: the skills, whether they have arrived, and
  // whether there is a guide to fulfil an offer that names one.
  const guide = typeof getGuide === 'function' ? getGuide() : null;
  const state = model.emptyState({
    skills: typeof skills !== 'undefined' && skills ? skills : [],
    loading: !skillsHaveArrived(),
    // The name rather than a flag, for the same reason the Skills pane passes
    // one: the offer belongs to a named agent, and a workspace with none takes
    // the next step that names no agent at all.
    guideName: guide ? (guide.displayName || guide.name || null) : null,
  });
  const action = state.actionKind ? EMPTY_ACTIONS[state.actionKind] : null;

  // The state line is the subtitle here, as it is on the Skills pane: an empty
  // list is not "every scheduled skill across your team".
  let h = headerHtml(state.lead)
    + '<div class="settings-card flow routines-empty-card">'
    + `<p class="settings-lead">${esc(state.body)}</p>`;
  if (action && state.action) {
    h += '<div class="card-actions routines-empty-actions">'
      + `<button class="settings-btn-primary" type="button" data-routines-action="${action.marker}"`
      + ` onclick="${action.onclick}">${esc(state.action)}${action.arrow ? arrow : ''}</button>`
      + '</div>';
  }
  h += '</div>';
  // The skill-page way in, named without competing for primary weight. Only
  // where that page exists to be named.
  if (state.aside) h += `<p class="settings-caption routines-empty-aside">${esc(state.aside)}</p>`;
  return h;
}

function confirmHtml(entry, index) {
  const model = routinesModel();
  const confirm = model.deleteConfirmation({
    agentName: entry.agent.displayName || entry.agent.name,
    name: entry.routine.name,
    schedule: entry.routine.schedule,
  });
  return listHeaderHtml()
    + `<div class="routine-table routines-confirm-subject">${rowHtml(entry, index, false)}</div>`
    + '<div class="confirm-card">'
    + `<h4>${esc(confirm.title)}</h4><p>${esc(confirm.body)}</p>`
    + '<div class="confirm-actions">'
    // Equal weight on purpose: this is a real fork, not a primary path with an
    // escape hatch.
    + '<button class="settings-btn-danger" type="button" data-routines-action="confirm-delete"'
    + ` onclick="routinesConfirmDelete()">${esc(confirm.confirmLabel)}</button>`
    + '<button class="settings-btn" type="button" data-routines-action="cancel-delete"'
    + ` onclick="routinesCancelDelete()">${esc(confirm.cancelLabel)}</button>`
    + '</div></div>';
}

function listHtml(list) {
  return listHeaderHtml()
    + `<div class="routine-table">${list.map((e, i) => rowHtml(e, i, true)).join('')}</div>`;
}

/**
 * Draw the list.
 *
 * IT DOES NOT DECIDE WHETHER THE RAIL CARRIES A ROUTINES ENTRY, and the
 * absence is the rule rather than an oversight. The entry is permanent, like
 * every other one. The rail names what the app can do: a map of places, always
 * the same size, so a user learns it once. What a place holds is that place's
 * own business, which is this function's, and an empty place says what it is
 * for, which is the empty state below.
 */
function renderRoutines() {
  let list = allRoutines();
  // A FILTER WITH NOTHING LEFT TO SHOW IS DROPPED RATHER THAN DRAWN EMPTY.
  // The empty state speaks for the whole team: it says nothing is scheduled and
  // offers a picker spanning every agent's skills. Under a scope that is a lie,
  // because the emptiness is the filter's doing and other agents still have
  // routines, and nothing on this page names the scope, so a reader has no way
  // to tell. Deleting an agent's last routine from a scoped list is the way in.
  // The scope goes and the whole list is shown, which is true.
  if (scopeAgentId && list.length === 0) {
    scopeAgentId = null;
    list = allRoutines();
  }
  const content = document.getElementById('routines-content');
  if (!content) return;
  if (pendingDelete !== null && !list[pendingDelete]) pendingDelete = null;
  if (pendingDelete !== null) content.innerHTML = confirmHtml(list[pendingDelete], pendingDelete);
  else if (list.length === 0) content.innerHTML = emptyHtml();
  else content.innerHTML = listHtml(list);
}

/**
 * Land the reader on this list, scoped to one agent or to the whole team.
 *
 * THE ONE DESTINATION, USED BY BOTH ROUTES. The rail's own arm calls this with
 * no agent and a routine row on an agent's profile calls it with that agent,
 * so there is one place that decides what arriving here means and one place
 * that can get the rail wrong. A second copy of these three calls is exactly
 * how `openRoutineEditor` ended up lighting Team on a routines surface.
 *
 * It sets the nav state itself, for the same reason `showProfile` does: every
 * function that lands the user on a section says which section, or the rail
 * lies about where the user is on every route whose author did not remember.
 *
 * @param {string|null} agentId
 */
function showRoutinesForAgent(agentId) {
  // ARRIVING CLEARS THE PENDING CONFIRMATION, AND THAT IS NOT TIDINESS.
  // `pendingDelete` is a POSITION in the list, and the scope decides what the
  // list contains, so a confirmation opened under one scope addresses a
  // different routine under the next. The guard in the render only drops the
  // index when it falls off the end, so whenever the new list is long enough
  // the reader is shown a confirmation they never asked for, naming one
  // routine, and confirming it deletes that one. A destructive action must not
  // be re-aimed by navigating.
  //
  // The refusal goes with it, for the reason it is held at all: it answers a
  // control pressed on a list the reader has now left.
  pendingDelete = null;
  pendingProblem = null;
  scopeAgentId = agentId || null;
  if (typeof setNavState === 'function') setNavState('routines');
  if (typeof showView === 'function') showView('routines');
  renderRoutines();
}

/**
 * The server refused the last pause or delete.
 *
 * Rendered where the control was pressed. The words are the server's whenever
 * it sent any, because it knows which of several things went wrong.
 */
function routinesActionFailed(reply) {
  pendingProblem = routinesModel().actionProblem(reply);
  renderRoutines();
}

/**
 * A routine change went through, so last time's refusal is history.
 *
 * Cleared without redrawing: the roster broadcast that follows every
 * successful change is what redraws, and drawing twice would be a flicker for
 * no reason.
 */
function routinesActionCleared() {
  pendingProblem = null;
}

/**
 * Open the skill a row names.
 *
 * THE RAIL IS SET HERE, ON THIS ROUTE, AND ON NO OTHER. `selectSkill` shows
 * the skills view without touching the nav state, so every route into Skills
 * that is not the rail leaves the previous icon lit, and a reader who jumps
 * from here would be looking at Skills with Routines still highlighted. This
 * route is the one this control creates, so it is the one fixed here.
 *
 * The other routes with the same defect are left exactly as they are. They
 * belong to the navigation inventory, which exists so that somebody
 * enumerates every destination and settles the rule once, rather than patching
 * the ones that happen to have been noticed. Five have been noticed; patching
 * them here would leave the same defect on every route nobody has listed yet,
 * and would remove the reason for the enumeration.
 *
 * Resolved again at press time rather than captured when the row was drawn: a
 * skill can be deleted between a render and a click, and a stale id would open
 * a page for something that is gone.
 */
function routinesOpenSkill(index) {
  const entry = allRoutines()[index];
  const skill = entry && routineSkill(entry.routine.name);
  if (!skill) return;
  if (typeof switchNav === 'function') switchNav('skills');
  if (typeof selectSkill === 'function') selectSkill(skill.id);
}

function routinesAskDelete(index) {
  pendingProblem = null;
  pendingDelete = index;
  renderRoutines();
}

function routinesCancelDelete() {
  pendingProblem = null;
  pendingDelete = null;
  renderRoutines();
}

function routinesConfirmDelete() {
  const entry = allRoutines()[pendingDelete];
  pendingProblem = null;
  pendingDelete = null;
  if (entry && typeof ws !== 'undefined' && ws) {
    ws.send(JSON.stringify({
      type: 'delete_routine', agentId: entry.agent.id, name: entry.routine.name, occurrence: entry.occurrence,
    }));
  }
  renderRoutines();
}

/**
 * Open the run detail screen for this routine's most recent run.
 *
 * BY ROUTINE RATHER THAN BY RUN ID, because a row does not have one. The row's
 * last-run fact comes from the routine state, and the run records are a
 * separate store by design: the two meet only where each is told the same
 * thing separately. So the question the reader is asking, "what did this
 * routine do last time", is the question that travels, and the server resolves
 * which record answers it.
 */
function routinesViewLastRun(index) {
  const entry = allRoutines()[index];
  if (!entry) return;
  if (typeof openRunDetail === 'function') openRunDetail(entry.agent.id, entry.routine.name);
}

function routinesSetPaused(index, paused) {
  const entry = allRoutines()[index];
  pendingProblem = null;
  if (!entry || typeof ws === 'undefined' || !ws) return;
  ws.send(JSON.stringify({
    type: 'set_routine_paused', agentId: entry.agent.id, name: entry.routine.name,
    occurrence: entry.occurrence, paused,
  }));
}

return {
  renderRoutines, showRoutinesForAgent,
  routinesAskDelete, routinesCancelDelete, routinesConfirmDelete, routinesSetPaused,
  routinesOpenSkill,
  routinesActionFailed, routinesActionCleared, routinesViewLastRun,
};
}));
