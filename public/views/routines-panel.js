'use strict';
// The routines sidebar panel. Draws the scope list, holds which scope the
// reader is on, and hands that scope to the two things that need it: the list
// beside it, and the plus above it.
//
// WHY THE SCOPE LIVES HERE AND NOWHERE ELSE. It is one value with two readers,
// and a value with two readers and two homes is a value that disagrees with
// itself the first time one of them is redrawn on its own. The list asks for
// it through routinesScopeAgentId() rather than keeping a copy.
//
// AND IT IS RESOLVED ON EVERY READ rather than kept and corrected. The roster
// arrives from the server whenever anything changes, and the change may be the
// deletion of the last routine of the agent the reader is scoped to. Resolving
// on read means the panel and the list cannot be drawn from a selection that
// no longer exists, whichever of them is drawn first, and there is no ordering
// between them that has to be remembered.
//
// The same UMD pattern as the other view modules: node-requireable,
// window-attached, and republished on the root because the generated onclick
// handlers reach these by name.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockRoutinesPanel = factory();
    Object.assign(root, root.RundockRoutinesPanel);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// Attribute-position escaper and the colour rule, reached off the global at
// call time. `esc` leaves both quote characters alone, so it cannot hold an
// attribute closed against a filename someone else chose.
function escA(value) {
  if (typeof escAttr === 'function') return escAttr(value);
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function agentColour(value, fallback) {
  const safe = fallback === undefined ? 'var(--accent)' : fallback;
  return typeof RundockAgentColour !== 'undefined'
    ? RundockAgentColour.safeColour(value, safe) : safe;
}

// Which agent's routines the reader has scoped to, or null for all of them.
// Null rather than the model's 'all' so the list's filter is a plain falsy
// check and there is one value meaning "everything" rather than two.
let scope = null;

function scopeModel() {
  return typeof RundockRoutinesScopeModel !== 'undefined' ? RundockRoutinesScopeModel : null;
}

function roster() {
  return typeof agents !== 'undefined' && agents ? agents : [];
}

/**
 * The scope, resolved against the roster as it stands now.
 *
 * Every reader goes through here, including this file, so a scope whose agent
 * has stopped owning routines is corrected once and read as All by everything
 * that asks afterwards.
 */
function routinesScopeAgentId() {
  const m = scopeModel();
  if (!m) return null;
  scope = m.resolveScope({ agents: roster(), scope });
  return scope;
}

/**
 * Forget the scope.
 *
 * CALLED BY THE RAIL, AND THAT IS THE WHOLE RULE. A filter that survives a
 * visit is a filter that hides a failed overnight run from the person who
 * opened the view to look for one. Arriving at this surface therefore always
 * arrives on All, and the only thing that may ever carry an agent in is a link
 * that says so in its own label.
 */
function routinesPanelReset() {
  scope = null;
}

/**
 * The reader pressed a scope.
 *
 * BOTH SURFACES ARE REDRAWN, and the list is the one that matters. This panel
 * is the only place in the app that can change which routines are listed
 * without changing which routines exist, so a scope that repainted itself and
 * left the list alone would leave the reader looking at somebody else's
 * routines under a heading naming their own.
 */
function setRoutinesScope(agentId) {
  const m = scopeModel();
  scope = agentId && agentId !== (m ? m.ALL : 'all') ? agentId : null;
  renderRoutinesPanel();
  renderRoutines();
}

// The pinned row's glyph: the rail's own clock, so the row that means "this
// whole surface" carries the mark of the surface.
const ALL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"'
  + ' stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/>'
  + '<polyline points="12 7 12 12 15.5 14"/></svg>';

const PLUS_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor"'
  + ' stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">'
  + '<path d="M12 5v14"/><path d="M5 12h14"/></svg>';

/**
 * One scope row.
 *
 * DELIBERATELY NOT `.agent-status-item`. The complaint this whole panel
 * answers is that the routines sidebar and the team sidebar looked the same,
 * and reusing the roster's row would answer that in the code and not on the
 * screen. A scope row carries a count where a roster row carries a status, and
 * takes the selected fill where a roster row takes the hover fill: two
 * differences, both visible before you read the header.
 *
 * The handler travels by AGENT ID, and the claim that used to sit here was
 * that an agent id is "a slug the workspace generates rather than
 * user-written prose, so it is safe in an attribute in a way a routine name
 * is not". That is false. An agent id is the agent file's own FILENAME with
 * .md removed, straight off disk in lib/agents/discovery.js, so it is chosen
 * by anything that can create a file in .claude/agents, which includes an
 * agent writing a RUNDOCK:SAVE_AGENT block. The id now travels as data and
 * the handler reads it back, which is the shape that does not care.
 */
function scopeRowHtml(row, mark) {
  // A REAL BUTTON, not a div wearing role="button". The div answered clicks
  // and nothing else: Enter and Space did nothing, which is a control a
  // keyboard user can reach and cannot press. A button element brings both
  // keys, the role, and the tab stop for free, so the role and tabindex
  // attributes leave with the div rather than being carried as costume.
  return `<button type="button" class="scope-item${row.active ? ' active' : ''}" data-scope="${escA(row.id)}"`
    + ` onclick="setRoutinesScope(this.dataset.scope)">`
    + mark
    + `<span class="scope-name">${esc(row.name)}</span>`
    + `<span class="scope-count">${row.count}</span></button>`;
}

function panelHtml() {
  const m = scopeModel();
  const list = m.scopeList({ agents: roster(), scope: routinesScopeAgentId() });

  let h = '<div class="sidebar-header"><span class="sidebar-label">'
    + `${esc(m.COPY.label)}</span>`
    // The Files control, matched rather than resembled. The one this replaces
    // was a floated link inside a section divider, a pattern that existed
    // nowhere else in the app.
    + `<button class="files-add-btn" id="routines-add-btn" type="button" title="${esc(m.COPY.add)}"`
    + ` aria-label="${esc(m.COPY.add)}" onclick="routinesPanelAdd()">${PLUS_ICON}</button></div>`;

  h += '<div class="routines-scope-list">';
  h += scopeRowHtml(list.all, `<div class="scope-all-icon">${ALL_ICON}</div>`);
  if (list.owners.length) h += '<div class="scope-divider"></div>';
  for (const row of list.owners) {
    h += scopeRowHtml(row,
      `<div class="avatar sm" style="background:${agentColour(row.colour, 'var(--idle)')}">${esc(row.icon)}</div>`);
  }
  h += '</div>';

  // Said only where there is an absence to explain. Two owners and up, the
  // list explains itself.
  if (list.quiet) h += `<p class="sidebar-quiet">${esc(list.quiet)}</p>`;
  return h;
}

function renderRoutinesPanel() {
  const panel = document.getElementById('sidebar-routines');
  if (!panel || !scopeModel()) return;
  panel.innerHTML = panelHtml();
}

/**
 * The header plus, which inherits the scope.
 *
 * ON ALL it opens the agent-agnostic picker, spanning every agent's skills and
 * naming which agent runs each. SCOPED TO AN AGENT it opens that agent's
 * picker. That is load-bearing rather than a nicety: the agent profile no
 * longer offers Add routine once that agent has one, so "I am looking at
 * Piper's routines and want her to do one more thing" survives here or it
 * survives nowhere.
 */
function routinesPanelAdd() {
  if (typeof addRoutineForAgent !== 'function') return;
  addRoutineForAgent(routinesScopeAgentId());
}

return {
  renderRoutinesPanel, routinesPanelAdd, routinesPanelReset,
  routinesScopeAgentId, setRoutinesScope,
};
}));
