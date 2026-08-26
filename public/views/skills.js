'use strict';
// Skills view: sidebar list + detail panel. Extracted verbatim from app.js
// (section 13) as the first Foundations view module. Same UMD pattern as
// markers.js (node-requireable, window-attached); additionally republishes
// each view function on the root object, because classic-script function
// declarations were window properties and the callers rely on that: the
// generated onclick handlers (selectSkill), the WS dispatch (renderSkills),
// routing, the palette, and agent profiles (selectSkill).
//
// Shared state stays in app.js and is reached through the global lexical
// environment at call time: skills, currentView, currentSkillId (read by
// routing in switchNav, reset by onWorkspaceReady, so it is shared state,
// not view-local), plus the helpers esc, showView and getGuide. Load order
// (views before app.js) is safe because nothing here touches shared state
// until the app boots. Function bodies are byte-identical to the app.js
// originals at column 0.
(/** @param {any} root @param {() => object} factory */ function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.RundockSkillsView = factory();
    Object.assign(root, root.RundockSkillsView);
  }
}(typeof self !== 'undefined' ? self : this, function () {

// ATTRIBUTE-POSITION ESCAPER and the colour rule, reached off the global at
// call time. A skill id is the skill's DIRECTORY NAME and an agent id is the
// agent file's filename, so both are chosen by anything that can create a
// file in the workspace, and both were reaching an inline handler. `esc`
// leaves quotes alone and is right only for element content; see
// public/agent-colour.js for why a colour is judged rather than escaped.
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

function skillsModel() {
  return typeof RundockSkillsModel !== 'undefined' ? RundockSkillsModel : null;
}

function routineEditorModel() {
  return typeof RundockRoutineEditorModel !== 'undefined' ? RundockRoutineEditorModel : null;
}

// Whether the skill list has arrived. NOT the same as it being empty, and the
// two are indistinguishable from the array alone: an empty list before the
// reply lands looks exactly like a workspace with nothing in it. The routine
// editor carries the same guard for the same reason, and the two must not
// disagree. Undeclared identifiers are safe under typeof, so this works when
// the module is required in node with no shell around it.
function skillsHaveArrived() {
  return typeof skillsLoaded === 'undefined' || skillsLoaded;
}

function renderSkills() {
  // NOTHING HERE TOUCHES THE RAIL, and that is the rule rather than an
  // omission. The Skills entry is permanent, like every other one: the rail is
  // a map of places, always the same size, so a user learns it once. This
  // function used to withdraw the entry whenever the list was empty, which was
  // never a decision about what a rail entry means. It was a workaround for
  // this pane not existing.
  renderSkillsSidebar(skills);

  // A section with nothing in it says what it is for. Skills had no such pane
  // at all: this function used to return here, which is why the rail entry was
  // withdrawn rather than the other way round.
  if (!skillsHaveArrived() || !skills.length) {
    renderSkillsEmpty(!skillsHaveArrived());
    return;
  }

  // Only refresh the detail panel if the user is already on the skills view.
  // Without this guard, background saves (SAVE_SKILL markers) would yank
  // the user out of the conversation and into the skills detail page.
  if (currentView === 'skills') {
    if (currentSkillId && skills.find(s => s.id === currentSkillId)) {
      selectSkill(currentSkillId);
    } else if (skills.length) {
      selectSkill(skills[0].id);
    }
  }
}

/**
 * Draw the pane if nothing has drawn it yet, and otherwise leave it alone.
 *
 * WHAT THE OPENER OWES THE READER, AND WHAT IT MUST NOT TAKE. A permanent rail
 * entry can be pressed onto a section nothing has drawn, so the opener has to
 * draw. It must not REDRAW: a detail pane that is already on screen belongs to
 * the reader, who may have scrolled it or opened the instructions card on it,
 * and rebuilding it on a press that used to cost nothing takes both away.
 *
 * Those two are one line apart, which is why the question is asked of the PAGE
 * rather than of the state. Whether a pane holds anything is a fact about the
 * pane; deriving it from skills, currentSkillId and currentView would be three
 * facts that have to agree, and they are exactly the three that did not.
 *
 * @returns {boolean} whether this drew
 */
function renderSkillsIfEmpty() {
  const detail = document.getElementById('skill-detail-content');
  if (detail && detail.firstElementChild) return false;
  renderSkills();
  return true;
}

// The glyph the Skills surface is known by. The same bolt selectSkill draws,
// in the same box, so an empty pane and a full one are recognisably the same
// place.
const BOLT_SVG = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" stroke="none">'
  + '<path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

/**
 * The pane a workspace with no skills opens onto.
 *
 * The action is omitted along with the sentence naming the guide when there is
 * no guide on the team, which is how every other call to action in this app
 * that names Doc is already guarded. The state and the mechanism stay, because
 * they are still true.
 */
function renderSkillsEmpty(loading) {
  const detail = document.getElementById('skill-detail-content');
  if (!detail) return;
  const model = skillsModel();
  // The guide's NAME, not merely whether one exists. getGuide matches on type
  // and checks no name, so a sentence built from a literal would name an agent
  // this workspace may not have. The roster always resolves a display name, and
  // the fallback is there so a nameless one takes the agent-independent next
  // step rather than a sentence with a hole in it.
  const guide = typeof getGuide === 'function' ? getGuide() : null;
  const state = model.emptyState({
    loading: !!loading,
    guideName: guide ? (guide.displayName || guide.name || null) : null,
  });

  // THE STATE LINE IS IN THE BOX, WITH THE ACTION IT BELONGS BESIDE, THE SAME
  // FIX THE ROUTINES PANE MADE TO THE SAME PATTERN. It used to be the
  // header's subtitle, so the pane read as a sentence above a card rather
  // than as one thing.
  let h = `<div class="profile-header">
      <div class="profile-avatar skill-avatar">${BOLT_SVG}</div>
      <div>
        <div class="profile-name">${esc(model.TITLE)}</div>
      </div>
    </div>
    <div class="settings-card flow skills-empty-card">
      ${state.lead ? `<p class="skills-empty-state">${esc(state.lead)}</p>` : ''}
      <p class="settings-lead">${esc(state.body)}</p>`;
  if (state.action) {
    // Skills are built by talking to the agent that builds them; this screen
    // never writes one itself. The same handler the routine editor's own
    // zero-skills offer uses, so the two ways into that conversation cannot
    // drift apart.
    h += '<div class="card-actions skills-empty-actions">'
      + '<button class="settings-btn-primary" type="button" data-skills-action="build-skill"'
      + ` onclick="routineEditorBuildSkill()">${esc(state.action)}</button></div>`;
  }
  h += '</div>';
  detail.innerHTML = h;
  detail.scrollTop = 0;
}

function renderSkillsSidebar(list) {
  const sidebar = document.getElementById('skills-sidebar-list');
  sidebar.innerHTML = list.map(s => `
    <div class="skill-sidebar-item${s.id === currentSkillId ? ' active' : ''}" data-skill="${escA(s.id)}" onclick="selectSkill(this.dataset.skill)">
      <span class="skill-sidebar-name">${esc(s.name)}</span>
    </div>
  `).join('');
}

function selectSkill(id) {
  const s = skills.find(x => x.id === id);
  if (!s) return;

  currentSkillId = id;
  showView('skills');

  // Sidebar highlight
  document.querySelectorAll('.skill-sidebar-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.skill-sidebar-item[data-skill="${id}"]`)?.classList.add('active');

  // Build detail HTML using profile-* classes (matches agent profile pattern)
  const boltSvg = '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" stroke="none"><path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"/></svg>';

  let h = `
    <div class="profile-header">
      <div class="profile-avatar skill-avatar">${boltSvg}</div>
      <div>
        <div class="profile-name">${esc(s.name)}</div>
        <div style="font-size:var(--body);color:var(--text-2)">Skill</div>
      </div>
    </div>`;

  if (s.description) {
    h += `<p class="profile-desc" style="margin-bottom:24px">${esc(s.description)}</p>`;
  }

  // Used by card
  if (s.assignedAgents.length) {
    h += `<div class="profile-card"><div class="profile-card-section">
      <div class="profile-section-label">Used by</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;padding-top:4px">`;
    for (const a of s.assignedAgents) {
      h += `<div class="agent-chip" title="View ${escA(a.name)}'s profile" data-agent-id="${escA(a.id)}" onclick="switchNav('team');showProfile(this.dataset.agentId)">
        <div class="avatar sm" style="background:${agentColour(a.colour)}">${esc(a.icon)}</div>
        <div>
          <div class="agent-chip-name">${esc(a.name)}</div>
          <div class="agent-chip-role">${esc(a.role || '')}</div>
        </div>
      </div>`;
    }
    h += `</div></div></div>`;
  } else {
    const guide = getGuide();
    h += `<div class="profile-card"><div class="profile-card-section">
      <div class="profile-section-label">Used by</div>
      <div class="profile-card-text" style="padding-top:4px">Available to all agents</div>
      <div style="margin-top:8px;font-size:var(--caption);color:var(--text-2);line-height:1.5">
        Want to assign this to a specific agent?
        ${guide ? `<span style="font-size:var(--caption);font-weight:500;color:var(--accent);cursor:pointer" data-agent-id="${escA(guide.id)}" onclick="startConversation(this.dataset.agentId)" title="Open a conversation with Doc">Talk to Doc</span>.` : ''}
      </div>
    </div></div>`;
  }

  // Schedule this skill, from the skill's own page.
  //
  // SECONDARY WEIGHT, DELIBERATELY. The primary way to make a routine is the
  // routines surface, which is where somebody who has decided to schedule
  // something goes. This is the other order: looking at a skill you already
  // trust and thinking of the schedule second. A shortcut for a reader who is
  // already here, not a competing front door.
  //
  // ONLY WHERE AN AGENT HAS THE SKILL, and the unassigned case is not the same
  // as the shared one. A routine runs a skill AS an agent, and the picker is
  // built by walking each skill's assigned agents, so a skill nobody has
  // produces no row and can never appear in it. Offering the control anyway
  // meant a reader pressing "Schedule this skill" landed either on an offer to
  // build a skill, while looking at one, or on a list of every other skill
  // with the one they pressed missing. A control that does not lead where its
  // label says teaches a wrong model of the app, which is worse than no
  // control: the reader believes the label.
  //
  // The card above already carries the step this reader actually needs, which
  // is to give the skill an agent, so nothing is lost by leaving the control
  // out.
  //
  // BUT THE SECTION ITSELF STAYS, AND NOW SAYS WHY. Silence here used to be
  // deliberate, on the reasoning that a reader meets the same gap from the
  // other side, in the "Used by" card above, so a second answer here risks
  // the two disagreeing. That reasoning misses the opposite failure: a
  // reader looking specifically for Schedule, on a page that lists Used by,
  // Schedule and Instructions, meets it simply missing, with nothing under
  // that heading to say why. `UNASSIGNED_REASON` is the one sentence both
  // surfaces use for this, verbatim, so adding it here cannot make this page
  // say something the routines view's own empty state does not.
  //
  // NOT GUARDED ON THE MODEL BEING LOADED, the same way `renderSkillsEmpty`
  // above reads `skillsModel()` unguarded: index.html loads
  // routine-editor-model.js long before views/skills.js, so its absence here
  // would mean the page itself failed to load rather than a state this
  // function should quietly work around. A guard that swallowed that would
  // reproduce, for a different cause, the exact silence this card exists to
  // remove.
  if (s.assignedAgents.length) {
    // SAME SHAPE AS THE AGENT PROFILE'S ROUTINES CARD: a prompt to schedule
    // while nothing is, replaced by the routine itself once one exists,
    // rather than the button staying up beside a routine it duplicates.
    // A skill can be scheduled by more than one of its assigned agents, so
    // this looks across all of them rather than just the first.
    const roster = typeof agents !== 'undefined' && agents ? agents : [];
    const routinesModel = typeof RundockRoutinesModel !== 'undefined' ? RundockRoutinesModel : null;
    const scheduled = [];
    for (const assigned of s.assignedAgents) {
      const agent = roster.filter(ag => ag && ag.id === assigned.id)[0];
      if (!agent || !agent.routines) continue;
      for (const r of agent.routines) {
        if (r.skill === s.id) scheduled.push({ agentId: agent.id, routine: r });
      }
    }
    h += `<div class="profile-card"><div class="profile-card-section"><div class="profile-section-label">Schedule</div>`;
    if (scheduled.length) {
      for (const { agentId, routine: r } of scheduled) {
        const when = (routinesModel && routinesModel.scheduleWords(r.schedule)) || r.schedule;
        h += `<div class="profile-card-item" style="display:flex;flex-direction:column;gap:3px;cursor:pointer" data-agent-id="${escA(agentId)}" onclick="showRoutinesForAgent(this.dataset.agentId)">
          <span style="font-weight:600">${esc(r.name)}</span>
          <span style="font-size:var(--caption);color:var(--text-2)">${esc(when)}</span>
        </div>`;
      }
    } else {
      h += `<div class="profile-card-text" style="padding-bottom:10px">Give this skill a schedule and your agents take it from there.</div>
      <button class="settings-btn" type="button" data-skills-action="schedule-skill"
        data-skill-id="${escA(s.id)}" onclick="addRoutineForSkill(this.dataset.skillId)">Schedule this skill</button>`;
    }
    h += `</div></div>`;
  } else {
    h += `<div class="profile-card"><div class="profile-card-section">
      <div class="profile-section-label">Schedule</div>
      <div class="profile-card-text">${esc(routineEditorModel().UNASSIGNED_REASON)}</div>
    </div></div>`;
  }

  // Collapsible instructions card
  if (s.instructions) {
    // A CONSTANT ID, not one built from the skill's directory name. The name
    // was written into the id attribute AND into the getElementById call in
    // the handler beside it, so a directory called `a').remove();//` was a
    // string literal in a JavaScript position. Only one skill detail is
    // rendered at a time, so the id never needed to be unique per skill.
    const instructionsId = 'skill-instructions';
    h += `<div class="profile-card" style="cursor:pointer" onclick="document.getElementById('${instructionsId}').classList.toggle('hidden')">
      <div class="profile-card-section">
        <div class="profile-section-label">Instructions &#9662;</div>
        <div id="${instructionsId}" class="hidden">
          <div style="font-size:var(--caption);line-height:1.6;white-space:pre-wrap;color:var(--text-2);padding-top:8px">${esc(s.instructions)}</div>
        </div>
      </div>
    </div>`;
  }

  const detail = document.getElementById('skill-detail-content');
  detail.innerHTML = h;
  detail.scrollTop = 0;
}

return { renderSkills, renderSkillsEmpty, renderSkillsIfEmpty, renderSkillsSidebar, selectSkill };
}));
