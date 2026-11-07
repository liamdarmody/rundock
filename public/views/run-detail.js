'use strict';
// One run's record, on the screen. The first thing in this product that has
// ever read a run record: every run since the observation work has left one
// naming the files it changed, and until now the only way to read one was on
// disk.
//
// WHAT THIS FILE DECIDES AND WHAT IT DOES NOT. Every word comes from
// public/run-detail-model.js, which has no DOM in it and can therefore be
// asserted line by line. This file turns that into markup and wires the way
// in and the way out. The split is the routine editor's and the routines
// list's, for the same reason: a copy rule written inline in a render is
// reachable only by a browser, and "a run whose changes are unknown never says
// it changed nothing" becomes a screenshot instead of a test.
//
// THE THREE ANSWERS ABOUT FILES, and they are three rather than two. A run
// that changed nothing says so. A run whose changes cannot be read says that,
// and says why. A run whose record has not arrived yet says neither, because a
// screen that shows "changed no files" while it is still loading is telling a
// user something false about their routine at the exact moment they are
// deciding whether to trust it.
//
// NO RAW STATUS WORD IS WRITTEN HERE. There is no branch in this file on
// `run.status` at all: the model resolves the words and this file renders
// them. That is the guard, and it is structural rather than a rule somebody
// has to remember.
//
// The same UMD pattern as views/routines.js: node-requireable, window-attached,
// and republished on the root because the generated onclick handlers and the
// WebSocket dispatch reach these by name.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockRunDetailView = factory();
    Object.assign(root, root.RundockRunDetailView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// The colour rule, reached off the global at call time. See
// public/agent-colour.js: escaping stops a value ending its style attribute
// and does nothing about one that stays inside it and is still CSS. Fails
// CLOSED to the fallback when the module is absent.
function agentColour(value, fallback) {
  const safe = fallback === undefined ? 'var(--accent)' : fallback;
  return typeof RundockAgentColour !== 'undefined'
    ? RundockAgentColour.safeColour(value, safe) : safe;
}

// The "Details" control under a failure's plain sentence: the raw words of a
// system error (public/readable-error.js), or nothing when there are none.
// Read at call time off the global, or required under Node.
function errorDetailsHtml(detail) {
  const readableError = (typeof RundockReadableError !== 'undefined') ? RundockReadableError
    : (typeof require === 'function' ? require('../readable-error.js') : null);
  return readableError ? readableError.detailsHtml(detail) : '';
}

// What the reader asked to see, and what came back.
//
// `record` is deliberately three-valued. `undefined` is "the answer has not
// arrived", `null` is "there is no record", and an object is a record. Two of
// those are not the same screen and neither of them is a run that changed
// nothing, which is why this is not a truthiness check anywhere below.
let asked = null;
let record;

// Whether a stop has been asked for on the run currently on screen. Reset
// whenever the screen is opened fresh (openRunDetail) or a new record arrives
// (runArrived): a stale "Stopping…" surviving onto a DIFFERENT run's record
// would tell the reader their stop landed on the wrong one.
let stopRequested = false;

// Which names the screen last drew as opening, so a tree that changes none of
// them redraws nothing (see runDetailTreeUpdated).
let drawnLinks = null;

// The clock, taken from the global so a test can supply one. Undeclared
// identifiers are safe under typeof, so this works when the module is required
// in node with no global at all.
function runDetailClock() {
  return typeof runDetailNow === 'function' ? runDetailNow() : new Date();
}

function runDetailModel() {
  return typeof RundockRunDetailModel !== 'undefined' ? RundockRunDetailModel : null;
}

function escText(value) {
  if (typeof esc === 'function') return esc(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// For a value inside a double-quoted attribute: element escaping plus quotes.
function attrText(value) {
  return escText(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// The workspace the server says is open and the last tree it sent, both kept
// by the shell (app.js). Read at call time; either may not have arrived yet.
function workspaceRoot() {
  return typeof rosterWorkspacePath === 'string' && rosterWorkspacePath ? rosterWorkspacePath : null;
}
function fileTree() {
  return typeof cachedFileTree !== 'undefined' && Array.isArray(cachedFileTree) ? cachedFileTree : null;
}

/** The tree path a recorded path opens, or null where the name stays plain. */
function treePathOf(recorded) {
  const model = runDetailModel();
  return model ? model.treePathFor(recorded, workspaceRoot(), fileTree()) : null;
}

/** For each listed file, the tree path its name opens, or null. */
function linksOf(files) {
  return files && files.known ? files.entries.map(entry => treePathOf(entry.path)) : [];
}

const FILE_ICON = '<svg class="rd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
  + '<polyline points="14 2 14 8 20 8"/></svg>';

// WHICH NAMES OPEN. A record names each file by its whole path on the
// computer that ran the routine, and the Files view opens files by where they
// sit in the tree of the workspace open now. A name opens only where the
// model's treePathFor finds the one in the other, and then it opens the
// tree's own path. Every other name stays plain text, and one sentence under
// the list says which kinds of file those are, drawn only when there is one.
const PLAIN_NAMES = 'Names in plain text can\'t be opened here: hidden files and folders, code and config files, '
  + 'and files that have since been moved or deleted.';
const OPEN_IN_FILES = 'Open in Files';

// The mark beside a note about the list, as the design draws it.
const INFO_ICON = '<svg class="rd-note-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/>'
  + '<line x1="12" y1="8" x2="12.01" y2="8"/></svg>';

const WAITING = 'Reading this run\'s record.';

const BACK = '← Back to Routines';

/** The agent that owns this run, from the roster, or nothing. */
function agentOf(id) {
  if (typeof agents === 'undefined' || !agents) return null;
  return agents.find(a => a && a.id === id) || null;
}

function headHtml(title, agent) {
  const avatar = agent
    ? `<div class="avatar sm" style="background:${agentColour(agent.colour, 'var(--idle)')}">${escText(agent.icon || '')}</div>`
    : '';
  const who = agent ? (agent.displayName || agent.name || agent.id) : null;
  return '<button class="profile-back rd-back" type="button" data-run-detail="back"'
    + ` onclick="runDetailBack()">${escText(BACK)}</button>`
    + `<div class="rd-title">${avatar}<div class="settings-section-title rd-name">${escText(title)}</div></div>`
    + (who ? `<p class="settings-caption rd-context">${escText(who)}</p>` : '');
}

/**
 * A file path with a break opportunity after each separator, never in the
 * middle of a directory or file name.
 *
 * THE CSS ALONE USED TO CARRY THIS, as `word-break: break-all`, which breaks
 * at the nearest character that fits regardless of what the character is: a
 * path several directories deep wrapped mid-word, splitting a name across two
 * lines with nothing to say the two halves belonged together. A `<wbr>` after
 * each separator gives the browser a break point only where a reader would
 * already read one, at a directory boundary, and leaves every name whole.
 *
 * `overflow-wrap: anywhere` stays in the stylesheet as the floor beneath
 * this: the one segment `<wbr>` cannot help, a single name longer than the
 * box itself, still has somewhere to give.
 */
function pathWithBreaks(filePath) {
  return escText(filePath).split(/([/\\])/)
    .map(part => (part === '/' || part === '\\') ? `${part}<wbr>` : part)
    .join('');
}

function filesHtml(files, links) {
  // THREE ANSWERS, AND THE UNKNOWN ONE CARRIES NO LIST TO RENDER. The model's
  // unknown shape has no `entries` key at all, so there is nothing here that
  // could iterate an empty array and draw a confident, wrong answer.
  if (!files.known) {
    return `<div class="rd-files-label">${escText('What it changed')}</div>`
      + '<div class="rd-unknown" data-run-detail="files-unknown">'
      + `<p class="rd-unknown-lead">${escText(files.lead)}</p>`
      + `<p class="rd-unknown-why">${escText(files.reason)}</p></div>`;
  }
  const label = `<div class="rd-files-label">${escText(files.label)}</div>`;
  // THE SHELL NOTE, directly under the label it qualifies, whichever of the
  // three labels that is. Beside files it says the list may be incomplete; on
  // an empty list it stands in place of "This run changed no files.".
  const note = files.shell
    ? `<p class="rd-note" data-run-detail="shell-note">${INFO_ICON}<span>${escText(files.shell)}</span></p>` : '';
  if (!files.entries.length) {
    return label + note
      + (files.empty ? `<p class="rd-empty" data-run-detail="files-empty">${escText(files.empty)}</p>` : '');
  }
  // A NAME THAT OPENS IS A BUTTON, and its handler takes the button and
  // nothing else: the tree path rides in a data attribute, so no path, which
  // a file's name decides, is ever written into script.
  const nameHtml = (entry, i) => (links[i]
    ? `<button class="rd-file-name rd-file-link" type="button" data-run-detail="file-name" data-path="${attrText(links[i])}"`
      + ` title="${attrText(OPEN_IN_FILES)}" onclick="runDetailOpenFile(this)">${escText(entry.name)}</button>`
    : `<span class="rd-file-name" data-run-detail="file-name">${escText(entry.name)}</span>`);
  const rows = files.entries.map((entry, i) => '<div class="rd-file" data-run-detail="file">'
    + FILE_ICON
    + '<div class="rd-file-body">'
    + nameHtml(entry, i)
    + `<span class="rd-file-path">${pathWithBreaks(entry.path)}</span></div>`
    + `<span class="rd-tag" data-run-detail="change">${escText(entry.changeLabel)}</span></div>`).join('');
  return label + note
    + `<div class="rd-files" data-run-detail="files">${rows}</div>`
    + (links.some(link => !link) ? `<p class="rd-cannot-open" data-run-detail="plain-names">${escText(PLAIN_NAMES)}</p>` : '');
}

/**
 * The Stop control, drawn only where `view.state.stoppable` says a run is
 * still going: the model's own answer, per public/run-detail-model.js's "no
 * raw status word leaves this file": this screen never asks whether
 * `record.status === 'running'` itself.
 *
 * TWO STATES, NOT A DISABLED BUTTON THAT LOOKS THE SAME PRESSED OR NOT. A
 * click here cannot confirm the run has stopped: cancelRun only sends the
 * signal, and the ending arrives later on its own clock (see runDetailStop),
 * so the only honest immediate feedback is "asked for", not "done".
 */
function stopHtml(view) {
  if (!view.state.stoppable) return '';
  if (stopRequested) {
    return '<div class="rd-stop-row">'
      + '<button class="settings-btn rd-stop" type="button" data-run-detail="stop" disabled>Stopping…</button>'
      + '</div>';
  }
  return '<div class="rd-stop-row">'
    + '<button class="settings-btn-danger rd-stop" type="button" data-run-detail="stop" onclick="runDetailStop()">Stop this run</button>'
    + '</div>';
}

function detailHtml(view, title, agent, links) {
  const meta = view.duration ? `<p class="settings-caption rd-took">${escText(`Took ${view.duration}.`)}</p>` : '';
  // How many of its cards were refused, beside how long it took: both are
  // facts the server recorded about the run, said only when there is one.
  const refused = view.refused ? `<p class="settings-caption rd-refused" data-run-detail="refused">${escText(view.refused)}</p>` : '';
  // WHEN IT STARTED, said next to the outcome rather than left for the
  // reader to work out from "13 seconds" and a mental subtraction, or not
  // said at all. `view.when` is null only where there is no started moment
  // to report (no record at all), so this renders for every one of the five
  // real outcomes: finished, stopped early, stopped by request, still going,
  // and ending unwitnessed.
  const when = view.when ? `<p class="rd-when" data-run-detail="when">${escText(view.when)}</p>` : '';
  return headHtml(title, agent)
    + '<div class="settings-card rd-card">'
    + `<span class="rd-chip ${escText(view.state.tone)}" data-run-detail="chip">`
    + `<span class="rd-dot"></span>${escText(view.state.chip)}</span>`
    + when
    + `<p class="rd-headline" data-run-detail="headline">${escText(view.state.headline)}</p>`
    + (view.state.guidance
      ? `<p class="rd-guidance" data-run-detail="guidance">${escText(view.state.guidance)}</p>`
        + errorDetailsHtml(view.state.guidanceDetail)
      : '')
    + meta
    + refused
    + stopHtml(view)
    + '</div>'
    + filesHtml(view.files, links);
}

/**
 * Draw the screen.
 *
 * THE WAITING STATE IS ITS OWN, and that is the whole reason `record` is
 * three-valued. Falling through to the model with `undefined` would render
 * "there is no record of this run", which is a claim about the world made
 * before anybody has looked.
 */
function renderRunDetail() {
  const content = document.getElementById('run-detail-content');
  if (!content || !asked) return;
  const agent = agentOf(asked.agentId);
  if (record === undefined) {
    content.innerHTML = headHtml(asked.routine, agent)
      + `<div class="settings-card rd-card"><p class="rd-headline" data-run-detail="waiting">${escText(WAITING)}</p></div>`;
    return;
  }
  const view = runDetailModel().describeRun(record, { now: runDetailClock() });
  const links = linksOf(view.files);
  drawnLinks = JSON.stringify(links);
  // The routine's name comes from the record when there is one and from what
  // was asked for when there is not, so a screen with no record still names
  // what the reader was looking at.
  content.innerHTML = detailHtml(view, view.routine || asked.routine, agent, links);
}

/**
 * A linked name was pressed: open its file in the Files view.
 *
 * ASKED AGAIN AT CLICK TIME. The tree can change between the draw and the
 * click, so the matcher runs once more on the current tree, and a file that
 * has left it opens nothing; the screen is redrawn so the name reads as plain
 * and the sentence under the list says why. What opens is the matcher's
 * answer, the tree's own path.
 */
function runDetailOpenFile(button) {
  const root = workspaceRoot();
  const drawn = button && button.getAttribute('data-path');
  const listed = root && drawn ? treePathOf(`${root}/${drawn}`) : null;
  if (!listed) { renderRunDetail(); return; }
  if (typeof openWorkspaceFilePath === 'function') openWorkspaceFilePath(listed);
}

/**
 * A new file tree arrived. Called from app.js's 'file_tree' case.
 *
 * REDRAWS ONLY WHEN A NAME CHANGES. The client asks for the tree after every
 * file-writing tool call and the server sends it to every client, so most
 * trees change nothing here, and a redraw would take keyboard focus off the
 * name or off Stop each time.
 */
function runDetailTreeUpdated() {
  const model = runDetailModel();
  if (!asked || record === undefined || !model) return;
  const links = linksOf(model.describeRun(record, { now: runDetailClock() }).files);
  if (JSON.stringify(links) !== drawnLinks) renderRunDetail();
}

/**
 * Open the screen for a routine's most recent run.
 *
 * BY ROUTINE RATHER THAN BY RUN ID, because the surface a reader touches is a
 * row on the routines list and a row knows which routine it is, not which run
 * it last had: the row's last-run fact comes from the routine state, and the
 * run records are a separate store by design. The server resolves the newest
 * record for that routine, which is the same question the reader is asking.
 */
function openRunDetail(agentId, routine) {
  asked = { agentId, routine };
  record = undefined;
  stopRequested = false;
  // No section named here: showView resolves it from NAV_FOR_VIEW, which maps
  // run-detail to Routines because a run belongs to a routine.
  if (typeof showView === 'function') showView('run-detail');
  renderRunDetail();
  if (typeof ws !== 'undefined' && ws) ws.send(JSON.stringify({ type: 'get_run', agentId, routine }));
}

/**
 * A record came back.
 *
 * CHECKED AGAINST WHAT WAS ASKED FOR. A reply that arrives after the reader
 * has moved to another routine would otherwise draw one routine's run under
 * another routine's name, which is the specific defect the routines list card
 * was built around: an answer that is correct and lands on the wrong screen.
 */
function runArrived(reply) {
  if (!asked || !reply) return;
  if (reply.agentId !== asked.agentId || reply.routine !== asked.routine) return;
  // `null` is kept as `null`: it means no record, which is a state of its own
  // and is not a run that changed nothing.
  record = reply.run === undefined ? null : reply.run;
  // A PENDING STOP SURVIVES A RECORD THAT STILL SAYS THE RUN IS GOING.
  // cancelRun only sends the signal; the ending arrives later on its own
  // clock (see runDetailStop), so a record that still reads as stoppable is
  // not evidence the stop failed. runDetailRosterUpdated below asks for a
  // fresh record on EVERY roster broadcast while this screen is open on a
  // running run, and a roster broadcast fires on far more than this run
  // ending (any agent's routine starting or ending fires the same message),
  // so a reply arriving mid-stop for an unrelated reason must not be read as
  // "the stop did nothing". Only a record that has actually ended, i.e. is no
  // longer stoppable, clears the flag: that is the one case where sitting on
  // "Stopping…" would be the wrong answer, and it is also stopRequestArrived's
  // own stated contract for what "Stopping…" stays up until.
  const view = runDetailModel() && runDetailModel().describeRun(record, { now: runDetailClock() });
  if (!view || !view.state.stoppable) stopRequested = false;
  renderRunDetail();
}

/**
 * Ask the run on screen to stop.
 *
 * OPTIMISTIC, ON PURPOSE: the button becomes "Stopping…" before any reply
 * arrives, because the alternative is a click that appears to do nothing for
 * however long the round trip takes. stopRequestArrived below corrects course
 * if the ask turns out to have reached nothing.
 */
function runDetailStop() {
  if (!asked || stopRequested) return;
  stopRequested = true;
  renderRunDetail();
  if (typeof ws !== 'undefined' && ws) {
    ws.send(JSON.stringify({ type: 'cancel_routine_run', agentId: asked.agentId, routine: asked.routine }));
  }
}

/**
 * The server's answer to a stop request: only ever "the signal was sent" or
 * "there was nothing running to send it to", never "the run has stopped".
 * See runs.js's handleCancelRoutineRun for why the second half of that is
 * true and stays true here.
 *
 * ONLY THE REFUSAL IS ACTED ON. A `stopped: true` reply changes nothing here:
 * "Stopping…" is already showing, and it stays showing until an actual record
 * says otherwise, which is what runDetailRosterUpdated below is for. A
 * `stopped: false` reply means the assumption behind the button was wrong:
 * nothing was running under that name any more, so the honest move is to ask
 * what the record actually says now, not to sit on a request that landed on
 * nothing.
 */
function stopRequestArrived(reply) {
  if (!asked || !reply) return;
  // Compared in the opposite order from runArrived's own agent/routine guard
  // below: same check, same OR, but the two lines are not byte-identical, so
  // a mutation tool searching this file for one of them by exact text finds
  // one match rather than two. Behaviourally these are the same guard.
  if (reply.routine !== asked.routine || reply.agentId !== asked.agentId) return;
  if (reply.stopped) return;
  stopRequested = false;
  if (typeof ws !== 'undefined' && ws) {
    ws.send(JSON.stringify({ type: 'get_run', agentId: asked.agentId, routine: asked.routine }));
  }
}

/**
 * The roster changed. Called from app.js's 'agents' case, unconditionally,
 * the same as every other view's own refresh there.
 *
 * ASKS AGAIN ONLY WHERE THE ANSWER MIGHT HAVE CHANGED. A roster broadcast
 * fires on far more than this one run ending (any agent's routine starting,
 * ending, or being edited fires the same message), so this re-asks only when
 * this screen is open on a run that was, last it heard, still going. That is
 * also the one case where sitting on a stale record is actually wrong: a
 * "Still going" or "Stopping…" that has in fact ended, shown to a reader who
 * is looking at this exact screen.
 */
function runDetailRosterUpdated() {
  if (!asked || !record) return;
  const model = runDetailModel();
  const view = model && model.describeRun(record, { now: runDetailClock() });
  if (!view || !view.state.stoppable) return;
  if (typeof ws !== 'undefined' && ws) {
    ws.send(JSON.stringify({ type: 'get_run', agentId: asked.agentId, routine: asked.routine }));
  }
}

/** Back to the list this was opened from. */
function runDetailBack() {
  if (typeof switchNav === 'function') switchNav('routines');
}

return {
  renderRunDetail, openRunDetail, runArrived, runDetailBack,
  runDetailStop, stopRequestArrived, runDetailRosterUpdated,
  runDetailOpenFile, runDetailTreeUpdated,
};
}));
