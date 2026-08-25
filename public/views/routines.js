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

// Which routine the reader has asked to delete, BY IDENTITY: the agent that
// declares it, its name, and which of that agent's routines of that name it
// is. Held here rather than on the element because a routine's name is
// user-written text and an identifier built out of it has to be escaped into
// an attribute, unescaped out of one, and matched again on the server.
//
// IT WAS A POSITION, AND A POSITION IS NOT AN IDENTITY once the list this
// indexes into can change under an open confirmation. It can: the panel
// filters it by scope, so pressing a scope row while a confirmation is open
// re-resolved that index against a different set of routines. The
// confirmation went on naming the routine the reader pressed Delete on while
// the server was told to remove whatever had moved into that position. A
// confirmation that names one thing and acts on another is worse than no
// confirmation, because the dialogue is specific and wrong.
//
// This is the same triple the delete message carries and the same one the
// namesake ruling settled on, so the thing being confirmed, the thing being
// drawn and the thing being sent are one value rather than three that agree
// while nothing moves.
let pendingDelete = null;

// What the server said when it refused the last pause or delete, or null.
//
// IT IS HELD HERE BECAUSE THIS IS THE SCREEN THAT ASKED. A refused action used
// to answer on the save road, which posts to the conversation transcript and
// calls the editor's save-failure callback, so the reader pressed a control on
// this list and the only reply appeared somewhere else. An answer belongs to
// the surface the question was asked on.
let pendingProblem = null;

// THE SCOPE IS NOT HELD HERE. It belongs to the panel that draws the scope
// rows, because that panel decides which agents are offered at all and drops a
// selection the moment it stops drawing the row carrying it. Two branches each
// grew a scope of their own and a merge that kept both would filter this list
// twice against two values that agree only while nothing moves. There is one,
// it is read through routinesScopeAgentId(), and the way in sets it through
// setRoutinesScope().

// The clock, taken from the global so a test can supply one. Undeclared
// identifiers are safe under typeof, so this works when the module is
// required in node with no global at all.
function routinesClock() {
  return typeof routinesNow === 'function' ? routinesNow() : new Date();
}

/**
 * The workspace the server's scheduler is serving, taken from the global the
 * shell keeps.
 *
 * NOT `currentWorkspacePath`, and the difference is the whole of what this
 * list gets right. That one is the workspace this WINDOW asked to open, and
 * another window can move the server out from under it. This one is written
 * only from values the server produced, which is the same string discovery
 * stamps on every routine, so the comparison below is between two copies of
 * one value.
 *
 * Read through typeof for the same reason the clock is: this file is required
 * in node with no global at all, and an undeclared identifier throws where a
 * typeof does not.
 */
function routinesServingWorkspace() {
  return typeof servingWorkspacePath === 'string' ? servingWorkspacePath : null;
}

/**
 * The workspace the routines being listed were read out of.
 *
 * ONE VALUE FOR THE WHOLE ROSTER, because a roster is only ever read from one
 * workspace: discovery stamps every routine it reads with the root it read
 * them from. Taken off the rows rather than from a global so it describes what
 * is actually on screen, which is the fault the header carried before: it
 * named the workspace the window remembered, directly above a list of rows
 * that had come from somewhere else.
 */
