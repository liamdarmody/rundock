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
 * AND THE COUNT IS TAKEN BEFORE THE SCOPE IS APPLIED, which is why the two
 * steps are in this order rather than folded together. The occurrence a delete
 * is addressed by is a position in the FILE, not a position in whatever subset
 * the panel is showing. Counting after the filter would send the server the
 * row's position on screen wearing the name of its position in the file, and
 * the confirmation would name one routine while the server removed another.
 *
 * WHICH SCOPE IS THE PANEL'S DECISION and it is read rather than kept, so
 * there is one scope on the screen rather than two that agree until one of the
 * two surfaces is redrawn on its own.
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
  return scope ? out.filter(entry => entry.agent.id === scope) : out;
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
  const sentence = row.sentence || r.name;
  const sep = '<span class="sep">&middot;</span>';
  const nextRun = row.nextRun
    ? `<span class="${row.nextRun.className}">${esc(row.nextRun.text)}</span>`
    : '';

  let meta = esc(row.meta || '');
  if (row.runsOn) meta += `${sep}${esc(row.runsOn)}`;
  // Revision 6's shape: with nothing to say about a last run, next-run stays
  // on the meta line and the row is one line tall.
  if (!row.status && nextRun) meta += `${sep}${nextRun}`;

  let body = `<div class="rr-sentence">${esc(sentence)}</div><div class="rr-meta">${meta}</div>`;
  // Revision 7's second line. Both facts, together, because they answer the
  // one question a reader has after a miss or a failure: did it recover, and
  // when does it try again.
  if (row.status) {
    body += '<div class="rr-meta rr-run-line">'
      + `<span class="run-status ${row.status.tone}">${esc(row.status.text)}</span>`
      + (nextRun ? `${sep}${nextRun}` : '')
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

function headerHtml() {
  const model = routinesModel();
  let h = `<div class="settings-section-title">${esc(model.LEAD.title)}</div>`;
  // On the header rather than in one of the three branches below, so the
  // refusal is on the page whichever state the list is in when it arrives.
  if (pendingProblem) {
    h += `<p class="routines-problem" role="alert" data-routines-problem>${esc(pendingProblem)}</p>`;
  }
  return h;
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

  let h = headerHtml()
    + `<p class="settings-lead routines-empty-lead">${esc(state.lead)}</p>`
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
  return headerHtml()
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
  const model = routinesModel();
  return headerHtml()
    + `<p class="settings-lead routines-lead">${esc(model.LEAD.lead)}</p>`
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
  const list = allRoutines();
  const content = document.getElementById('routines-content');
  if (!content) return;
  if (pendingDelete !== null && !list[pendingDelete]) pendingDelete = null;
  if (pendingDelete !== null) content.innerHTML = confirmHtml(list[pendingDelete], pendingDelete);
  else if (list.length === 0) content.innerHTML = emptyHtml();
  else content.innerHTML = listHtml(list);
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
  renderRoutines, routinesAskDelete, routinesCancelDelete, routinesConfirmDelete, routinesSetPaused,
  routinesActionFailed, routinesActionCleared,
};
}));
