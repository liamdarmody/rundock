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

function skillsModel() {
  return typeof RundockSkillsModel !== 'undefined' ? RundockSkillsModel : null;
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

  let h = `<div class="profile-header">
      <div class="profile-avatar skill-avatar">${BOLT_SVG}</div>
      <div>
        <div class="profile-name">${esc(model.TITLE)}</div>
        ${state.lead ? `<div class="skills-empty-state">${esc(state.lead)}</div>` : ''}
      </div>
    </div>
    <div class="settings-card flow skills-empty-card">
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
    <div class="skill-sidebar-item${s.id === currentSkillId ? ' active' : ''}" data-skill="${s.id}" onclick="selectSkill('${s.id}')">
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
      h += `<div class="agent-chip" title="View ${esc(a.name)}'s profile" onclick="switchNav('team');showProfile('${esc(a.id)}')">
        <div class="avatar sm" style="background:${a.colour}">${a.icon}</div>
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
        ${guide ? `<span style="font-size:var(--caption);font-weight:500;color:var(--accent);cursor:pointer" onclick="startConversation('${guide.id}')" title="Open a conversation with Doc">Talk to Doc</span>.` : ''}
      </div>
    </div></div>`;
  }

  // Collapsible instructions card
  if (s.instructions) {
    const instructionsId = `skill-instructions-${s.id}`;
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

return { renderSkills, renderSkillsEmpty, renderSkillsSidebar, selectSkill };
}));