function routinesRosterWorkspace() {
  const roster = typeof agents !== 'undefined' && agents ? agents : [];
  for (const agent of roster) {
    for (const routine of (agent && agent.routines) || []) {
      if (routine && typeof routine.workspace === 'string' && routine.workspace) return routine.workspace;
    }
  }
  return null;
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
 * AND THE COUNT IS TAKEN BEFORE EITHER THE SCOPE OR THE ORDER IS APPLIED,
 * which is why the three steps are in this order rather than folded together.
 * The occurrence a delete is addressed by is a position in the FILE, not a
 * position in whatever subset the panel is showing and not a position in the
 * order a reader sees. Counting after the filter or the sort would send the
 * server the row's position on screen wearing the name of its position in the
 * file, and the confirmation would name one routine while the server removed
 * another.
 *
 * WHICH SCOPE IS THE PANEL'S DECISION and it is read rather than kept, so
 * there is one scope on the screen rather than two that agree until one of the
 * two surfaces is redrawn on its own.
 *
 * THE ORDER ITSELF IS THE MODEL'S DECISION, not this file's, for the same
 * reason every word on a row is: a rule written inline in a flatten is
 * reachable only by a browser. It runs last, over whatever the scope left,
 * because a filtered list still has to read soonest first.
 */
function allRoutines() {
  const out = [];
  const roster = typeof agents !== 'undefined' && agents ? agents : [];
  for (const agent of roster) {
    if (!agent.routines) continue;
    const seen = {};
    for (const routine of agent.routines) {
      const occurrence = seen[routine.name] || 0;
      seen[routine.name] = occurrence + 1;
      out.push({ routine, agent, occurrence });
    }
  }
  const scope = typeof routinesScopeAgentId === 'function' ? routinesScopeAgentId() : null;
  const scoped = scope ? out.filter(entry => entry.agent.id === scope) : out;
  return routinesModel().orderByNextRun(scoped, entry => entry.routine);
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
    // PASSED AS THE FILE ANSWERED IT, not coerced. The model reads an explicit
    // false and nothing else, so a roster that did not carry the field must
    // arrive here as undefined rather than as a routine somebody switched off.
    enabled: r.enabled,
    // The scheduler's own verdict on this routine's schedule, carried on the
    // roster. Passed through untouched: a client that decided this for itself
    // would be a second copy of a grammar that lives beside the tick.
    scheduleReadable: r.scheduleReadable,
    // The workspace this routine was read out of, and the one the server is
    // serving. Both are the server's own value, compared by the model rather
    // than assumed equal here.
    workspace: r.workspace,
    servingWorkspace: routinesServingWorkspace(),
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
  // A ROUTINE THAT WILL NEVER FIRE SAYS SO, on its own line and in its own
  // tone, because it is the only state on this list that is a fault in the
  // routine rather than a fact about its history. It is drawn on the delete
  // confirmation too, unlike the controls: somebody about to remove a routine
  // is entitled to know it was never going to run.
  if (row.scheduleProblem) {
    body += '<div class="rr-meta rr-problem-line">'
      + `<span class="schedule-problem">${esc(row.scheduleProblem.text)}</span>`
      + '</div>';
  }
  // A ROUTINE NOTHING IS SERVING SAYS WHERE RUNDOCK WENT. Drawn on its own
  // line and toned unlike the schedule fault above: nothing about the routine
  // is wrong, so it takes the quiet tone the missed row uses rather than the
  // danger one. Drawn on the delete confirmation too, for the same reason the
  // schedule fault is: somebody about to remove a routine is entitled to know
  // it was not running.
  if (row.workspaceNote) {
    body += '<div class="rr-meta rr-note-line">'
      + `<span class="workspace-note">${esc(row.workspaceNote.text)}</span>`
      + '</div>';
  }
  // THE ROW FOR A ROUTINE NOBODY HAS TURNED ON YET. It takes the next-run
  // line's place rather than sitting beside it, because the model returns no
  // next run for this state: a routine that will not run must not advertise
  // when it will. Withheld on the delete confirmation, like every other
  // control there: that surface is a question, not a list.
  //
  // The model withholds the offer entirely on a row where something else also
  // stops the routine, so this never draws a control whose consequence the row
  // cannot state truthfully.
  if (row.offer && withActions) {
    body += '<div class="rr-meta rr-offer-line">'
      + `<span class="rr-offer-text">${esc(row.offer.text)}</span>`
      + `<button class="btn-link rr-enable" type="button" data-routines-action="enable"`
      + ` onclick="routinesSetEnabled(${index}, true)">${esc(row.offer.label)}</button>`
      + '</div>';
  }
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
 * ONE SCOPE, READ THROUGH THE ONE ACCESSOR. This asks `routinesScopeAgentId()`
 * because the list above asks it: a subtitle resolved from a second notion of
 * scope would agree with the rows only until one of the two surfaces was
 * redrawn on its own, and a filtered list under an unfiltered sentence reads
 * as a list that has lost rows. That is the exact reading the subtitle exists
 * to prevent, so it must not be the thing the subtitle causes.
 *
 * The NAME is resolved from the roster rather than stored beside the id, so a
 * rename reaches the sentence on the next broadcast without anything here
 * holding a stale copy of it. An id that matches no agent says nothing, which
 * leaves the unscoped sentence: better a true general sentence than a
 * specific one with a hole in it.
 */
function routinesScopeName() {
  const scope = typeof routinesScopeAgentId === 'function' ? routinesScopeAgentId() : null;
  if (!scope) return null;
  const roster = typeof agents !== 'undefined' && agents ? agents : [];
  const agent = roster.filter(a => a && a.id === scope)[0];
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
 * `subtitle` is passed in rather than resolved here because the list header
 * and the empty pane's header are the same call with a different argument:
 * the list passes its scoped sentence, and the empty pane passes nothing,
 * because its state line lives in the box below rather than in the header.
 */
function headerHtml(subtitle, workspace) {
  const model = routinesModel();
  let h = '<div class="profile-header">'
    + `<div class="profile-avatar skill-avatar">${CLOCK_SVG}</div>`
    + `<div><div class="profile-name">${esc(model.LEAD.title)}</div>`
    + (subtitle ? `<div class="routines-subtitle">${esc(subtitle)}</div>` : '')
    + (workspace ? `<div class="routines-workspace" data-routines-workspace>${esc(workspace)}</div>` : '')
    + '</div></div>';
  // On the header rather than in one of the three branches below, so the
  // refusal is on the page whichever state the list is in when it arrives.
  if (pendingProblem) {
    h += `<p class="routines-problem" role="alert" data-routines-problem>${esc(pendingProblem)}</p>`;
  }
  return h;
}

/**
 * The header a list of routines carries, scoped or not.
 *
 * WHOSE ROUTINES THESE ARE, ON THE HEADER RATHER THAN ON EACH ROW. It is one
 * fact about the whole list, and a reader with three workspaces otherwise has
 * to read it off the window.
 *
 * ON THE LIST AND NOT ON THE EMPTY PANE, which is the one caller that passes
 * no subtitle. "These are the routines in Ledger" above "No routines yet"
 * describes a list that is not there, and the empty pane's whole shape is one
 * box carrying what is true and what to do about it.
 */
function listHeaderHtml() {
  const head = routinesModel().header({
    agentName: routinesScopeName(),
    workspace: routinesRosterWorkspace(),
    servingWorkspace: routinesServingWorkspace(),
  });
  return headerHtml(head.subtitle, head.workspace);
}

// The one thing each variant offers, and where pressing it goes. Held as a
// table rather than as a branch in the template, so a variant added later has
// to name its handler here rather than growing a third ternary inside markup.
//
// `add` opens the picker that spans every agent's skills and names which agent
// runs each one. `build-skill` opens a conversation with the guide, which is
// what the routine editor's own zero-skills offer already does.
//
// NEITHER CARRIES AN ARROW. No other call to action in the app does, so a
// control decorated differently from every other control of its kind would
// read as a different kind of control.
const EMPTY_ACTIONS = {
  'add-routine': { marker: 'add', onclick: 'addRoutine()' },
  'build-skill': { marker: 'build-skill', onclick: 'routineEditorBuildSkill()' },
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

  // THE STATE LINE IS IN THE BOX, WITH THE ACTION IT BELONGS BESIDE. It used
  // to be the header's subtitle, so the pane read as a loose sentence sitting
  // above a card rather than as one thing. The header carries the title only
  // now; the box carries the whole message, what is true and what to do about
  // it, in one place.
  let h = headerHtml(null)
    + '<div class="settings-card flow routines-empty-card">'
    + `<p class="routines-empty-state">${esc(state.lead)}</p>`
    + `<p class="settings-lead">${esc(state.body)}</p>`;
  if (action && state.action) {
    h += '<div class="card-actions routines-empty-actions">'
      + `<button class="settings-btn-primary" type="button" data-routines-action="${action.marker}"`
      + ` onclick="${action.onclick}">${esc(state.action)}</button>`
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
  // A FILTER WITH NOTHING LEFT TO SHOW IS DROPPED RATHER THAN DRAWN EMPTY,
  // and that rule is not repeated here because it cannot be reached from here.
  // The scope only survives resolveScope while its agent still owns a routine,
  // so a surviving scope always has something to show and an empty list always
  // means the team has nothing scheduled, which is what the empty state says.
  // Written again here it would be a second rule with a different trigger
  // doing one job, which is how two rules end up disagreeing.
  const list = allRoutines();
  const content = document.getElementById('routines-content');
  if (!content) return;
  // RESOLVED AGAINST THE LIST AS IT NOW STANDS, every draw. A routine that is
  // no longer here has no confirmation, whether it went because the server
  // removed it or because the panel stopped showing it, and either way the
  // reader is returned to the list rather than shown a question about
  // something they can no longer see.
  const pending = pendingEntry(list);
  if (!pending) pendingDelete = null;
  if (pending) content.innerHTML = confirmHtml(pending, list.indexOf(pending));
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
 * It names no section. The section is a property of the view now: `showView`
 * resolves it from NAV_FOR_VIEW in app.js, so a destination cannot forget it
 * because it no longer does it. This used to set the rail itself, which is the
 * arrangement every route that got the rail wrong was using.
 *
 * @param {string|null} agentId
 */
function showRoutinesForAgent(agentId) {
  // ARRIVING CLEARS THE PENDING CONFIRMATION, AND THAT IS NOT TIDINESS. A
  // confirmation belongs to the list it was raised on, and this is a reader
  // leaving that list. It is no longer true that a stale one could be re-aimed
  // by navigating: `pendingDelete` carries the routine's identity rather than
  // its position, so it can only ever resolve to the routine it was raised on
  // or to nothing. What is still true is that a destructive question the
  // reader has walked away from must not be waiting when they arrive, because
  // a question re-presented is one answered without being re-read.
  //
  // The refusal goes with it, for the reason it is held at all: it answers a
  // control pressed on a list the reader has now left.
  pendingDelete = null;
  pendingProblem = null;
  if (typeof showView === 'function') showView('routines');
  // ONE SCOPE, SET WHERE IT LIVES. setRoutinesScope stores it and redraws both
  // the rows and the list, so the panel and the pane cannot disagree about
  // what is being shown. A shell without the panel still gets its list.
  if (typeof setRoutinesScope === 'function') setRoutinesScope(agentId);
  else renderRoutines();
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

/**
 * The entry a pending confirmation is about, or nothing.
 *
 * routinesAskDelete turns the position the reader pressed into an identity, at
 * the moment they press it. This matches on that identity and nothing else, so
 * no later reorder or filter of this list can change the subject of a question
 * that has already been asked.
 */
function pendingEntry(list) {
  if (!pendingDelete) return null;
  const found = list.filter(entry => entry.agent.id === pendingDelete.agentId
    && entry.routine.name === pendingDelete.name
    && entry.occurrence === pendingDelete.occurrence);
  return found.length ? found[0] : null;
}

function routinesAskDelete(index) {
  const entry = allRoutines()[index];
  pendingProblem = null;
  pendingDelete = entry
    ? { agentId: entry.agent.id, name: entry.routine.name, occurrence: entry.occurrence }
    : null;
  renderRoutines();
}

function routinesCancelDelete() {
  pendingProblem = null;
  pendingDelete = null;
  renderRoutines();
}

function routinesConfirmDelete() {
  // SENT FROM THE IDENTITY THAT WAS CONFIRMED, not from a fresh lookup by
  // position. The reader answered a question about one routine, so that is
  // the routine that goes.
  const target = pendingDelete;
  pendingProblem = null;
  pendingDelete = null;
  if (target && typeof ws !== 'undefined' && ws) {
    ws.send(JSON.stringify({
      type: 'delete_routine', agentId: target.agentId, name: target.name, occurrence: target.occurrence,
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

/**
 * Ask the server to set one boolean field on the routine under `index`.
 *
 * ONE SEND PATH FOR BOTH CONTROLS. The refusal-clearing guard and the
 * occurrence-carrying message shape were written twice, once per control, and
 * the mutation harness had to grow a second row purely to watch the copy. The
 * occurrence is the load-bearing part: a name does not identify a routine, and
 * a message that dropped it would act on the first namesake whatever the
 * reader pointed at.
 */
function routinesSetFlag(index, type, field, value) {
  const entry = allRoutines()[index];
  pendingProblem = null;
  if (!entry || typeof ws === 'undefined' || !ws) return;
  ws.send(JSON.stringify({
    type, agentId: entry.agent.id, name: entry.routine.name,
    occurrence: entry.occurrence, [field]: value,
  }));
}

/**
 * Turn a routine on, for the reader who has just met one the upgrade held back.
 *
 * A SEPARATE MESSAGE FROM PAUSE, and it has to be. Pause is a decision this
 * reader already took and can take back; `enabled` is the answer to a question
 * nobody had asked them yet. Folding the two into one field would make
 * resuming a paused routine and consenting to run a routine that predates the
 * scheduler the same act, and the file would then have no way to say which of
 * the two a user actually did.
 */
function routinesSetEnabled(index, enabled) {
  routinesSetFlag(index, 'set_routine_enabled', 'enabled', enabled);
}

function routinesSetPaused(index, paused) {
  routinesSetFlag(index, 'set_routine_paused', 'paused', paused);
}

return {
  renderRoutines, showRoutinesForAgent,
  routinesAskDelete, routinesCancelDelete, routinesConfirmDelete, routinesSetPaused, routinesSetEnabled,
  routinesOpenSkill,
  routinesActionFailed, routinesActionCleared, routinesViewLastRun,
};
}));
