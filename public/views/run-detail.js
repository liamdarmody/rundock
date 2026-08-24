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

// What the reader asked to see, and what came back.
//
// `record` is deliberately three-valued. `undefined` is "the answer has not
// arrived", `null` is "there is no record", and an object is a record. Two of
// those are not the same screen and neither of them is a run that changed
// nothing, which is why this is not a truthiness check anywhere below.
let asked = null;
let record;

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

const FILE_ICON = '<svg class="rd-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor"'
  + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
  + '<polyline points="14 2 14 8 20 8"/></svg>';

// WHY THE FILE NAMES ARE NOT LINKS, said on the page rather than in a comment.
//
// The card allows either: names that open, or a plain statement that this
// release cannot and why. This is the statement. The reason is real: a record
// names each file by its whole path on the machine that ran the routine, the
// editor addresses files by where they sit inside the workspace open now, and
// those are not the same thing for a run that happened in another workspace or
// on another computer. A name that looks like a link and opens nothing is
// worse than a name that does not, so there is no anchor here at all.
const CANNOT_OPEN = 'These can\'t be opened from here yet. A run records each file as a full path '
  + 'on the computer that ran it, which is not always somewhere this workspace can reach.';

const WAITING = 'Reading this run\'s record.';

const BACK = '← Back to Routines';

/** The agent that owns this run, from the roster, or nothing. */
function agentOf(id) {
  if (typeof agents === 'undefined' || !agents) return null;
  return agents.find(a => a && a.id === id) || null;
}

function headHtml(title, agent) {
  const avatar = agent
    ? `<div class="avatar sm" style="background:${escText(agent.colour || 'var(--idle)')}">${escText(agent.icon || '')}</div>`
    : '';
  const who = agent ? (agent.displayName || agent.name || agent.id) : null;
  return '<button class="profile-back rd-back" type="button" data-run-detail="back"'
    + ` onclick="runDetailBack()">${escText(BACK)}</button>`
    + `<div class="rd-title">${avatar}<div class="settings-section-title rd-name">${escText(title)}</div></div>`
    + (who ? `<p class="settings-caption rd-context">${escText(who)}</p>` : '');
}

function filesHtml(files) {
  // THREE ANSWERS, AND THE UNKNOWN ONE CARRIES NO LIST TO RENDER. The model's
  // unknown shape has no `entries` key at all, so there is nothing here that
  // could iterate an empty array and draw a confident, wrong answer.
  if (!files.known) {
    return `<div class="rd-files-label">${escText('What it changed')}</div>`
      + '<div class="rd-unknown" data-run-detail="files-unknown">'
      + `<p class="rd-unknown-lead">${escText(files.lead)}</p>`
      + `<p class="rd-unknown-why">${escText(files.reason)}</p></div>`;
  }
  if (files.empty) {
    return `<div class="rd-files-label">${escText(files.label)}</div>`
      + `<p class="rd-empty" data-run-detail="files-empty">${escText(files.empty)}</p>`;
  }
  const rows = files.entries.map(entry => '<div class="rd-file" data-run-detail="file">'
    + FILE_ICON
    + '<div class="rd-file-body">'
    + `<span class="rd-file-name" data-run-detail="file-name">${escText(entry.name)}</span>`
    + `<span class="rd-file-path">${escText(entry.path)}</span></div>`
    + `<span class="rd-tag" data-run-detail="change">${escText(entry.changeLabel)}</span></div>`).join('');
  return `<div class="rd-files-label">${escText(files.label)}</div>`
    + `<div class="rd-files" data-run-detail="files">${rows}</div>`
    + `<p class="settings-caption rd-cannot-open">${escText(CANNOT_OPEN)}</p>`;
}

function detailHtml(view, title, agent) {
  const meta = view.duration ? `<p class="settings-caption rd-took">${escText(`Took ${view.duration}.`)}</p>` : '';
  return headHtml(title, agent)
    + '<div class="settings-card rd-card">'
    + `<div class="settings-row"><span class="rd-chip ${escText(view.state.tone)}" data-run-detail="chip">`
    + `<span class="rd-dot"></span>${escText(view.state.chip)}</span></div>`
    + `<p class="rd-headline" data-run-detail="headline">${escText(view.state.headline)}</p>`
    + (view.state.guidance
      ? `<p class="rd-guidance" data-run-detail="guidance">${escText(view.state.guidance)}</p>`
      : '')
    + meta
    + '</div>'
    + filesHtml(view.files);
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
  // The routine's name comes from the record when there is one and from what
  // was asked for when there is not, so a screen with no record still names
  // what the reader was looking at.
  content.innerHTML = detailHtml(view, view.routine || asked.routine, agent);
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
  if (typeof setNavState === 'function') setNavState('routines');
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
  renderRunDetail();
}

/** Back to the list this was opened from. */
function runDetailBack() {
  if (typeof switchNav === 'function') switchNav('routines');
}

return { renderRunDetail, openRunDetail, runArrived, runDetailBack };
}));
